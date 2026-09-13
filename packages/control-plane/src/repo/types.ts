/**
 * repo/* 的公共契约：错误类型、仓库引用、沙箱接入点，以及 repo 层用到的那一小片
 * sandbox-agent 接口。
 *
 * 【为什么单独一个文件】六个模块（github-app / clone / pack / inject / apply / push）
 * 互相引用这几个类型。把它们塞进任何一个模块，都会造出"push 依赖 clone"这种假依赖——
 * 而这一层最该保住的结构性质是：**token 只在一个地方变成 argv**（`git.ts`），
 * 其它模块只传一个字符串。
 *
 * 【为什么 GitHub API 的失败与 git 的失败共用一个错误类型】与 ProviderError /
 * SandboxApiError 同一个做法：调用方按 `reason` 分支，不匹配字符串。而这两类失败
 * 本来就是同一条流水线上的两个环节（签发 token → clone → apply → push），
 * 拆成两个类型只会让 Phase 12 每次都要 catch 两次、然后按类型再分一次。
 */

import type { Readable } from "node:stream";
import type { AgentDiff, AgentExecOutcome, AgentFileWrite } from "../client/sandbox-api.ts";

export type RepoErrorReason =
  // ---- 配置与凭据（启动时就该暴露，不要等到第一次 clone）
  /** 环境变量不全（缺 appId / 私钥 / installationId）。 */
  | "config_missing"
  /** 私钥解不开、仓库引用不合法、url 不是 GitHub 形态。 */
  | "config_invalid"
  /** URL 里带了 userinfo（`https://token@…`）。这是红线：凭据只能是 `-c http.extraHeader`。 */
  | "credentials_in_url"
  /** clone 出来的 `.git/config` 里有 token / authorization / extraHeader 之类的东西。 */
  | "credentials_in_clone"
  // ---- GitHub API（token 签发）
  /** 连不上 api.github.com（超时、DNS、代理）。 */
  | "github_unreachable"
  /** 401：App JWT 或私钥不对。 */
  | "github_unauthorized"
  /** 403：installation 没有这个权限（`contents:write` 等），或对象不在授权范围内。 */
  | "github_forbidden"
  /** 404：这个仓库上没有安装这个 App。 */
  | "github_not_installed"
  /** 422：请求的权限/仓库名不被接受（比如 repositoryNames 里有非法的名字）。 */
  | "github_invalid_scope"
  /** 403/429 + retry-after：限流。带 `details.retryAfterMs`。 */
  | "github_rate_limited"
  /** 其他 GitHub API 错误。`details.status` / `details.body` 里有原文。 */
  | "github_api_error"
  // ---- git
  /** 找不到 git 可执行文件。 */
  | "git_unavailable"
  /** 超过时限（调用方给的 timeoutMs）。 */
  | "git_timeout"
  /** 输出超过上限（大仓库的 `git config -l`、异常巨大的 diff）。 */
  | "git_overflow"
  /** 别的 git 失败（非 0 退出，没有更具体的分类）。 */
  | "git_failed"
  | "clone_failed"
  | "checkout_failed"
  /** `rev-parse` 认不出请求的 commit/tag。 */
  | "unknown_commit"
  /** 目录不是 git 仓库（或仓库被 clone 坏了）。 */
  | "not_a_repository"
  /** `git apply --binary` 失败。 */
  | "apply_failed"
  /** apply 成功但重新算出来的 diff 与沙箱给的 patch sha256 不一致。 */
  | "patch_unfaithful"
  /** push 被拒（non-fast-forward / fetch first）。 */
  | "push_rejected"
  /** push 被 force-with-lease 拒（远端分支不是我们以为的那个 sha）。 */
  | "push_lease_rejected"
  /** 认证失败（token 过期/权限不足）。git 与 GitHub API 都会用这一条。 */
  | "auth_failed"
  /** 想推 protected 分支（main/master，或不在 `reuben-cloud/` 命名空间下的分支）。 */
  | "protected_branch"
  /** 没有任何改动可以提交（不造空 commit）。 */
  | "nothing_to_commit"
  // ---- 打包与沙箱交互
  /** tar 失败或找不到 tar。 */
  | "pack_failed"
  /** 沙箱里的内部命令（tar / rm / git rev-parse）非 0 退出。 */
  | "sandbox_command_failed"
  /** 灌进沙箱的字节数与 tar 的 sha256 对不上。 */
  | "sandbox_upload_mismatch"
  /** 解包之后沙箱里的 HEAD 不是我们要的 base commit。 */
  | "sandbox_head_mismatch";

/**
 * repo 层唯一的错误类型。`details` 进日志与审计，不进用户界面；
 * `status` 只在 GitHub API 失败时有值（Phase 12 要用它区分 404/403 的展示）。
 */
export class RepoError extends Error {
  readonly reason: RepoErrorReason;
  readonly details: Record<string, unknown>;
  readonly status: number | null;

  constructor(
    reason: RepoErrorReason,
    message: string,
    options: { status?: number | null; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "RepoError";
    this.reason = reason;
    this.status = options.status ?? null;
    this.details = options.details ?? {};
  }

  describe(): string {
    return `${this.reason}: ${this.message}`;
  }
}

/** `owner/repo`。**不含 host**：MVP 只有 github.com（§0.2 的边界）。 */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * 一个沙箱的接入点。repo/* 不查 DB、不认沙箱状态——调用方（Phase 11/12 的 run 流程）
 * 负责在 READY 的时候把这三样东西递进来。
 */
export interface SandboxTarget {
  endpoint: string;
  /** 沙箱的鉴权 token（provider 每次 create 现生成的那个，不是 GitHub token）。 */
  authToken: string;
  sandboxId?: string;
}

/**
 * repo/* 需要的 sandbox-agent 能力。`SandboxApiClient` 结构上就满足它（不需要
 * `implements`）——定义这个 port 不是为了可插拔，是为了让 apply/inject 的用例
 * 能在没有 Docker 的情况下，用一段假字节流把"patch 应用失败 → archive 回退"这条
 * 最重要的分支跑到。
 */
export interface RepoApi {
  putFile(
    endpoint: string,
    token: string,
    path: string,
    body: Readable,
    options?: { signal?: AbortSignal },
  ): Promise<AgentFileWrite>;
  execAndWait(
    endpoint: string,
    token: string,
    request: { cmd: string[]; cwd?: string; timeoutMs?: number },
    options?: { signal?: AbortSignal },
  ): Promise<AgentExecOutcome>;
  diff(
    endpoint: string,
    token: string,
    options?: { base?: string; path?: string; signal?: AbortSignal },
  ): Promise<AgentDiff>;
  readRaw(
    endpoint: string,
    token: string,
    path: string,
    options?: { offset?: number; limit?: number; signal?: AbortSignal },
  ): Promise<Readable>;
  readArchive(
    endpoint: string,
    token: string,
    options?: { exclude?: readonly string[]; signal?: AbortSignal },
  ): Promise<Readable>;
}
