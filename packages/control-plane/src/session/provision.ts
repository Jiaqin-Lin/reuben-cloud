/**
 * `session/provision.ts` —— 租约的两个**生产实现**：按需建沙箱、回收前落地（Phase 2 §6）。
 *
 * 【为什么单独一个文件（spec 的目标目录里没有它）】租约本身（`sandbox-lease.ts`）是纯策略：
 * 什么时候复用、什么时候回收、落地失败怎么办——它必须能在没有 Docker、没有 git、没有
 * 网络的情况下被完整测到（spec P2 的测试要点 11–20 全是这一类）。而"建沙箱"与"落地"
 * 是真动作：clone → 建容器 → 灌仓库；取 diff → apply → push。策略与动作分开之后，
 * 前者的测试是确定性的，后者的测试（集成）只跑一次完整路径。
 *
 * 【两个 port 的形状为什么这么窄】`provision` 只收"会话 + 起点 + 镜像"，只回三个字段；
 * `flush` 只收"沙箱怎么连 + 为什么落地"，只回"有没有改动、落到哪个 commit"。
 * 租约不需要知道 git 的存在，这个文件也不需要知道 TTL 的存在。
 */

import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { SandboxManager } from "../manager/sandbox-manager.ts";
import { cloneRepo } from "../repo/clone.ts";
import { collectSandboxChanges } from "../repo/apply.ts";
import { injectRepo } from "../repo/inject.ts";
import { commitAndPush } from "../repo/push.ts";
import type { RepoApi, SandboxTarget } from "../repo/types.ts";
import { REPO_DIR } from "@reuben-cloud/agent-runtime";import type { FlushRequest, FlushResult, LeaseSandboxInfo, LeaseSandboxPort, ProvisionedSandbox, SandboxProvisionRequest } from "./sandbox-lease.ts";

// ---------------------------------------------------------------- 沙箱读/销毁

/**
 * `SandboxManager` → `LeaseSandboxPort`。`get` 多带三个租约要用的字段
 * （state / created_at / last_active_at + endpoint/token），它们本来就在 `sandboxes` 行上。
 */
export function managerSandboxPort(manager: SandboxManager): LeaseSandboxPort {
  return {
    async get(sandboxId: string): Promise<LeaseSandboxInfo | null> {
      const row = await manager.getSandbox(sandboxId);
      if (row === null) return null;
      return {
        sandboxId: row.id,
        state: row.state,
        endpoint: row.endpoint,
        authToken: row.auth_token,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
      };
    },
    async destroy(sandboxId: string, reason: string): Promise<void> {
      // 幂等：manager 已经处理了"行不在了"（抛 sandbox_missing）——对租约来说
      // "早就没了"和"刚删掉"是同一个结果，不该让回收循环记一次失败。
      try {
        await manager.destroySandbox(sandboxId, reason);
      } catch (error) {
        if ((error as { reason?: string }).reason === "sandbox_missing") return;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------- 按需建

export interface SandboxProvisionerOptions {
  manager: SandboxManager;
  api: RepoApi;
  /** clone 地址（不含凭据）与取 token 的函数（本地仓库时 token 返回 null）。 */
  repo: { url: string; token: () => Promise<string | null> };
  /** 仓库在沙箱里的落点；缺省 `REPO_DIR`（与工具层、提示词同一个常量）。 */
  workspaceDir?: string;
  log?: LogFn;
}

/**
 * 建一个沙箱并把仓库灌进去。**顺序是设计的一部分**：
 *   ① 先在 CP 侧 clone 到起点（失败时还什么都没建，代价最小）；
 *   ② 建容器（DB 先写一行 CREATING，见 manager）；
 *   ③ 灌仓库（失败时容器已经在了——留给租约/`finally` 的销毁路径，不静默丢容器）。
 */
export function createSandboxProvisioner(
  options: SandboxProvisionerOptions,
): (request: SandboxProvisionRequest) => Promise<ProvisionedSandbox> {
  const log = options.log ?? noopLog;
  const workspaceDir = options.workspaceDir ?? REPO_DIR;

  return async (request) => {
    const { session } = request;
    // 会话的 clone 落在自己的目录里（不是某次 Run 的目录）：热着复用期间它要能反复用。
    const clone = await cloneRepo({
      runId: sessionCloneId(session.id),
      url: options.repo.url,
      commit: request.startCommit,
      token: await options.repo.token(),
      log,
    });
    log("info", `会话 ${session.id} 的 CP 工作区已就绪`, { dir: clone.dir, startCommit: clone.baseSha });

    const sandbox = await options.manager.createSandbox({
      runId: request.runId,
      // 沙箱归属**会话**（Phase 2 的 ALTER 那一列）。
      sessionId: session.id,
      ...(session.taskId === null ? {} : { taskId: session.taskId }),
      image: request.image,
    });
    const target: SandboxTarget = {
      endpoint: sandbox.endpoint ?? "",
      authToken: sandbox.authToken ?? "",
      sandboxId: sandbox.sandboxId,
    };
    if (target.endpoint === "" || target.authToken === "") {
      throw new Error(`沙箱 ${sandbox.sandboxId} 建好了但没有 endpoint/token`);
    }
    await injectRepo({ api: options.api, target, clone, workspaceDir, log });
    log("info", `会话 ${session.id} 的仓库已灌入沙箱 ${sandbox.sandboxId}`, {
      startCommit: clone.baseSha,
      headRef: request.headRef,
    });
    return { sandboxId: sandbox.sandboxId, endpoint: target.endpoint, authToken: target.authToken };
  };
}

// ---------------------------------------------------------------- 回收前落地

export interface SandboxFlusherOptions {
  api: RepoApi;
  /** clone 地址（不含凭据）与取 token 的函数。 */
  repo: { url: string; token: () => Promise<string | null> };
  /** 工作分支。缺省 `reuben-cloud/<taskId>`（由调用方算好给进来，避免这里依赖 taskId 的拼法）。 */
  branch: string;
  /** commit/PR 上的题面（缺省用会话 id）。 */
  title?: string;
  log?: LogFn;
}

/**
 * 回收前的落地：**取 diff → apply 到 CP 的树 → commit → push**。
 *
 * 【为什么每次 flush 都重新 clone】CP 侧那份工作区可能是上一次 flush 留下的（旧 head）、
 * 也可能根本没建过（会话在第一轮就被回收）。重新 clone 到 `head_commit` 是唯一"不管之前
 * 发生过什么都对"的起点，代价是一次 clone——flush 的频率是"空闲 TTL 一次"，
 * 不是热路径。
 *
 * 【没有改动就不推】`changed: false`。空 commit 会污染任务分支的历史，
 * 也让"这条分支上有几次真正的产出"变得不可数。
 */
export function createSandboxFlusher(options: SandboxFlusherOptions): (request: FlushRequest) => Promise<FlushResult> {
  const log = options.log ?? noopLog;

  return async (request) => {
    const { session } = request;
    const start = session.headCommit ?? session.baseCommit;
    const clone = await cloneRepo({
      runId: sessionCloneId(session.id),
      url: options.repo.url,
      commit: start,
      token: await options.repo.token(),
      log,
    });
    const target: SandboxTarget = {
      endpoint: request.endpoint,
      authToken: request.authToken,
      sandboxId: request.sandboxId,
    };
    const changes = await collectSandboxChanges({ api: options.api, target, clone, repoPath: REPO_DIR, log });
    if (changes.files.length === 0) {
      log("info", `会话 ${session.id} 没有改动，跳过推送`, { sandboxId: request.sandboxId, reason: request.reason });
      return { changed: false, headCommit: null, headRef: null };
    }

    const pushed = await commitAndPush({
      dir: clone.dir,
      url: options.repo.url,
      branch: options.branch,
      message: `reuben-cloud: ${options.title ?? `会话 ${session.id}`}`,
      body: `session: ${session.id}\nsandbox: ${request.sandboxId}\nreason: ${request.reason}\n\n由 reuben-cloud 自动落地。`,
      token: await options.repo.token(),
      log,
    });
    log("info", `会话 ${session.id} 的改动已落地到 ${pushed.branch}`, {
      commit: pushed.commitSha,
      files: changes.files.length,
      reason: request.reason,
    });
    return { changed: true, headCommit: pushed.commitSha, headRef: pushed.branch };
  };
}

// ---------------------------------------------------------------- 小工具

/**
 * 会话级 clone 用的目录名。用 `runDirOf` 的命名空间（`/tmp/reuben-cloud-cp/<id>/repo`），
 * 但 id 是会话而不是 Run——`ses_<ulid>` 恰好满足它的字符集限制（字母数字与 `._-`）。
 */
export function sessionCloneId(sessionId: string): string {
  return sessionId;
}
