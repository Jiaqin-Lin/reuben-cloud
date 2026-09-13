/**
 * `run.ts` —— 一次 Run 的收尾编排：**从 agent 的最后一轮，到仓库里的一条 PR**。
 *
 * 【为什么单独一个文件（不在 spec 的交付物清单里）】Phase 11 把这段编排写在
 * `scripts/agent-run.ts` 里，Phase 12 要接上 PR——如果继续留在脚本里，"生产路径"
 * 就永远只有手工跑得起来的东西，集成测试只能另抄一份（Phase 11 的 `workspaceDir`
 * 漏传就是这么漏掉的）。搬到模块里之后，脚本与集成测试走的是**同一个函数**：
 *  ① 验证（可选，在沙箱里真跑一遍测试）
 *  ② 把沙箱的改动取回 CP 的工作区（`collectSandboxChanges`：patch 应用 + 忠实效验，
 *     失败自动 archive 回退）
 *  ③ 发布：给了 `publish` 就 commit → push → PR（Phase 12）；没给就只落一个 patch 文件
 *     （Phase 11 的用法，仍然保留——本地不想接 GitHub 的人只用它）
 *
 * 【为什么验证在取 diff 之前】验证命令可能写文件（快照、lockfile）。顺序反过来就会
 * 出现"PR 里的树 ≠ 验证跑过的那棵树"。先验证再取 diff，两边必然一致。
 *
 * 【为什么这个文件不碰沙箱生命周期】建沙箱 / 销毁沙箱是 `SandboxManager` 的事，
 * 调用方决定什么时候销毁（取完 diff 才能销毁）。这里只消费一个已经就绪的 target。
 */

import { copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { CollectedChanges } from "../repo/apply.ts";
import { collectSandboxChanges } from "../repo/apply.ts";
import type { PullRequestApi, PublishRunResult, RetryOptions, RunVerification } from "../repo/pr.ts";
import { buildPullRequestBody, publishRun, verifyInSandbox } from "../repo/pr.ts";
import type { RepoClone } from "../repo/clone.ts";
import { branchNameForTask } from "../repo/push.ts";
import type { RepoApi, RepoRef, SandboxTarget } from "../repo/types.ts";
import type { AgentLoopResult } from "./loop.ts";

/** 仓库在沙箱里的落点（与 `prompt.ts` 的 `REPO_DIR` 同一个契约）。 */
export const DEFAULT_REPO_DIR = "/workspace/repo";

/**
 * `--task-id` 的缺省值：issue 内容的 sha256 前 12 位。
 *
 * 【为什么不用 issue 的首行】`branchNameForTask()` 只留 `[A-Za-z0-9._-]`，而 issue 标题
 * 常常是中文——中文会被全部换成连字符、然后被"去掉首尾连字符"清成空串，直接报错。
 * 哈希是 ASCII、稳定（同一个 issue 重跑落到同一条分支/同一条 PR），又不泄露 issue 内容。
 */
export function taskIdForIssue(issue: string): string {
  const digest = createHash("sha256").update(issue.trim()).digest("hex").slice(0, 12);
  return `issue-${digest}`;
}

export interface VerifyCommand {
  cmd: string[];
  /** 缺省 = 仓库目录（`repoDir`）。验证命令也是“在仓库里跑”。 */
  cwd?: string;
  timeoutMs?: number;
}

/** 发布成 PR 需要的一切。**不给 `publish` 就只落 patch 文件**（Phase 11 的用法）。 */
export interface PublishOptions {
  ref: RepoRef;
  /** 远端地址，不含凭据。 */
  remoteUrl: string;
  /** 仓库默认分支。 */
  baseBranch: string;
  /** 这次 Run 的题面（写进 commit message 与 PR 标题）。 */
  taskTitle: string;
  /** 同一个 Task 固定同一条分支（附录 A-12）；缺省从 `taskId` 推。 */
  branch?: string;
  /** 取 installation token（每次调用都经过 `GithubAppCredentials` 的缓存/续签）。 */
  token: () => Promise<string>;
  /** 注入 PR API（集成测试给假的；生产不给 = 真 Octokit）。 */
  api?: PullRequestApi;
  draft?: boolean;
  attempt?: number;
  /** transcript 的对象存储链接（配了才有）。 */
  transcriptUrl?: string | null;
  expectedRemoteSha?: string | null;
  retry?: RetryOptions;
}

export interface FinishRunInput {
  api: RepoApi;
  target: SandboxTarget;
  clone: RepoClone;
  /** agent 循环的结果（PR 正文里的比例、轮数、用量都从它来）。 */
  run: AgentLoopResult;
  issue: string;
  taskId: string;
  runId: string;
  model: string;
  sandboxId?: string | null;
  /** 仓库在沙箱里的位置；缺省 `/workspace/repo`。 */
  repoDir?: string;
  /** 在沙箱里跑的验证命令（§Phase 12 §2："测试有没有跑过、跑的结果是什么"）。 */
  verify?: VerifyCommand | null;
  /** 给了 = 发布成 PR。 */
  publish?: PublishOptions | null;
  /** 没给 `publish` 时：patch 落点。两个都给时 patch 也会落一份（便于留证）。 */
  patchOut?: string | null;
  log?: LogFn;
}

export interface FinishRunResult {
  /** 取回后的 CP 工作区：`clone.dir` 现在是一棵与沙箱一致的树。 */
  changes: CollectedChanges;
  verification: RunVerification | null;
  /** 落盘的 patch 文件（没要求就是 null）。 */
  patchFile: string | null;
  /** 发布结果（没接 GitHub 就是 null）。 */
  published: PublishRunResult | null;
  /** PR 正文（没发布时是空串）。集成测试与脚本都拿它做展示。 */
  body: string;
  /** head 分支名（发布了才有）。 */
  branch: string | null;
}

/**
 * 收尾。每一步失败都抛**结构化**错误（`RepoError` / `SandboxApiError`），
 * 调用方按 `reason` 决定是"这次 Run 没产出"还是"环境坏了"。
 */
export async function finishRun(input: FinishRunInput): Promise<FinishRunResult> {
  const log = input.log ?? noopLog;
  const repoDir = input.repoDir ?? DEFAULT_REPO_DIR;
  const attempt = input.publish?.attempt ?? 1;

  // ① 验证：在沙箱里跑一遍（详情与理由见 `pr.ts` 的 `verifyInSandbox`）。
  const verification =
    input.verify === undefined || input.verify === null
      ? null
      : await verifyInSandbox({
          api: input.api,
          target: input.target,
          cmd: input.verify.cmd,
          // 缺省在仓库目录里跑：沙箱的默认 cwd 是 workspace 根，`node test.js` 在那里
          // 会报 MODULE_NOT_FOUND——报出来的错与真正的原因隔一层（Phase 11 备注 4 同一条）。
          cwd: input.verify.cwd ?? repoDir,
          ...(input.verify.timeoutMs === undefined ? {} : { timeoutMs: input.verify.timeoutMs }),
          log,
          logContext: { runId: input.runId, sandboxId: input.sandboxId ?? null },
        });

  // ② 把沙箱的树取回 CP 的工作区（patch 应用 + 忠实效验；失败自动 archive 回退）。
  const changes = await collectSandboxChanges({
    api: input.api,
    target: input.target,
    clone: input.clone,
    repoPath: repoDir,
    log,
  });

  const publish = input.publish ?? null;
  if (publish === null) {
    const patchFile = input.patchOut === null || input.patchOut === undefined ? null : await copyPatch(changes, input.patchOut);
    return { changes, verification, patchFile, published: null, body: "", branch: null };
  }

  // ③ 发布。**先确认提交之前工作区里只有沙箱的改动**：这一步在 `publishRun` 里做完
  //    commit 之后还会再查一次（提交后必须干净）。
  const branch = publish.branch ?? branchNameForTask(input.taskId);
  const body = buildPullRequestBody({
    taskTitle: publish.taskTitle,
    issue: input.issue,
    runId: input.runId,
    attempt,
    model: input.model,
    stopReason: input.run.stopReason,
    stopDetail: input.run.detail,
    turns: input.run.turns,
    toolCalls: input.run.toolCalls,
    usage: input.run.usage,
    files: changes.files,
    verification,
    fallbackReason: changes.fallbackReason,
    transcriptUrl: publish.transcriptUrl ?? null,
    sandboxId: input.sandboxId ?? null,
  });

  const patchFile =
    input.patchOut === null || input.patchOut === undefined ? null : await copyPatch(changes, input.patchOut);

  const published = await publishRun({
    ref: publish.ref,
    dir: input.clone.dir,
    remoteUrl: publish.remoteUrl,
    branch,
    baseBranch: publish.baseBranch,
    title: `reuben-cloud: ${publish.taskTitle}`,
    body,
    token: publish.token,
    ...(publish.api === undefined ? {} : { api: publish.api }),
    ...(publish.draft === undefined ? {} : { draft: publish.draft }),
    ...(publish.expectedRemoteSha === undefined ? {} : { expectedRemoteSha: publish.expectedRemoteSha }),
    ...(publish.retry === undefined ? {} : { retry: publish.retry }),
    commit: {
      message: `reuben-cloud: ${publish.taskTitle}`,
      body: `run: ${input.runId}\nattempt: ${attempt}\n\n由 reuben-cloud 自动生成。`,
    },
    log,
  });

  return {
    changes,
    verification,
    patchFile,
    published,
    body,
    branch,
  };
}

/** 把 CP 侧那份权威 patch 复制到调用方要的位置（`collectSandboxChanges` 已经算好并落了盘）。 */
async function copyPatch(changes: CollectedChanges, dest: string): Promise<string> {
  const target = path.resolve(dest);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(changes.patch.file, target);
  return target;
}
