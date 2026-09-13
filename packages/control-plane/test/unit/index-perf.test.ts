/**
 * P8 · 大仓库预算（spec 测试要点 8；验收标准：中位仓库 ≥3k 文件全量索引 < 60s）。
 *
 * 【为什么这条值得写成一个测试】tree-sitter 的 WASM 形态比原生绑定慢 3–5 倍，而"索引慢到没人用"
 * 是这个特性唯一的失败方式（解析错了只是地图难看，慢了就是每次 Run 都要等）。合成仓库故意长成
 * 真实项目的形状：函数 + 类 + 常量 + 跨文件 import，五个千文件。
 *
 * 【断言为什么这么松】性能测试在 CI 上惩罚的是**回归**，不是机器差异：上限取 60s（验收标准那一句），
 * 真值在这台机器上是 1–2 秒。松的断言 + 打印实测值，比一个会在别人笔记本上假红的紧断言有用。
 * 比 60s 更值得断言的是"没有一个文件被判超时"：那是预算写错（比如单文件预算被单位搞成毫秒/微秒）
 * 的典型症状，而它不会让总时间变难看。
 *
 * 【它不覆盖什么】落库那一段（几万行 INSERT）需要真 PG，由集成测试在真实（小）仓库上覆盖；
 * 这里量的是"解析 + 算边"这两步——索引的绝大部分时间在这里。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { discoverFiles, parseBatch, TOTAL_BUDGET_MS } from "../../src/index/parse.ts";
import { computeEdges } from "../../src/index/refs.ts";

/** 5k 文件（50 目录 × 100 文件），每个文件都有一点真实的形状。 */
const DIRECTORIES = 50;
const FILES_PER_DIRECTORY = 100;

let repoDir: string;

before(async () => {
  repoDir = await mkdtemp(path.join(os.tmpdir(), "rc-perf-"));
  for (let directory = 0; directory < DIRECTORIES; directory += 1) {
    const dir = path.join(repoDir, "src", `mod${directory}`);
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < FILES_PER_DIRECTORY; index += 1) {
      const next = (index + 1) % FILES_PER_DIRECTORY;
      const source = [
        `import { helper${next} } from "./file${next}";`,
        "",
        `export function fn${directory}_${index}(value: string): string {`,
        `  return helper${next}(value);`,
        "}",
        "",
        `export const CONST${directory}_${index} = ${index};`,
        "",
        `export class Class${directory}_${index} {`,
        "  run(): void {",
        "    return;",
        "  }",
        "}",
        "",
      ].join("\n");
      await writeFile(path.join(dir, `file${index}.ts`), source);
    }
  }
});

after(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

test("8. 5k 文件的合成仓库：解析 + 算边远在预算之内，且没有文件被判超时", async () => {
  const startedAt = Date.now();
  const discovery = await discoverFiles(repoDir);
  assert.equal(discovery.indexable.length, DIRECTORIES * FILES_PER_DIRECTORY);
  assert.equal(discovery.truncated, false);

  const outcome = await parseBatch({ root: repoDir, files: discovery.indexable });
  assert.equal(outcome.crashed, false);
  assert.equal(outcome.timedOut, false);
  assert.deepEqual(outcome.timedOutFiles, [], "不该有文件超过单文件预算");
  assert.equal(outcome.files.length, DIRECTORIES * FILES_PER_DIRECTORY);

  const symbols = outcome.files
    .filter((file) => file.status === "ok")
    .map((file) => ({ path: file.path, symbols: file.symbols }));
  const edges = computeEdges({
    files: discovery.indexable.map((file) => file.path),
    symbols,
    candidates: outcome.files
      .filter((file) => file.status === "ok")
      .map((file) => ({ path: file.path, refs: { identifiers: file.identifiers, imports: file.imports } })),
  });
  const elapsedMs = Date.now() - startedAt;

  // 每个文件 4 个符号：函数 / 常量 / 类 / 类里的方法。5000 × 4 = 20000。
  assert.equal(symbols.reduce((sum, file) => sum + file.symbols.length, 0), 20_000);
  assert.ok(edges.length > 0, "跨文件 import 应该产生边");
  console.log(
    `[index-perf] ${DIRECTORIES * FILES_PER_DIRECTORY} 文件 / 20000 符号 / ${edges.length} 边：${elapsedMs}ms（预算 ${TOTAL_BUDGET_MS}ms，验收线 60000ms）`,
  );
  assert.ok(elapsedMs < 60_000, `全量索引用了 ${elapsedMs}ms，超过验收标准的 60s`);
});
