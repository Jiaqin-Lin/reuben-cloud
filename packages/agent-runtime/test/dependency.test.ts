/**
 * 用例 12 · 依赖方向（一条会被三个月后的自己破掉的红线，所以要有测试兜住）。
 *
 * `agent-runtime` 是**纯决策层**：不许 import `pg` / `octokit` / `@aws-sdk/*`，
 * 也不许反向 import `control-plane`。存储走接口注入（P2 的 `SessionStore`），
 * 容器与宿主的实现在 CP 侧。这条测试读的是源码的 import 语句——比"看包依赖"更严格，
 * 因为它连"偷偷加一个相对路径 import"都能抓到。
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 被禁的模块（子串匹配 specifier）：数据库 / GitHub / 对象存储 / CP 自身。 */
const FORBIDDEN = ["pg", "octokit", "@aws-sdk", "control-plane", "minio"];

/** 递归列出所有 .ts 文件。 */
async function listSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listSources(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** 抓 `import ... from "x"` / `export ... from "x"` / `await import("x")` 里的 specifier。 */
const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

describe("Phase 1 · 依赖方向", () => {
  test("agent-runtime 不 import pg / octokit / @aws-sdk / control-plane", async () => {
    const files = await listSources(SRC);
    assert.ok(files.length >= 10, `应当扫到源码文件，实际 ${files.length}`);
    const offenders: string[] = [];
    let imports = 0;
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        imports += 1;
        for (const banned of FORBIDDEN) {
          if (specifier.includes(banned)) {
            offenders.push(`${path.relative(SRC, file)} → ${specifier}`);
          }
        }
      }
    }
    assert.ok(imports > 0, "import 扫描应当抓到东西（正则坏了会让这条测试变成空转）");
    assert.deepEqual(offenders, [], `纯决策层不允许依赖这些模块：\n${offenders.join("\n")}`);
  });

  test("agent-runtime 的相对 import 不逃出包外", async () => {
    const files = await listSources(SRC);
    const escapes: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (!specifier.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved.startsWith(SRC)) escapes.push(`${path.relative(SRC, file)} → ${specifier}`);
      }
    }
    assert.deepEqual(escapes, []);
  });
});
