/**
 * P9 · 渲染的单测（spec Phase 9 测试要点 1 / 2 / 4 / 5 / 6 / 8）。
 *
 * 【为什么值得单独一个文件】排版是"地图能不能被模型用"这件事的全部可见部分：预算超了会挤掉历史，
 * 截了半行会让模型读到一个不存在的签名，排序不稳会让缓存前缀每轮失效。这三件事都能用
 * 字符串断言钉死，不需要建索引、不需要起库。
 *
 * 【它不替代什么】排名的来源（PageRank / 个性化）在 `repo-map-rank.test.ts`；
 * "什么时候降级、缓存命中读了几次库"在 `repo-map-build.test.ts`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BUDGET_TOKENS,
  MAX_BUDGET_TOKENS,
  clampBudgetTokens,
  estimateTokens,
  renderFileTree,
  renderRepoMap,
  withChangedFiles,
} from "../../src/index/render.ts";
import type { RepoMapFileBlock, RepoMapSymbol } from "../../src/index/render.ts";
import { rankedFiles, pageRank } from "../../src/index/rank.ts";

function symbol(name: string, startLine = 1, signature = `export function ${name}(value: string): string`): RepoMapSymbol {
  return { name, kind: "function", signature, startLine };
}

function block(path: string, symbols: RepoMapSymbol[]): RepoMapFileBlock {
  return { path, symbols };
}

/** 文本里的每一行都必须是"整行"：文件头、缩进签名、省略标记、块之间的空行（没有半行）。 */
function assertWholeLines(text: string, allowed: ReadonlySet<string>): void {
  for (const line of text.split("\n")) {
    if (line === "" || line.endsWith(":") || line === "  …") continue;
    assert.ok(allowed.has(line), `出现了半行或不该有的行：${JSON.stringify(line)}`);
  }
}

// ---------------------------------------------------------------- 地图

test("1. 确定性：同一份输入渲染两次逐字节相同；格式是「路径 + 缩进签名 + 空行」", () => {
  const blocks = [
    block("src/billing/refund.ts", [symbol("refundInvoice", 12, "export function refundInvoice(orderId: string): Refund")]),
    block("src/api/routes.ts", []),
  ];
  const first = renderRepoMap({ blocks });
  const second = renderRepoMap({ blocks });
  assert.equal(first.text, second.text);
  assert.equal(first.tokens, second.tokens);
  assert.equal(second.tokens, estimateTokens(second.text));

  assert.equal(
    first.text,
    [
      "src/billing/refund.ts:",
      "  export function refundInvoice(orderId: string): Refund",
      "",
      "src/api/routes.ts:",
    ].join("\n"),
  );
  assert.equal(first.files, 2, "只有路径没有符号的文件也占一行（它存在这件事本身就是信息）");
  assert.equal(first.truncated, false);
  assert.equal(first.omittedFiles, 0);
});

test("4. 空仓库 / 单文件仓库都不崩，输出合理", () => {
  const empty = renderRepoMap({ blocks: [] });
  assert.deepEqual(empty, { text: "", tokens: 0, files: 0, omittedFiles: 0, truncated: false });

  const single = renderRepoMap({ blocks: [block("main.ts", [symbol("main", 1, "function main(): void")])] });
  assert.equal(single.text, "main.ts:\n  function main(): void");
  assert.equal(single.truncated, false);
});

test("3. 每个文件最多 8 条签名，被切的那个文件末尾补「…」", () => {
  const symbols = Array.from({ length: 12 }, (_, index) => symbol(`fn${index}`, index + 1));
  const rendered = renderRepoMap({ blocks: [block("src/big.ts", symbols)] });
  const lines = rendered.text.split("\n");
  assert.equal(lines.length, 10, "1 行文件头 + 8 行签名 + 1 行省略标记");
  assert.equal(lines[0], "src/big.ts:");
  assert.equal(lines[9], "  …");
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.files, 1);
  assert.equal(rendered.omittedFiles, 0, "文件本身进去了，被切的是它的签名");
});

test("2. 预算：大仓库被截断到预算内，不截半行，末尾没有残缺", () => {
  const symbols = Array.from({ length: 40 }, (_, index) =>
    symbol(`fn${String(index).padStart(2, "0")}`, index + 1, `export function fn${index}(value: string): Promise<string>`),
  );
  const blocks = Array.from({ length: 60 }, (_, index) => block(`src/mod${String(index).padStart(2, "0")}/file.ts`, symbols));
  const budgetTokens = 200;
  const rendered = renderRepoMap({ blocks, budgetTokens });

  assert.ok(rendered.tokens <= budgetTokens, `${rendered.tokens} 超过了预算 ${budgetTokens}`);
  assert.equal(rendered.tokens, estimateTokens(rendered.text));
  assert.equal(rendered.truncated, true);
  assert.ok(rendered.omittedFiles > 0, "60 个文件不可能全进 200 token");
  assert.equal(rendered.files + rendered.omittedFiles, blocks.length);
  assertWholeLines(rendered.text, new Set(symbols.map((item) => `  ${item.signature}`)));
});

test("2. 预算：标记本身也要放得下（不够就先退掉最后一行签名）", () => {
  const blocks = [block("a.ts", [symbol("fnA", 1, "x".repeat(60)), symbol("fnB", 2, "y".repeat(60))])];
  // 头部 4 字符 + 换行 + 一行 62 字符 + 换行 + 一行 62 字符 = 131；预算 33 token = 132 字符。
  // 两行签名都进得去（131 ≤ 132），但再加省略标记就超了 —— 标记只有在真有截断时才该出现，
  // 这里两行都进去了，所以不该有标记。
  const tight = renderRepoMap({ blocks, budgetTokens: 33 });
  assert.equal(tight.text.includes("…"), false);
  assert.equal(tight.truncated, false);

  const tighter = renderRepoMap({ blocks, budgetTokens: 20 });
  assert.ok(tighter.tokens <= 20);
  assert.equal(tighter.text.includes("…"), true, "第二行签名进不去，就要留标记");
  assertWholeLines(tighter.text, new Set([`  ${"x".repeat(60)}`]));
});

test("5. Unicode 路径：中文 / emoji 文件名不破坏缩进与截断", () => {
  const blocks = [
    block("src/中文/退款.ts", [symbol("退款流程", 3, "export function 退款流程(orderId: string): Refund")]),
    block("src/🎉/party.ts", [symbol("party", 1, "export function party(): void")]),
  ];
  const rendered = renderRepoMap({ blocks, budgetTokens: DEFAULT_BUDGET_TOKENS });
  const lines = rendered.text.split("\n");
  assert.equal(lines[0], "src/中文/退款.ts:");
  assert.equal(lines[1], "  export function 退款流程(orderId: string): Refund");
  assert.equal(lines[3], "src/🎉/party.ts:");

  const tight = renderRepoMap({ blocks, budgetTokens: 20 });
  assert.ok(tight.tokens <= 20);
  assertWholeLines(tight.text, new Set(["  export function 退款流程(orderId: string): Refund", "  export function party(): void"]));
});

test("1. 渲染顺序就是入参顺序（排名由调用方决定，渲染不重排）", () => {
  const blocks = [block("z.ts", [symbol("z")]), block("a.ts", [symbol("a")])];
  assert.equal(renderRepoMap({ blocks }).text.split("\n")[0], "z.ts:");
});

test("预算归一化：缺省 1500、超过硬上限截到 3000、非数/非正退回缺省", () => {
  assert.equal(clampBudgetTokens(undefined), DEFAULT_BUDGET_TOKENS);
  assert.equal(clampBudgetTokens(0), DEFAULT_BUDGET_TOKENS);
  assert.equal(clampBudgetTokens(-5), DEFAULT_BUDGET_TOKENS);
  assert.equal(clampBudgetTokens(Number.NaN), DEFAULT_BUDGET_TOKENS);
  assert.equal(clampBudgetTokens(9999), MAX_BUDGET_TOKENS);
  assert.equal(clampBudgetTokens(1500.7), 1500);

  const blocks = [block("a.ts", [symbol("a")])];
  const huge = renderRepoMap({ blocks, budgetTokens: 9999 });
  assert.equal(huge.tokens < MAX_BUDGET_TOKENS * 4, true);
});

// ---------------------------------------------------------------- 改动标注

test("6. 已改动标注：去重 + 排序后附在末尾（正文不变）", () => {
  const body = "a.ts:\n  function a(): void";
  assert.equal(
    withChangedFiles(body, ["b.ts", "a.ts", "b.ts"]),
    `${body}\n\n# 本次 Run 已改动（仓库地图可能过期）：a.ts, b.ts`,
  );
  assert.equal(withChangedFiles(body, []), body, "没有改动就不加行");
  assert.equal(withChangedFiles(body, undefined), body);
  assert.equal(withChangedFiles("", ["a.ts"]), "# 本次 Run 已改动（仓库地图可能过期）：a.ts", "空正文时不留空行");
});

test("6. 已改动标注：超过 20 个只列前 20 个并给出总数", () => {
  const files = Array.from({ length: 25 }, (_, index) => `f${String(index).padStart(2, "0")}.ts`);
  const text = withChangedFiles("body", files);
  assert.equal(text.split("\n").at(-1), `# 本次 Run 已改动（仓库地图可能过期）：${files.slice(0, 20).join(", ")} 等 25 个文件`);
});

// ---------------------------------------------------------------- 文件树（降级）

test("8. 文件树：按目录大小排序（同大小按路径）、目录内按名字排序；首行说明这不是符号地图", () => {
  const rendered = renderFileTree({
    files: ["src/billing/refund.ts", "src/billing/ledger.ts", "src/api/routes.ts", "README.md", "package.json"],
  });
  assert.equal(
    rendered.text,
    [
      "# 仓库文件树（没有可用的符号索引：只有目录与文件名）",
      "",
      "./ (2)",
      "  README.md",
      "  package.json",
      "",
      "src/billing/ (2)",
      "  ledger.ts",
      "  refund.ts",
      "",
      "src/api/ (1)",
      "  routes.ts",
    ].join("\n"),
  );
  assert.equal(rendered.files, 5);
  assert.equal(rendered.truncated, false);
});

test("8. 文件树：预算内只装得下部分文件时标省略；目录整块放不下时只标 truncated", () => {
  const many = Array.from({ length: 400 }, (_, index) => `src/mod/file${String(index).padStart(3, "0")}.ts`);
  const rendered = renderFileTree({ files: many, budgetTokens: 40 });
  assert.ok(rendered.tokens <= 40);
  assert.equal(rendered.truncated, true);
  assert.ok(rendered.files > 0 && rendered.files < many.length);
  assert.ok(rendered.text.includes("…"), "同一个目录里的文件被切了，要留标记");
  assert.equal(rendered.omittedFiles, many.length - rendered.files);

  // 每个目录只有 1 个文件：整块进不去时没有"半个块"可标，标在返回值里就够（与地图里丢文件一致）。
  const dirs = Array.from({ length: 400 }, (_, index) => `src/mod${String(index).padStart(3, "0")}/file.ts`);
  const byDirs = renderFileTree({ files: dirs, budgetTokens: 40 });
  assert.ok(byDirs.tokens <= 40);
  assert.equal(byDirs.truncated, true);
  assert.ok(byDirs.files < dirs.length);

  const empty = renderFileTree({ files: [] });
  assert.equal(empty.text, "# 仓库文件树（没有可用的符号索引：只有目录与文件名）");
  assert.equal(empty.files, 0);

  // 预算小到连说明行都放不下时，什么都不给（预算的语义是硬上限，不因为"这几行很重要"就超）。
  const tiny = renderFileTree({ files: ["src/a.ts"], budgetTokens: 1 });
  assert.deepEqual(tiny, { text: "", tokens: 0, files: 0, omittedFiles: 1, truncated: true });
});

// ---------------------------------------------------------------- 与排名的接口

test("3. 排名给什么顺序，地图就按什么顺序出（同 rank 时路径升序）", () => {
  const ranks = new Map([
    ["src/billing/refund.ts", 0.5],
    ["src/core/store.ts", 0.3],
    ["src/api/routes.ts", 0.3],
  ]);
  assert.deepEqual(
    rankedFiles(ranks).map((file) => file.path),
    ["src/billing/refund.ts", "src/api/routes.ts", "src/core/store.ts"],
  );

  const blocks = rankedFiles(pageRank({ files: ["a.ts", "b.ts"], edges: [{ fromPath: "a.ts", toPath: "b.ts", weight: 1 }] }).ranks).map(
    (file) => block(file.path, []),
  );
  assert.equal(renderRepoMap({ blocks }).text.split("\n")[0], "b.ts:");
});
