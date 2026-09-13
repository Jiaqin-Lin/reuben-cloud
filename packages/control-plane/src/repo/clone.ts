/**
 * `clone.ts` —— 把远端仓库 clone 到 CP 的临时目录，并 checkout 到指定 commit。
 *
 * 【凭据怎么进去的】调用方给一个 `token` 字符串；`git.ts` 把它变成一次性的
 * `-c http.extraHeader=…`。**绝不把 token 放进 remote URL**——那个 URL 会被写进
 * `.git/config`，而我们马上要把带 `.git` 的整个仓库打 tar 灌进沙箱（§J 红线）。
 *
 * 【临时目录的生命周期】一切都落在 `/tmp/reuben-cloud-cp/<runId>/` 下（§0.1），
 * 成功与失败路径都会把整个 run 目录删掉（spec 用例 10）。崩溃残留由启动时的
 * `sweepStaleRunDirs()` 兜底——CP 进程可能在任何一刻被 kill -9，
 * 不能在"退出时清理"上押注。
 *
 * 【为什么不做 shallow clone】目标 commit 可能不在 tip 上，shallow 里可能压根不存在。
 * `--filter=blob:none` 之类是性能优化，等真有性能问题再说（§Phase 9 的边界）。
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { GIT_CLONE_TIMEOUT_MS, assertNoUserInfo, gitOrThrow, runGit, tokenAuthArgs } from "./git.ts";
import { RepoError } from "./types.ts";

/** CP 的临时目录根。命名来自 §0.1；启动时的残留清理也扫这里。 */
export const CP_TMP_ROOT = "/tmp/reuben-cloud-cp";

/** 残留目录的默认保留时长。超过它的 run 目录一定是上次崩溃留下的（没有别的可能）。 */
export const STALE_RUN_DIR_MS = 6 * 60 * 60 * 1000;

/** runId 要进路径，限制成安全字符。**这条检查本身就是防路径穿越的第一道门。** */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RepoError("config_invalid", `runId 不合法（只允许字母数字与 . _ -）：${JSON.stringify(runId)}`);
  }
}

/** 一个 run 的目录：`/tmp/reuben-cloud-cp/<runId>`。 */
export function runDirOf(runId: string, root: string = CP_TMP_ROOT): string {
  assertRunId(runId);
  return path.join(root, runId);
}

/** clone 落点：`/tmp/reuben-cloud-cp/<runId>/repo`（spec §2）。 */
export function cloneDirOf(runId: string, root: string = CP_TMP_ROOT): string {
  return path.join(runDirOf(runId, root), "repo");
}

export interface CloneRepoInput {
  runId: string;
  /** clone 地址。生产是 `https://github.com/owner/repo.git`；测试是本地 fixture。 */
  url: string;
  /** 目标 commit（sha / tag / ref）。 */
  commit: string;
  /**
   * installation token。`null` / 缺省 = 不带凭据（本地 fixture、file:// 远端）。
   * **不要把它拼进 `url`**：那正是 `assertNoUserInfo` 要拦的写法。
   */
  token?: string | null;
  root?: string;
  timeoutMs?: number;
  log?: LogFn;
}

export interface RepoClone {
  runId: string;
  dir: string;
  /** clone 时的远端地址（不含凭据）。push 用它。 */
  url: string;
  /** 调用方请求的那个 commit（原样保留）。 */
  commit: string;
  /** checkout 之后的完整 sha。`/diff?base=` 与 `git apply` 都用它。 */
  baseSha: string;
}

/**
 * clone + checkout。**失败不留残留**：任何一步抛异常都会把这个 run 的目录删掉，
 * 然后原样抛出去（spec 用例 10 的失败路径）。
 */
export async function cloneRepo(input: CloneRepoInput): Promise<RepoClone> {
  assertNoUserInfo(input.url, "clone");
  if (input.commit === "" || input.commit.startsWith("-") || input.commit.includes("\0")) {
    // 以 `-` 开头的 commit 会变成 git 的命令行开关，和沙箱侧 `base` 的校验同一条规矩。
    throw new RepoError("config_invalid", `commit 不合法：${JSON.stringify(input.commit)}`);
  }

  const runDir = runDirOf(input.runId, input.root);
  const dir = cloneDirOf(input.runId, input.root);
  // 重跑同一个 runId 时先清掉旧的：clone 到非空目录会直接失败，而"重跑"是产品语义
  // 的一部分（附录 A-12：一个 Task 固定一条分支，重跑覆盖）。
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });

  try {
    await gitOrThrow(
      [
        ...tokenAuthArgs(input.token),
        // 不 shallow：目标 commit 可能不是 tip。--no-single-branch 让远端分支都在
        // （force-with-lease 的远端 sha 我们另外用 ls-remote 拿，这里是为了 clone 的完整性）。
        "clone",
        "--no-single-branch",
        "--quiet",
        input.url,
        dir,
      ],
      {
        reason: "clone_failed",
        timeoutMs: input.timeoutMs ?? GIT_CLONE_TIMEOUT_MS,
        context: { url: input.url, runId: input.runId },
      },
    );

    // 先 verify 再 checkout：把"这个 commit 根本不在仓库里"与"checkout 失败"
    // 分成两个 reason——它们对使用者的含义不同（前者是传错了，后者是环境问题）。
    const verify = await runGit(["-C", dir, "rev-parse", "--verify", `${input.commit}^{commit}`]);
    if (verify.code !== 0) {
      throw new RepoError("unknown_commit", `仓库里没有这个 commit：${input.commit}`, {
        details: { commit: input.commit, stderr: verify.stderr.toString("utf8").trim().slice(0, 500) },
      });
    }
    await gitOrThrow(["-C", dir, "checkout", "--quiet", "--detach", input.commit], {
      reason: "checkout_failed",
      context: { commit: input.commit },
    });
    const baseSha = (await gitOrThrow(["-C", dir, "rev-parse", "HEAD"], { reason: "not_a_repository" })).trim();

    (input.log ?? noopLog)("info", `仓库已 clone 到 ${dir}`, { baseSha, commit: input.commit });
    return { runId: input.runId, dir, url: input.url, commit: input.commit, baseSha };
  } catch (error) {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * clone → 回调 → **无论成败删掉整个 run 目录**。Phase 11/12 的主流程用这个形状：
 * 一次 run 的仓库生命周期完全包在括号里，不需要在业务代码里记得 finally。
 */
export async function withRepoClone<T>(input: CloneRepoInput, fn: (clone: RepoClone) => Promise<T>): Promise<T> {
  const clone = await cloneRepo(input);
  try {
    return await fn(clone);
  } finally {
    await removeRunDir(input.runId, input.root);
  }
}

/** 删掉一个 run 的目录。不存在当成功（幂等）。 */
export async function removeRunDir(runId: string, root: string = CP_TMP_ROOT): Promise<void> {
  await rm(runDirOf(runId, root), { recursive: true, force: true });
}

export interface SweepRunDirsOptions {
  root?: string;
  /** 超过这个年龄的目录才删。默认 6h（一个 run 不可能活这么久）。 */
  maxAgeMs?: number;
  /** 注入时钟（测试用）。 */
  now?: number;
}

export interface SweepRunDirsReport {
  removed: string[];
  kept: number;
  errors: string[];
}

/**
 * 启动时的残留清理：扫一遍 `/tmp/reuben-cloud-cp/*`，比 `maxAgeMs` 老的目录删掉。
 *
 * 为什么按年龄而不是"无条件全删"：CP 可能有多份在跑（本地开发 + CI），
 * 无条件删会把另一个进程正在用的目录端掉。按年龄是"我们确信它已经死了"的保守版本。
 */
export async function sweepStaleRunDirs(options: SweepRunDirsOptions = {}): Promise<SweepRunDirsReport> {
  const root = options.root ?? CP_TMP_ROOT;
  const maxAgeMs = options.maxAgeMs ?? STALE_RUN_DIR_MS;
  const now = options.now ?? Date.now();

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { removed: [], kept: 0, errors: [] };
    throw error;
  }

  const removed: string[] = [];
  const errors: string[] = [];
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      kept += 1;
      continue;
    }
    const full = path.join(root, entry.name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs <= maxAgeMs) {
        kept += 1;
        continue;
      }
      await rm(full, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, kept, errors };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
