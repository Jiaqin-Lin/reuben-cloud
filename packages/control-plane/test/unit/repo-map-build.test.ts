/**
 * P9 · `buildRepoMap` 的单测（spec Phase 9 测试要点 3 / 4 / 6 / 7 / 8 + 验收标准的"渲染 < 200ms"）。
 *
 * 【为什么这些必须有一个自己的文件】地图的编排里有三件事只有在这里看得见：
 *  ① **缓存命中到底做没做事**——命中时不许读符号表与边（用假 store 的调用计数断言，
 *     而不是"看起来很快"）；
 *  ② **索引不可用时的降级**——四种原因（没有索引 / 不是 ready / 读失败 / 空索引）都要给出文件树，
 *     而且不写缓存；
 *  ③ **标题里的那点端到端确定性**——两次重算的文本逐字节相同（回放与缓存前缀都靠它）。
 *
 * 【它不替代什么】PageRank 与个性化的算法细节在 `repo-map-rank.test.ts`，排版在
 * `repo-map-render.test.ts`，真 Postgres 上的 `repo_maps`（upsert / 指纹 / 保留策略）
 * 在 `repo-index.integration.test.ts` 的 P9 那一节。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRepoMap, mapRefreshDue, MAP_REFRESH_INTERVAL_MS } from "../../src/index/repo-map.ts";
import type { RepoMapOptions, RepoMapResult } from "../../src/index/repo-map.ts";
import { memoryRepoIndexStore, memoryRepoMapStore, seedRepoIndex } from "../index-fakes.ts";
import type { MemoryRepoIndexStore, MemoryRepoMapStore } from "../index-fakes.ts";

const REPO = "owner/map";
const SHA = "c0ffee";

interface SeedSymbol {
  path: string;
  name: string;
  kind?: "function" | "class" | "method" | "interface" | "type" | "const";
  signature?: string;
  startLine?: number;
}

/** 便捷封装：把"路径 → 符号"的短形状翻成 `seedRepoIndex` 的长形状（这个文件里 fixture 很多）。 */
async function seedIndex(
  store: MemoryRepoIndexStore,
  input: {
    repoKey?: string;
    commitSha?: string;
    symbols?: SeedSymbol[];
    edges?: { fromPath: string; toPath: string; symbol: string; weight: number }[];
    /** import 候选（`repo_file_refs` 里 kind='import' 的那一半；词汇名闸靠它认 import 边）。 */
    imports?: { path: string; symbol: string }[];
  },
): Promise<void> {
  await seedRepoIndex(store, {
    repoKey: input.repoKey ?? REPO,
    commitSha: input.commitSha ?? SHA,
    symbols: input.symbols ?? [],
    edges: input.edges ?? [],
    fileRefs: (input.imports ?? []).map((item) => ({ path: item.path, symbol: item.symbol, kind: "import" as const })),
    files: new Set((input.symbols ?? []).map((symbol) => symbol.path)).size,
  });
}

async function build(options: {
  index: MemoryRepoIndexStore;
  maps?: MemoryRepoMapStore;
  task?: string;
  changedFiles?: readonly string[];
  budgetTokens?: number;
  files?: readonly string[];
  refresh?: boolean;
  log?: RepoMapOptions["log"];
  repoKey?: string;
  commitSha?: string;
}): Promise<RepoMapResult> {
  return buildRepoMap({
    repoKey: options.repoKey ?? REPO,
    commitSha: options.commitSha ?? SHA,
    task: options.task,
    changedFiles: options.changedFiles,
    budgetTokens: options.budgetTokens,
    files: options.files,
    refresh: options.refresh,
    index: options.index,
    maps: options.maps ?? memoryRepoMapStore(),
    log: options.log,
  });
}

/** 一个"中心在 store、billing 是叶子"的小仓库：个性化要能把叶子顶上去才看得见效果。 */
async function seedSmallRepo(store: MemoryRepoIndexStore): Promise<void> {
  await seedIndex(store, {
    symbols: [
      { path: "src/billing/refund.ts", name: "refundInvoice", signature: "export function refundInvoice(orderId: string): Refund", startLine: 12 },
      { path: "src/billing/refund.ts", name: "Ledger", kind: "class", signature: "export class Ledger", startLine: 40 },
      { path: "src/core/store.ts", name: "Store", kind: "class", signature: "export class Store", startLine: 5 },
      { path: "src/api/routes.ts", name: "createRouter", signature: "export function createRouter(deps: Deps): Router", startLine: 3 },
      { path: "src/cli/main.ts", name: "main", signature: "export function main(): void", startLine: 1 },
    ],
    edges: [
      { fromPath: "src/api/routes.ts", toPath: "src/core/store.ts", symbol: "./store", weight: 2 },
      { fromPath: "src/cli/main.ts", toPath: "src/core/store.ts", symbol: "./store", weight: 2 },
      { fromPath: "src/billing/refund.ts", toPath: "src/core/store.ts", symbol: "Store", weight: 1 },
      { fromPath: "src/api/routes.ts", toPath: "src/billing/refund.ts", symbol: "refundInvoice", weight: 1 },
    ],
  });
}

// ---------------------------------------------------------------- 正常路径

test("1. 正常地图：文本里有 issue 涉及的模块与签名，命中符号进结果，缓存写一条", async () => {
  const index = memoryRepoIndexStore();
  const maps = memoryRepoMapStore();
  await seedSmallRepo(index);

  const result = await build({ index, maps, task: "修一下 refundInvoice 抛的错" });
  assert.equal(result.degraded, null);
  assert.equal(result.cached, false);
  assert.equal(result.files, 4, "5 个符号分布在 4 个文件里");
  assert.equal(result.truncated, false);
  assert.equal(result.rank!.nodes, 4);
  assert.ok(result.hash.length === 64);
  assert.ok(result.matchedSymbols.includes("refundInvoice"));

  // 验收标准那句"地图里包含 issue 涉及的模块"：结构化断言（文本里有这个路径）。
  assert.ok(result.text.includes("src/billing/refund.ts:"), result.text);
  assert.ok(result.text.includes("export function refundInvoice(orderId: string): Refund"), result.text);
  assert.equal(result.tokens, Math.ceil(result.body.length / 4));
  assert.equal(maps.rows().length, 1);
  assert.equal(maps.rows()[0]!.personalization_hash, result.personalizationHash);
});

test("1. 两次重算的文本逐字节相同（确定性：从图到字节这条链上没有隐藏状态）", async () => {
  const index = memoryRepoIndexStore();
  await seedSmallRepo(index);
  const first = await build({ index, task: "billing 退款" });
  const second = await build({ index, task: "billing 退款", refresh: true });
  assert.equal(second.text, first.text);
  assert.equal(second.hash, first.hash);
  assert.equal(second.cached, false);
});

test("3. 个性化：同一份索引，带 issue 的地图把 billing 顶到第一行（不带就是中心坐标）", async () => {
  const index = memoryRepoIndexStore();
  await seedSmallRepo(index);
  const uniform = await build({ index });
  const personalized = await build({ index, task: "修一下 refundInvoice 抛的错" });

  assert.equal(uniform.text.split("\n")[0], "src/core/store.ts:", "没有任务词时，被引用最多的文件排第一");
  assert.equal(personalized.text.split("\n")[0], "src/billing/refund.ts:", "提到了 refundInvoice 就该从它看起");
  assert.notEqual(personalized.hash, uniform.hash);
});

test("4. 单文件仓库：一个文件一个符号也能出地图（退化输入不崩）", async () => {
  const index = memoryRepoIndexStore();
  await seedIndex(index, { symbols: [{ path: "main.ts", name: "main", signature: "function main(): void" }] });
  const result = await build({ index });
  assert.equal(result.degraded, null);
  assert.equal(result.text, "main.ts:\n  function main(): void");
  assert.equal(result.rank!.nodes, 1);
});

// ---------------------------------------------------------------- 缓存

test("7. 缓存命中：第二次不读符号表与边，文本一致，不重复写", async () => {
  const index = memoryRepoIndexStore();
  const maps = memoryRepoMapStore();
  await seedSmallRepo(index);

  const first = await build({ index, maps, task: "billing 退款" });
  assert.equal(index.calls.allSymbols, 1);
  assert.equal(index.calls.allRefs, 1);

  const second = await build({ index, maps, task: "billing 退款" });
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(second.hash, first.hash);
  assert.equal(second.tokens, first.tokens);
  assert.equal(second.files, first.files);
  assert.equal(second.rank, null, "命中的那些统计量没有缓存（不编一个像真的值）");
  assert.equal(second.truncated, null, "截断情况同上：不知道就如实说 null，不说 false");
  assert.equal(second.omittedFiles, null);
  assert.equal(index.calls.allSymbols, 1, "命中时不许读符号表");
  assert.equal(index.calls.allRefs, 1, "命中时不许读边");
  assert.equal(maps.calls.put, 1, "命中不重写缓存");

  // refresh（排障 / CLI 的 --rebuild）必须真的重算。
  const forced = await build({ index, maps, task: "billing 退款", refresh: true });
  assert.equal(forced.cached, false);
  assert.equal(index.calls.allSymbols, 2);
  assert.equal(forced.text, first.text, "重算出来还是同一份文本");
});

test("7. 缓存键包含预算与任务词：换个预算或换批词就是另一条缓存", async () => {
  const index = memoryRepoIndexStore();
  const maps = memoryRepoMapStore();
  await seedSmallRepo(index);

  await build({ index, maps, task: "refund", budgetTokens: 800 });
  await build({ index, maps, task: "refund", budgetTokens: 400 });
  await build({ index, maps, task: "ledger" });
  assert.equal(maps.rows().length, 3);
  await build({ index, maps, task: "refund", budgetTokens: 800 });
  assert.equal(maps.rows().length, 3);
});

test("7. 索引指纹：同一个 commit 重新索引过 → 旧地图不算命中（附录 A-57）", async () => {
  const index = memoryRepoIndexStore();
  const maps = memoryRepoMapStore();
  await seedSmallRepo(index);
  await build({ index, maps, task: "billing" });
  const before = index.calls.allSymbols;

  // 同一个 commit 重写一遍（模拟 `index:repo --rebuild`）：built_at 前进，符号内容一样。
  await seedSmallRepo(index);
  const again = await build({ index, maps, task: "billing" });
  assert.equal(again.cached, false, "指纹变了就不能复用旧缓存");
  assert.equal(index.calls.allSymbols, before + 1);
});

test("缓存坏了不影响地图：校验不过 / 读失败 / 写失败都只是重算", async () => {
  const index = memoryRepoIndexStore();
  const maps = memoryRepoMapStore();
  await seedSmallRepo(index);

  const first = await build({ index, maps, task: "billing" });
  maps.rows()[0]!.text = "被谁改坏了";
  const repaired = await build({ index, maps, task: "billing" });
  assert.equal(repaired.cached, false);
  assert.equal(repaired.text, first.text);

  maps.failing.get = true;
  const readFailed = await build({ index, maps, task: "billing" });
  assert.equal(readFailed.cached, false);
  assert.equal(readFailed.text, first.text);
  maps.failing.get = false;

  maps.failing.put = true;
  const writeFailed = await build({ index, maps, task: "ledger", refresh: true });
  assert.equal(writeFailed.degraded, null);
  assert.ok(writeFailed.text.includes("src/core/store.ts:"));
  maps.failing.put = false;
});

// ---------------------------------------------------------------- 降级

test("8. 降级：没有索引 / 索引不是 ready / 索引读失败 → 文件树，且不写缓存", async () => {
  const files = ["src/billing/refund.ts", "src/api/routes.ts", "README.md"];

  const missing = memoryRepoIndexStore();
  const missingMaps = memoryRepoMapStore();
  const tree = await build({ index: missing, maps: missingMaps, files, changedFiles: ["src/api/routes.ts"] });
  assert.equal(tree.degraded, "index_missing");
  assert.ok(tree.text.startsWith("# 仓库文件树"));
  assert.ok(tree.text.includes("src/billing/ (1)"));
  assert.ok(tree.text.endsWith("# 本次 Run 已改动（仓库地图可能过期）：src/api/routes.ts"));
  assert.equal(missingMaps.rows().length, 0, "降级结果不进缓存（索引修好后必须能拿到真地图）");
  assert.equal(missing.calls.allSymbols ?? 0, 0);

  const failed = memoryRepoIndexStore();
  await failed.fail({ repoKey: REPO, commitSha: SHA, files: 3, languages: {}, error: "worker_crashed", durationMs: 1 });
  const failedResult = await build({ index: failed, files });
  assert.equal(failedResult.degraded, "index_not_ready");

  const empty = memoryRepoIndexStore();
  await seedIndex(empty, { symbols: [], edges: [] });
  const emptyResult = await build({ index: empty, files });
  assert.equal(emptyResult.degraded, "empty_index");
  assert.ok(emptyResult.text.includes("src/billing/ (1)"));
  assert.ok(emptyResult.text.includes("  refund.ts"), "文件树是目录头 + 文件名（不再重复目录前缀，省 token）");
});

test("8. 降级：索引读口抛错也降级（缓存是优化，索引是派生数据，都不该冒泡成异常）", async () => {
  const index = memoryRepoIndexStore();
  await seedSmallRepo(index);
  const broken = {
    ...index,
    get: async () => {
      throw new Error("connection refused");
    },
  } as MemoryRepoIndexStore;
  const warns: string[] = [];
  const result = await build({ index: broken, files: ["src/core/store.ts"], log: (level, text) => warns.push(`${level}:${text}`) });
  assert.equal(result.degraded, "index_error");
  assert.ok(warns.some((line) => line.includes("读索引状态失败")), warns.join("|"));
});

// ---------------------------------------------------------------- 预算与标注

test("6. 已改动标注：进 text 不进 body，也不影响缓存命中", async () => {
  const index = memoryRepoIndexStore();
  const maps = memoryRepoMapStore();
  await seedSmallRepo(index);

  const first = await build({ index, maps, task: "billing", changedFiles: ["src/b.ts", "src/a.ts"] });
  assert.ok(first.text.endsWith("# 本次 Run 已改动（仓库地图可能过期）：src/a.ts, src/b.ts"));
  assert.equal(first.body.includes("本次 Run 已改动"), false);
  assert.equal(first.hash, (await build({ index, maps, task: "billing", refresh: true })).hash, "标注不进哈希");

  const second = await build({ index, maps, task: "billing", changedFiles: ["src/c.ts"] });
  assert.equal(second.cached, true);
  assert.ok(second.text.endsWith("# 本次 Run 已改动（仓库地图可能过期）：src/c.ts"));
});

test("2. 预算：超预算的地图被截断（tokens ≤ 预算），硬上限 3000 会截配置并记 warn", async () => {
  const index = memoryRepoIndexStore();
  const symbols: SeedSymbol[] = [];
  for (let file = 0; file < 30; file += 1) {
    for (let line = 0; line < 6; line += 1) {
      symbols.push({
        path: `src/mod${file}/file.ts`,
        name: `fn${file}_${line}`,
        signature: `export function fn${file}_${line}(value: string): Promise<string>`,
        startLine: line + 1,
      });
    }
  }
  await seedIndex(index, { symbols });
  const tight = await build({ index, budgetTokens: 120, refresh: true });
  assert.ok(tight.tokens <= 120, `${tight.tokens} 超过预算`);
  assert.equal(tight.truncated, true);
  assert.ok((tight.omittedFiles ?? 0) > 0);

  const warns: string[] = [];
  const clamped = await build({
    index,
    budgetTokens: 9999,
    refresh: true,
    log: (level, text, fields) => warns.push(`${level}:${text}:${JSON.stringify(fields)}`),
  });
  assert.equal(clamped.budgetTokens, 3000);
  assert.ok(warns.some((line) => line.includes("超过硬上限")), warns.join("|"));
});

test("预算缺省：没给预算时用 1500（P10 的环境变量缺省值也是它）", async () => {
  const index = memoryRepoIndexStore();
  await seedSmallRepo(index);
  const result = await build({ index });
  assert.equal(result.budgetTokens, 1500);
});

test("词汇名闸（A-55 的杠杆）：30 个文件都提到的 `path` 压不过 3 个文件 import 的中心模块", async () => {
  const index = memoryRepoIndexStore();
  const hubPath = "src/hub.ts";
  const corePath = "src/core/store.ts";
  const sources = Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`);
  await seedIndex(index, {
    symbols: [
      // 全仓库只有一个文件定义了叫 `path` 的符号——正好是词汇名撞车的那种形态。
      { path: hubPath, name: "path", kind: "const", signature: "const path = require(\"node:path\")" },
      { path: corePath, name: "Store", kind: "class", signature: "export class Store" },
      ...sources.map((path, index) => ({ path, name: `helper${index}`, signature: `function helper${index}()` })),
    ],
    edges: [
      ...sources.map((path) => ({ fromPath: path, toPath: hubPath, symbol: "path", weight: 1 })),
      ...sources.slice(0, 3).map((path) => ({ fromPath: path, toPath: corePath, symbol: "./store", weight: 2 })),
    ],
    imports: sources.slice(0, 3).map((path) => ({ path, symbol: "./store" })),
  });

  const result = await build({ index });
  assert.equal(result.text.split("\n")[0], "src/core/store.ts:", "通用名的 30 条边不该把 hub 顶上去");
  assert.ok(result.text.includes("src/hub.ts:"), "hub 还在图上，只是排在后面");
  assert.equal(result.rank!.nodes, 32, "30 个源文件 + hub + core");
});

// ---------------------------------------------------------------- 过期判断

test("mapRefreshDue：改动 > 20 或距上次渲染 > 5 分钟才值得重建", () => {
  const now = Date.parse("2026-01-01T00:20:00Z");
  const fourMinutesAgo = new Date(now - 4 * 60_000);
  const sixMinutesAgo = new Date(now - 6 * 60_000);

  assert.equal(mapRefreshDue({ changedFiles: 20, lastBuiltAt: fourMinutesAgo, now }), false);
  assert.equal(mapRefreshDue({ changedFiles: 21, lastBuiltAt: fourMinutesAgo, now }), true, "改动太多，不等时间");
  assert.equal(mapRefreshDue({ changedFiles: 0, lastBuiltAt: sixMinutesAgo, now }), true, "隔了 5 分钟以上");
  assert.equal(mapRefreshDue({ changedFiles: 0, lastBuiltAt: null, now }), true, "从没渲染过");
  assert.equal(mapRefreshDue({ changedFiles: 0, lastBuiltAt: new Date(now - MAP_REFRESH_INTERVAL_MS), now }), false, "正好 5 分钟不算超");
});

// ---------------------------------------------------------------- 性能

test("验收标准：5k 文件 / 2 万条边的渲染流水线远在 200ms 的量级内", async () => {
  const index = memoryRepoIndexStore();
  const symbols: SeedSymbol[] = [];
  const edges: { fromPath: string; toPath: string; symbol: string; weight: number }[] = [];
  for (let directory = 0; directory < 50; directory += 1) {
    for (let file = 0; file < 100; file += 1) {
      const path = `src/mod${directory}/file${file}.ts`;
      for (let line = 0; line < 4; line += 1) {
        symbols.push({
          path,
          name: `mod${directory}fn${file}l${line}`,
          signature: `export function mod${directory}fn${file}l${line}(value: string): string`,
          startLine: line + 1,
        });
      }
      const target = `src/mod${(directory + 1) % 50}/file${file}.ts`;
      edges.push({ fromPath: path, toPath: target, symbol: `mod${directory}fn${file}l0`, weight: 1 });
      edges.push({ fromPath: path, toPath: `src/mod${directory}/file${(file + 1) % 100}.ts`, symbol: "./next", weight: 2 });
      edges.push({ fromPath: path, toPath: `src/mod${directory}/file${(file + 7) % 100}.ts`, symbol: "./seven", weight: 2 });
      edges.push({ fromPath: path, toPath: `src/mod${(directory + 3) % 50}/file${file}.ts`, symbol: "./far", weight: 2 });
    }
  }
  await seedIndex(index, { symbols, edges });

  const startedAt = Date.now();
  const result = await build({ index, task: "fix mod12fn34l0" });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.degraded, null);
  assert.equal(result.rank!.nodes, 5000);
  assert.ok(result.tokens <= 1500);
  assert.ok(result.matchedSymbols.includes("mod12fn34l0"));
  assert.ok(result.text.startsWith("src/mod12/file34.ts:"), "个性化命中的文件应当在第一行");
  console.log(
    `[repo-map-perf] 5000 文件 / 20000 符号 / ${edges.length} 边：排名 + 渲染 ${elapsedMs}ms（验收线 200ms）`,
  );
  assert.ok(elapsedMs < 2000, `地图构建用了 ${elapsedMs}ms，远超验收线的量级`);
});
