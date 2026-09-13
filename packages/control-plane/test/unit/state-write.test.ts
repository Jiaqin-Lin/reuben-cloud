/**
 * Phase 8 用例 3：**改 `sandboxes.state` 的代码只允许出现在 `db/sandboxes.ts` 里**。
 *
 * 【为什么这个测试值得存在】spec Phase 8 §3 要求"两条一起上"：
 *  1. 数据库层的 `SECURITY DEFINER` 函数 + 收掉 `UPDATE(state)` 权限（能拦住所有人）
 *  2. 一条 grep 测试（能拦住新来的同学，便宜、有效、在 `npm test` 里跑）
 * 这一条就是第 2 条。它是**唯一一条不需要 Docker、不需要 Postgres 的状态机测试**，
 * 也是唯一一条能在"代码还没跑起来"时就发现有人绕过 transition() 的测试。
 *
 * 【本实现把规则改了两处，都写了理由】
 *  1. **原话是"`SET state` 这个字符串只允许出现在 `db/sandboxes.ts` 里"。**
 *     这条在实现里会变成空转：Phase 8 把 UPDATE 整个搬进了 SQL 函数
 *     （`sandbox_transition`），所以任何 TS 文件里都不再有 `SET state`——
 *     规则永远成立，永远测不出东西。改成"**`UPDATE sandboxes` 只能出现在
 *     `db/sandboxes.ts` 里**"：更强（连非 state 列的直改也一起管住）、而且非空转。
 *  2. **不能把规则写成"全仓库不许有 `SET state`"**：`executions` 表有自己的状态列
 *     （`state ∈ running/completed/…`），它的写入是 `recordExecution()` 里那句
 *     `ON CONFLICT … DO UPDATE SET state = EXCLUDED.state`，与沙箱状态机无关。
 *     一条不分表的规则要么误伤它，要么就得把它加进白名单——那才是真的放松了约束。
 *  3. 再加一条**非空转**的规则：调用 `sandbox_transition(...)` 的地方也只能是
 *     `db/sandboxes.ts`；并断言那个文件里确实有这次调用，防止改名让两条规则静默失效。
 *
 * 【扫描范围】只扫产品代码：`packages/*\/src`、`deploy/*\/src`、`scripts`。
 * `test/` 不在范围内是**必须**的：集成测试里有一条用例专门验证"应用角色直接
 * `UPDATE … SET state` 会被数据库拒绝"，那句 SQL 当然得写出来。
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** 允许直接改 sandboxes 的唯一文件。 */
const ONLY_ALLOWED = "packages/control-plane/src/db/sandboxes.ts";

/** 产品代码目录（相对仓库根）。 */
const SCAN_ROOTS = ["packages/sandbox-agent/src", "packages/control-plane/src", "packages/e2e/src", "deploy", "scripts"];

interface Rule {
  /** 违规文本的形状。 */
  pattern: RegExp;
  /** 报错时给人看的一句话。 */
  describe: string;
}

const RULES: Rule[] = [
  {
    pattern: /\bupdate\s+"?sandboxes\b/i,
    describe: "直接 UPDATE sandboxes 表（状态只能由 transition() 改）",
  },
  {
    pattern: /sandbox_transition\s*\(/,
    describe: "直接调用 SQL 函数 sandbox_transition()（唯一调用点是 db/sandboxes.ts）",
  },
];

async function* walkTypescript(relative: string): AsyncGenerator<string> {
  const absolute = path.join(REPO_ROOT, relative);
  let entries;
  try {
    entries = await readdir(absolute, { recursive: true, withFileTypes: true });
  } catch {
    return; // 目录不存在（比如某个包还没建）：跳过，不是失败
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const dir = (entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path?: string }).path ?? "";
    assert.ok(dir !== "", "拿不到 Dirent 的父目录");
    yield path.relative(REPO_ROOT, path.join(dir, entry.name));
  }
}

async function scanSources(): Promise<Array<{ file: string; text: string }>> {
  const files: Array<{ file: string; text: string }> = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of walkTypescript(root)) {
      files.push({ file, text: await readFile(path.join(REPO_ROOT, file), "utf8") });
    }
  }
  return files;
}

describe("状态机 · 唯一写入口（grep 测试）", () => {
  test("扫描范围覆盖产品代码（防止路径写错时整组测试静默通过）", async () => {
    const files = await scanSources();
    assert.ok(files.length > 20, `只扫到 ${files.length} 个文件，仓库根多半解析错了：${REPO_ROOT}`);
    assert.ok(
      files.some((file) => file.file === ONLY_ALLOWED),
      `扫描结果里没有 ${ONLY_ALLOWED}，路径一定错了`,
    );
  });

  for (const rule of RULES) {
    test(`${rule.describe} —— 只允许出现在 db/sandboxes.ts`, async () => {
      const offenders: string[] = [];
      for (const { file, text } of await scanSources()) {
        if (rule.pattern.test(text) && file !== ONLY_ALLOWED) offenders.push(file);
      }
      assert.deepEqual(offenders, [], `这些文件违规（${rule.describe}）：${offenders.join(", ")}`);
    });
  }

  test("db/sandboxes.ts 里确实调用了 sandbox_transition（防止上面几条静默失效）", async () => {
    const text = await readFile(path.join(REPO_ROOT, ONLY_ALLOWED), "utf8");
    assert.ok(
      text.includes("sandbox_transition"),
      "sandboxes.ts 里没有 sandbox_transition：要么实现被换掉了，要么上面几条规则已经失效",
    );
  });
});
