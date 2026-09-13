/**
 * P8 · `IndexGitPort` 的真实现：把"增量判定要问 git 的三件事"翻译成三条命令。
 *
 * 【为什么不复用 `repo/git.ts` 的 `gitOrThrow`】那一条把失败翻译成 `RepoError`，而索引的
 * 调用方（`indexer.ts`）对失败的态度完全不同：**跳过这次索引**，不是让 Run 失败。
 * 所以这里用不抛异常的 `runGit`，自己把"git 认不出这个 commit"这类情况降级成"全量重建"
 * ——一个刚被 force push 覆盖过的 commit 认不出来是正常的，不能因此不建索引。
 *
 * 【三条命令里最不显眼的两处】
 *  - `-z`：路径含非 ASCII 时 git 默认会输出 `"\346\226\207\226\207.md"` 这种加引号的转义形式，
 *    拿它去比对仓库路径会全部不匹配（`repo/*` 与 `discoverFiles` 给的都是原始 UTF-8）。
 *    `-z` 让每条记录以 NUL 分隔、路径原样输出。
 *  - `--no-renames`：rename 会被拆成"删一个 + 加一个"，两边都会进变化集 → 那个文件被重解析。
 *    这是有意的（"宁可多解析一个文件，不要漏掉一次改名"）：renames 的相似度阈值本身就是启发式，
 *    而改名之后的文件内容常常也变了。
 */

import { runGit } from "../repo/git.ts";
import { gitEnv } from "../repo/git.ts";
import type { DiffEntry, IndexGitPort } from "./indexer.ts";

/** 这三条命令都是"读元数据"，不需要 clone / clone 那样的长时限；但大仓库的全树 diff 也不快。 */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GitIndexPortOptions {
  timeoutMs?: number;
}

export function gitIndexPort(cloneDir: string, options: GitIndexPortOptions = {}): IndexGitPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function git(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const result = await runGit(args, { cwd: cloneDir, env: gitEnv(), timeoutMs });
    if (result.spawnError !== null) throw result.spawnError;
    return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  }

  return {
    async head(): Promise<string> {
      const result = await git(["rev-parse", "HEAD"]);
      if (result.code !== 0) throw new Error(`rev-parse HEAD 失败：${result.stderr.trim().slice(-200)}`);
      return result.stdout.trim();
    },

    async isAncestor(fromSha: string, toSha: string): Promise<boolean> {
      const result = await git(["merge-base", "--is-ancestor", fromSha, toSha]);
      // 0 = 是祖先；1 = 不是（force push / 换分支 → 全量）；其他（128：clone 里没有这个对象）
      // 也当"不是"——那正是"上一版索引的基准在这个 clone 里已经不存在"的情形。
      return result.code === 0;
    },

    async diff(fromSha: string, toSha: string): Promise<DiffEntry[]> {
      const result = await git(["diff", "--name-status", "-z", "--no-renames", fromSha, toSha]);
      if (result.code !== 0) throw new Error(`diff ${fromSha}..${toSha} 失败：${result.stderr.trim().slice(-200)}`);
      return parseNameStatusZ(result.stdout);
    },
  };
}

/**
 * 解析 `git diff --name-status -z` 的输出：`<状态>\0<路径>\0` 重复。
 *
 * 导出是为了单测：把解析从"真跑 git"里拆出来之后，`M/A/D` 三种状态与含中文的路径
 * 都能在没有仓库的情况下断言（真 git 的行为由集成测试覆盖）。
 */
export function parseNameStatusZ(stdout: string): DiffEntry[] {
  const parts = stdout.split("\u0000").filter((part) => part !== "");
  const entries: DiffEntry[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index]!;
    const path = parts[index + 1]!;
    const letter = status[0];
    if (letter === "A") entries.push({ path, status: "added" });
    else if (letter === "D") entries.push({ path, status: "deleted" });
    else if (letter === "M" || letter === "T") entries.push({ path, status: "modified" });
    // `--no-renames` 之后不该出现 R/C；真出现了就跳过（宁可少判一个变化，也不要猜错路径）。
  }
  return entries;
}
