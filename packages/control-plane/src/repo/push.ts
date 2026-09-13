/**
 * `push.ts` —— 把 clone 工作区里的改动变成远端的一条分支。
 *
 * 三件不能少的事：
 *
 *  1. **只推 `reuben-cloud/*` 分支**（并且显式拒绝 main / master）。§F.5 说得很清楚：
 *     这是**产品语义**、不是安全边界。但它便宜，而且能把"手滑推错分支"从一次
 *     不可逆的远端操作变成一条报错。
 *
 *  2. **force-with-lease，而不是 force**。分支已存在时用显式的
 *     `--force-with-lease=refs/heads/<branch>:<expect>`，`expect` 是我们**刚刚**
 *     从远端读到的 sha（`ls-remote`）。第三方改过这条分支 → 推被拒 → 如实报告，
 *     绝不静默覆盖（附录 A-12 的产品取舍：一个 Task 固定一条分支，重跑覆盖，
 *     但只覆盖"我们上次推的那条历史"）。
 *
 *  3. **凭据仍然是 `-c http.extraHeader`**，与 clone 完全同一套
 *     （`git.ts` 的 `tokenAuthArgs`）。push 是凭据生命周期里的最后一站，
 *     也是最容易"顺手"把 token 写进 URL 的一站。
 *
 * 【为什么用显式 `<ref>:<expect>` 而不是裸 `--force-with-lease`】裸形式拿本地的
 * remote-tracking ref 当"预期值"，而我们的 clone 是 checkout 到某个 commit 的、
 * 从没 fetch 过要推的那条分支——裸形式在这里要么没有预期值，要么是个过时的预期值。
 * 显式形式每次都向远端问一次当前值，语义是真正的 compare-and-swap。
 * 分支不存在时期望值是**空字符串**：git 文档写明"空 expect = 这个 ref 必须不存在"，
 * 于是"两个人同时创建同一条分支"里输的那一个会被拒，而不是被覆盖。
 *
 * 【为什么 commit 要 --no-verify】仓库内容是不可信的。git hook 不会被 clone 带到
 * 本地（只来自模板目录），但 `core.hooksPath` 与用户自己的全局 hook 仍然可能在 CP
 * 这个身份下执行任意命令。我们永远不用仓库里的 hook 做任何事，所以一律跳过。
 */

import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import {
  assertNoUserInfo,
  gitFailure,
  gitOrThrow,
  looksLikeAuthFailure,
  looksLikeLeaseRejection,
  looksLikePushRejection,
  redactedCommand,
  runGit,
  tokenAuthArgs,
} from "./git.ts";
import { RepoError } from "./types.ts";

/** 分支命名空间（§0.1 / 附录 A-12）：`reuben-cloud/<taskId>`。 */
export const BRANCH_PREFIX = "reuben-cloud/";

/** push 的时限：一次推送 = 一次上传，仓库大时比普通命令慢。 */
export const GIT_PUSH_TIMEOUT_MS = 180_000;

/** 缺省的 commit 身份。用 `-c user.name/user.email` 传，不写任何文件。 */
export const DEFAULT_AUTHOR = { name: "reuben-cloud", email: "bot@reuben-cloud.invalid" };

const FORBIDDEN_BRANCHES = new Set(["main", "master", "HEAD"]);

/**
 * 一个 Task 固定一条分支（附录 A-12）：重跑覆盖同一条，PR 正文里写明是第几次 Run。
 * taskId 里的非法字符换成 `-`——分支名要能安全地进 git 的 argv 与远端。
 */
export function branchNameForTask(taskId: string): string {
  const safe = taskId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (safe === "") throw new RepoError("config_invalid", `taskId 里没有可用的字符：${JSON.stringify(taskId)}`);
  return `${BRANCH_PREFIX}${safe.slice(0, 120)}`;
}

/** 只允许推我们自己的命名空间。`main` / `master` 即使被拼进前缀也会被拒。 */
export function assertPushableBranch(branch: string): void {
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new RepoError("protected_branch", `只推 ${BRANCH_PREFIX}* 分支，拒绝 ${branch}`, { details: { branch } });
  }
  const name = branch.slice(BRANCH_PREFIX.length);
  if (FORBIDDEN_BRANCHES.has(name) || name === "") {
    throw new RepoError("protected_branch", `分支名不合法：${branch}`, { details: { branch } });
  }
  // git check-ref-format 的那几条里最容易被踩的几个（不引 git，直接判）。
  // 注意：以 `-` 开头的**路径组件**是合法的（`reuben-cloud/-x` 通过 check-ref-format），
  // 真正要拦的是以 `-` 开头的**整个 ref**（它会变成 git 的选项）；前缀已经保证了这一条。
  if (
    branch.startsWith("-") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.includes("\0") ||
    /[\s~^:?*[\\]/.test(branch) ||
    name.split("/").some((component) => component === "" || component.startsWith("."))
  ) {
    throw new RepoError("protected_branch", `分支名不合法：${branch}`, { details: { branch } });
  }
}

export interface CommitAndPushInput {
  /** clone 的工作区目录（`RepoClone.dir`）。 */
  dir: string;
  /** 远端地址，**不含凭据**。 */
  url: string;
  branch: string;
  /** commit 的首行（`reuben-cloud: <task title>`）。 */
  message: string;
  /** commit 的正文（run id / attempt）。 */
  body?: string;
  token?: string | null;
  /**
   * force-with-lease 的期望值。缺省 = push 之前现问一次 `ls-remote`。
   * 显式传一个**过时**的值可以验证"第三方改过分支 → 推被拒"这条保护是真的（测试这么做）。
   */
  expectedRemoteSha?: string | null;
  author?: { name: string; email: string };
  timeoutMs?: number;
  log?: LogFn;
}

export interface PushResult {
  branch: string;
  commitSha: string;
  /** 推送之前远端那条分支的 sha（null = 之前不存在）。 */
  remoteShaBefore: string | null;
  /** 覆盖了已存在的分支（无论快进与否）。Phase 12 用它写 PR 正文的 attempt 语义。 */
  forced: boolean;
  files: number;
  insertions: number;
  deletions: number;
  message: string;
}

/** commit message 的形状（Phase 12 的 PR 正文也复用它）。 */
export function buildCommitMessage(input: { title: string; runId: string; attempt?: number }): {
  message: string;
  body: string;
} {
  return {
    message: `reuben-cloud: ${input.title}`,
    body: `run: ${input.runId}\nattempt: ${input.attempt ?? 1}\n\n由 reuben-cloud 自动生成。`,
  };
}

/**
 * 提交工作区里的一切，然后推成一条分支。
 *
 * 没有改动时抛 `nothing_to_commit`——**不造空 commit**。调用方（Phase 12）
 * 把这条当成"这次 Run 没有产出"，而不是一次失败。
 */
export async function commitAndPush(input: CommitAndPushInput): Promise<PushResult> {
  assertPushableBranch(input.branch);
  assertNoUserInfo(input.url, "push");
  const timeoutMs = input.timeoutMs ?? GIT_PUSH_TIMEOUT_MS;
  const log = input.log ?? noopLog;
  const author = input.author ?? DEFAULT_AUTHOR;

  // ---- ① 全部加入。`add -A` 尊重 .gitignore：构建产物不会进 commit。
  await gitOrThrow(["-C", input.dir, "add", "-A"], { reason: "git_failed", context: { dir: input.dir } });

  // ---- ② 有没有东西可提交？`diff --cached --quiet` 的 0/1 是标准用法。
  const staged = await runGit(["-C", input.dir, "diff", "--cached", "--quiet"]);
  if (staged.spawnError !== null) {
    throw new RepoError("git_unavailable", `git 起不来：${staged.spawnError.message}`);
  }
  if (staged.code === 0) {
    throw new RepoError("nothing_to_commit", "工作区没有改动，不创建空 commit", { details: { dir: input.dir } });
  }
  if (staged.code !== 1) throw gitFailure(["-C", input.dir, "diff", "--cached", "--quiet"], staged, {});

  const stats = parseShortStat(
    await gitOrThrow(["-C", input.dir, "diff", "--cached", "--shortstat"], { reason: "git_failed" }),
  );

  // ---- ③ commit。身份用 `-c` 传（不写任何配置文件），hook 一律跳过（见文件头）。
  await gitOrThrow(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "-C",
      input.dir,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      input.message,
      ...(input.body === undefined ? [] : ["-m", input.body]),
    ],
    { reason: "git_failed", context: { branch: input.branch } },
  );
  const commitSha = (await gitOrThrow(["-C", input.dir, "rev-parse", "HEAD"], { reason: "not_a_repository" })).trim();

  // ---- ④ CAS 的参照值：远端现在在这条分支的哪个 sha 上（不存在就是 null）。
  const remoteShaBefore = await lsRemoteSha(input.url, input.branch, input.token, timeoutMs);
  const expect = input.expectedRemoteSha !== undefined ? input.expectedRemoteSha : remoteShaBefore;

  // ---- ⑤ push。即使分支不存在也带 lease（空 expect = 必须不存在），把"并发创建"也挡掉。
  // `-C input.dir` 不能省：`HEAD:refs/heads/…` 的左侧是在**本地仓库**里解析的，
  // 不指定目录就会把 CP 当前工作目录那个仓库的 HEAD 推上去（探针真的推到过）。
  const pushArgs = [
    ...tokenAuthArgs(input.token),
    "-C",
    input.dir,
    "push",
    "--porcelain",
    "--no-verify",
    `--force-with-lease=refs/heads/${input.branch}:${expect ?? ""}`,
    input.url,
    `HEAD:refs/heads/${input.branch}`,
  ];
  const result = await runGit(pushArgs, { timeoutMs });
  if (result.spawnError !== null) {
    throw new RepoError("git_unavailable", `git 起不来：${result.spawnError.message}`, {
      details: { command: redactedCommand(pushArgs) },
    });
  }
  if (result.timedOut) {
    throw new RepoError("git_timeout", `push 超过 ${timeoutMs}ms 没有结束`, { details: { branch: input.branch } });
  }
  if (result.code !== 0) {
    // **`--porcelain` 把拒绝的原因写在 stdout 里**（`!\trefs/…\t[rejected] (stale info)`），
    // 而 `error: failed to push some refs` 在 stderr 里。两处都要看，缺一边就分不出"被拒"。
    const stderrText = result.stderr.toString("utf8");
    const porcelain = result.stdout.toString("utf8");
    const combined = `${porcelain}\n${stderrText}`;
    if (looksLikeAuthFailure(combined)) {
      throw gitFailure(pushArgs, result, { reason: "auth_failed" });
    }
    if (looksLikeLeaseRejection(combined)) {
      // 拒绝也要给出**现在的**远端 sha：报告里"我们以为是什么 / 实际是什么"才是可行动的。
      const remoteShaNow = await lsRemoteSha(input.url, input.branch, input.token, timeoutMs).catch(() => null);
      throw new RepoError(
        "push_lease_rejected",
        `远端分支 ${input.branch} 不是我们预期的 ${expect ?? "(不存在)"}，拒绝覆盖`,
        {
          details: {
            branch: input.branch,
            expected: expect,
            actual: remoteShaNow,
            porcelain: porcelain.trim().slice(0, 1_000),
            stderr: stderrText.trim().slice(0, 1_000),
          },
        },
      );
    }
    if (looksLikePushRejection(combined)) {
      throw new RepoError("push_rejected", `push 被拒（${input.branch}）：${summarizePushRejection(porcelain, stderrText)}`, {
        details: { branch: input.branch, porcelain: porcelain.trim().slice(0, 1_000), stderr: stderrText.trim().slice(0, 1_000) },
      });
    }
    throw gitFailure(pushArgs, result, { reason: "git_failed", context: { branch: input.branch } });
  }

  log("info", `已推送 ${input.branch}`, {
    commitSha,
    remoteShaBefore,
    files: stats.files,
    insertions: stats.insertions,
    deletions: stats.deletions,
  });
  return {
    branch: input.branch,
    commitSha,
    remoteShaBefore,
    forced: remoteShaBefore !== null,
    ...stats,
    message: input.message,
  };
}

/**
 * 问远端一条分支的 sha。不存在返回 null。
 *
 * `ls-remote` 与 push 都会带 token：这两条请求都是"以 App 的身份问 GitHub"，
 * 而 auth 失败在这里的分类与 push 里完全一样（`auth_failed`）。
 */
export async function lsRemoteSha(
  url: string,
  branch: string,
  token: string | null | undefined,
  timeoutMs: number,
): Promise<string | null> {
  const args = [...tokenAuthArgs(token), "ls-remote", "--heads", url, `refs/heads/${branch}`];
  const result = await runGit(args, { timeoutMs });
  if (result.spawnError !== null) {
    throw new RepoError("git_unavailable", `git 起不来：${result.spawnError.message}`);
  }
  if (result.timedOut) throw new RepoError("git_timeout", `ls-remote 超过 ${timeoutMs}ms 没有结束`);
  if (result.code !== 0) throw gitFailure(args, result, { reason: "git_failed", context: { branch } });
  const line = result.stdout.toString("utf8").trim().split("\n")[0] ?? "";
  const sha = line.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

/** porcelain 输出里挑一条"被拒"的行；没有就退回 stderr 的第一行。 */
function summarizePushRejection(porcelain: string, stderrText: string): string {
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("!") || line.includes("[rejected]") || line.includes("[remote rejected]")) {
      return line.trim();
    }
  }
  return stderrText.trim().split("\n")[0] ?? "";
}

/**
 * 解析 `git diff --cached --shortstat`：
 * ` 3 files changed, 12 insertions(+), 4 deletions(-)`（单数时 git 会写 `1 file changed`）。
 * 解析失败给 0 —— 这个数字只用于报告（PR 正文），不该因为它挂掉一条 push。
 */export function parseShortStat(text: string): { files: number; insertions: number; deletions: number } {
  const files = /(\d+) files? changed/.exec(text);
  const insertions = /(\d+) insertions?\(\+\)/.exec(text);
  const deletions = /(\d+) deletions?\(-\)/.exec(text);
  return {
    files: files === null ? 0 : Number(files[1]),
    insertions: insertions === null ? 0 : Number(insertions[1]),
    deletions: deletions === null ? 0 : Number(deletions[1]),
  };
}
