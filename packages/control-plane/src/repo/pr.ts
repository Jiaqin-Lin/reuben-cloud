/**
 * `pr.ts` —— Phase 12：把一次 Run 的产出变成一条 PR。
 *
 * 【这条链路的三段，各自守一件事】
 *  ① **验证**（`verifyInSandbox`）：在沙箱销毁之前把"测试跑过没有、结果是什么"变成
 *     结构化事实。agent 自己说"测试通过了"不算证据，跑一遍才算——PR 正文里的那一行
 *     必须是可复查的实数（还是 §K 第 10 步"可信度报告"的雏形）。
 *  ② **发布**（`publishRun`）：commit → push → 建 PR。push 的 CAS 保护在 `push.ts`；
 *     这里补的是"提交之后工作区必须真的干净"（见 `assertCleanWorktree`）与"PR 幂等"。
 *  ③ **PR 本身**（`findOrCreatePullRequest`）：一个 Task 一条分支一条 PR。重跑是更新，
 *     不是再开一条——分支被 `--force-with-lease` 覆盖，PR 被 PATCH 覆盖，attempt 递增。
 *
 * 【为什么有一个 `PullRequestApi` port 而不是直接调 Octokit】两个理由，都不是"可插拔"：
 *  · 单元测试要在**没有网络、没有 GitHub App** 的情况下把幂等、base 变更、限流重试、
 *    权限错误分类跑完（`npm test` 不碰网络的硬要求）；
 *  · "什么时候调 API"（幂等判定、重试策略、正文内容）与"怎么调"（HTTP 细节、
 *    token 放哪）是两类会各自演进的东西。port 只有三个方法，Octokit 实现不到 100 行。
 *
 * 【为什么默认 draft】（附录 A-13）draft 明确表示"等人工确认"，也不会自动触发评审请求。
 * 这是产品决策而不是技术限制，所以它是一个显式参数、默认 true。
 *
 * 【为什么正文是模板而不是让模型写】MVP 的正文要的是**可核对**：文件数、+/-、测试命令与
 * 退出码、模型名、run / attempt、transcript 链接。这些都是实数，模板拼出来就是对的；
 * 让模型再写一遍只会引入"和事实不符"的可能。完整版的"可信度报告"是 M1。
 *
 * 【为什么不做 `--force`】`push.ts` 只做 `--force-with-lease`，且 lease 的期望值来自
 * 服务端刚读到的 sha（真正的 compare-and-swap）。第三方改过那条分支时 push 会被拒，
 * 这里把它如实报告并停止——用户手动改过的分支不能被静默覆盖。
 */

import { Octokit } from "@octokit/rest";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { AgentExecOutcome } from "../client/sandbox-api.ts";
import { gitOrThrow, retryTransientGit, runGit, tokenAuthArgs } from "./git.ts";
import { DEFAULT_AUTHOR, commitAndPush, lsRemoteSha } from "./push.ts";
import type { PushResult } from "./push.ts";
import { RepoError } from "./types.ts";
import type { RepoApi, RepoRef, SandboxTarget } from "./types.ts";

// ---------------------------------------------------------------- 常量

/** 默认 draft（附录 A-13）。 */
export const DEFAULT_DRAFT = true;

/**
 * PR 正文上限。GitHub 的硬限制是 65536 个字符，留一点余量。
 * 超了必须**截断**而不是让 API 报 422——正文是给人看的，缺最后几行远比"PR 建不出来"好。
 */
export const PR_BODY_MAX_CHARS = 60_000;

/** 限流重试次数（spec：最多 3 次）。 */
export const RATE_LIMIT_MAX_RETRIES = 3;

/** 没有 `retry-after` 头时的兜底等待。 */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;

/**
 * 单次等待的上限。超过它就不等了、直接如实报告。
 * 理由：主限流的 reset 可能在一小时之后，把 CP 挂在那里睡一小时既占着 Run 的墙钟预算，
 * 也让"为什么没动静"变成一个没人看得见的黑洞。等待的判据是 `retry-after`（秒级），
 * 那是 GitHub 对**次要限流**的标准答案，也是我们唯一该自动等的那种。
 */
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/**
 * 远端分支检查的两个时限。**不跟 push 的 180s 共用**：
 * `ls-remote` 是几十字节的查询、`fetch` 只取一个 commit，而弱网下一篇都要反复重试——
 * 拿 180s 去等它们，一次发布就会被拖成十几分钟（真跑 GitHub 时踩到过）。
 */
export const REMOTE_INSPECT_LS_TIMEOUT_MS = 15_000;
export const REMOTE_INSPECT_FETCH_TIMEOUT_MS = 30_000;

/** 验证命令的默认时限。跑一套单测的量级。 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

/** 验证输出收下来的上限（从**头部**收，见 `verifyInSandbox` 的注释）。 */
export const DEFAULT_VERIFY_CAPTURE_BYTES = 256 * 1024;

/** PR 正文里列出的文件个数上限（几百个文件的 PR，正文列全了也没人看）。 */
export const MAX_BODY_FILES = 50;

// ---------------------------------------------------------------- PR 记录与 port

/** 我们关心的 PR 字段。**故意只留这些**：多一个字段就多一处"GitHub 改了名字"的风险。 */
export interface PullRequestRecord {
  number: number;
  htmlUrl: string;
  state: string;
  draft: boolean;
  title: string;
  body: string;
  /** `owner:branch`（GitHub 的 `head.label`）。 */
  head: string;
  /** base 分支名。 */
  base: string;
}

export interface CreatePullRequestInput {
  /** 分支名（不含 owner）。 */
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface UpdatePullRequestInput {
  number: number;
  title?: string;
  body?: string;
  base?: string;
}

/**
 * GitHub PR 的三个动作 + 一个查询。**只有这些**——不做 review、不做 merge、不做评论
 * （§Phase 12 技术边界：不合并 PR、不做审批流）。
 */
export interface PullRequestApi {
  /** `state=open` 且 head 命中的 PR（通常 0 或 1 条）。 */
  listOpenByHead(ref: RepoRef, head: string): Promise<PullRequestRecord[]>;
  create(ref: RepoRef, input: CreatePullRequestInput): Promise<PullRequestRecord>;
  update(ref: RepoRef, input: UpdatePullRequestInput): Promise<PullRequestRecord>;
  /** 仓库的默认分支（PR 的 base）。**问远端，不猜 main/master**。 */
  getDefaultBranch(ref: RepoRef): Promise<string>;
}

// ---------------------------------------------------------------- Octokit 实现

export interface OctokitPullRequestApiOptions {
  token: string;
  /** 覆盖 API 端点（GitHub Enterprise / 测试用假服务器）。 */
  baseUrl?: string;
  /** 注入客户端（测试用；给了就忽略 token / baseUrl）。 */
  client?: Octokit;
}

/**
 * 真的 GitHub。**薄**：只做字段搬移与错误分类，逻辑全在 port 的调用方。
 *
 * Octokit 的 `RequestError` 带 `status` 与 `response.headers`——限流与权限判定全靠它们，
 * 所以这里不解析 message 文本（Phase 9 的 `mapGithubError` 是同一个做法）。
 */
export class OctokitPullRequestApi implements PullRequestApi {
  readonly #client: Octokit;

  constructor(options: OctokitPullRequestApiOptions) {
    this.#client =
      options.client ??
      new Octokit({
        auth: options.token,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      });
  }

  async listOpenByHead(ref: RepoRef, head: string): Promise<PullRequestRecord[]> {
    const response = await this.#call(ref, () =>
      this.#client.rest.pulls.list({
        owner: ref.owner,
        repo: ref.repo,
        state: "open",
        head: `${ref.owner}:${head}`,
        per_page: 100,
      }),
    );
    return response.data.map((item) => toRecord(item));
  }

  async create(ref: RepoRef, input: CreatePullRequestInput): Promise<PullRequestRecord> {
    const response = await this.#call(ref, () =>
      this.#client.rest.pulls.create({
        owner: ref.owner,
        repo: ref.repo,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        draft: input.draft,
      }),
    );
    return toRecord(response.data);
  }

  async update(ref: RepoRef, input: UpdatePullRequestInput): Promise<PullRequestRecord> {
    const response = await this.#call(ref, () =>
      this.#client.rest.pulls.update({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: input.number,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.base === undefined ? {} : { base: input.base }),
      }),
    );
    return toRecord(response.data);
  }

  async #call<T>(ref: RepoRef, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw mapPullRequestError(error, ref);
    }
  }

  async getDefaultBranch(ref: RepoRef): Promise<string> {
    const response = await this.#call(ref, () =>
      this.#client.rest.repos.get({ owner: ref.owner, repo: ref.repo }),
    );
    const branch = asRecord(response.data)["default_branch"];
    if (typeof branch !== "string" || branch === "") {
      throw new RepoError("pr_api_error", `GitHub 没有给出 ${ref.owner}/${ref.repo} 的默认分支`, {
        details: { repo: `${ref.owner}/${ref.repo}` },
      });
    }
    return branch;
  }
}

/** GitHub 的响应 → 我们的记录。字段缺失时给安全兜底（不猜、不抛）。 */
function toRecord(data: unknown): PullRequestRecord {
  const record = asRecord(data);
  const head = asRecord(record["head"]);
  const base = asRecord(record["base"]);
  return {
    number: typeof record["number"] === "number" ? record["number"] : 0,
    htmlUrl: typeof record["html_url"] === "string" ? record["html_url"] : "",
    state: typeof record["state"] === "string" ? record["state"] : "open",
    draft: record["draft"] === true,
    title: typeof record["title"] === "string" ? record["title"] : "",
    body: typeof record["body"] === "string" ? record["body"] : "",
    head: typeof head["label"] === "string" ? head["label"] : String(head["ref"] ?? ""),
    base: typeof base["ref"] === "string" ? base["ref"] : "",
  };
}

/**
 * GitHub API 的失败 → `RepoError`。分类的价值在于**使用者的下一步动作不同**：
 *  · `pr_permission_denied` → 去给 App 补 `pull_requests:write`（spec 要求"报告缺哪个权限"）；
 *  · `pr_rate_limited` → 带着 `retryAfterMs` 等一等重试（`retryOnRateLimit` 会消费它）；
 *  · `pr_not_found` → 仓库被删 / App 被卸载 / token 没有仓库范围；
 *  · `pr_conflict` → 请求本身不合法（base 分支不存在、head 与 base 相同…）。
 */
export function mapPullRequestError(error: unknown, ref: RepoRef): RepoError {
  if (error instanceof RepoError) return error;
  const record = asRecord(error);
  const status = typeof record["status"] === "number" ? record["status"] : null;
  const message = typeof record["message"] === "string" ? record["message"] : String(error);
  const response = asRecord(record["response"]);
  const headers = asRecord(response["headers"]);
  const context = { repo: `${ref.owner}/${ref.repo}`, status };

  if (status === null) {
    return new RepoError("github_unreachable", `连不上 GitHub API：${message}`, { details: context });
  }
  if (status === 401) {
    return new RepoError("github_unauthorized", `GitHub App 认证失败（401）：${message}`, { status, details: context });
  }
  if (status === 404) {
    return new RepoError("pr_not_found", `仓库或 PR 不可见（404）：${message}`, { status, details: context });
  }
  if (status === 422) {
    return new RepoError("pr_conflict", `GitHub 拒绝了这次 PR 变更（422）：${message}`, { status, details: context });
  }
  if (status === 403 || status === 429) {
    const retryAfterMs = retryAfterMillis(headers);
    const remaining = headers["x-ratelimit-remaining"];
    if (retryAfterMs !== null || remaining === "0" || /rate limit/i.test(message)) {
      return new RepoError("pr_rate_limited", `GitHub 限流（${status}）：${message}`, {
        status,
        details: { ...context, retryAfterMs, required: { pull_requests: "write" } },
      });
    }
    return new RepoError("pr_permission_denied", `installation 缺少 pull_requests:write（403）：${message}`, {
      status,
      details: { ...context, required: { pull_requests: "write" } },
    });
  }
  return new RepoError("pr_api_error", `GitHub API 返回 ${status}：${message}`, { status, details: context });
}

/**
 * 从响应头算"该等多久"。`retry-after`（秒）优先；没有就看主限流的 `x-ratelimit-reset`
 * （epoch 秒）。两个都没有 → 兜底等待（`DEFAULT_RATE_LIMIT_WAIT_MS`），而不是立刻重试——
 * 立刻重试在限流场景下只会把 403 变成一串 403。
 */
export function retryAfterMillis(headers: Record<string, unknown>, nowMs = Date.now()): number | null {
  const raw = headers["retry-after"];
  if (typeof raw === "string" || typeof raw === "number") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  const reset = headers["x-ratelimit-reset"];
  if (typeof reset === "string" || typeof reset === "number") {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(0, epochSeconds * 1000 - nowMs);
    }
  }
  return null;
}

// ---------------------------------------------------------------- 限流重试

export interface RetryOptions {
  maxRetries?: number;
  /** 注入 sleep（测试把它换成"记下来、立刻返回"）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 覆盖单次等待上限（测试用）。 */
  maxWaitMs?: number;
  log?: LogFn;
}

/** 等待时长的决定权在这一处：`RepoError.pr_rate_limited` 之外的一律不等。 */
export function rateLimitWaitMs(error: unknown, options: RetryOptions = {}): number | null {
  if (!(error instanceof RepoError) || error.reason !== "pr_rate_limited") return null;
  const declared = error.details["retryAfterMs"];
  const waitMs =
    typeof declared === "number" && Number.isFinite(declared) ? declared : DEFAULT_RATE_LIMIT_WAIT_MS;
  const limit = options.maxWaitMs ?? MAX_RATE_LIMIT_WAIT_MS;
  // 等待超过上限时返回 null = "不要重试"，把原始错误原样抛给调用方（它带着 retryAfterMs，
  // 报告里能说清"什么时候再来"）。睡一小时不是重试，是挂死。
  return waitMs <= limit ? Math.max(0, waitMs) : null;
}

/**
 * 限流时按 `retry-after` 等待重试，最多 `maxRetries` 次。
 * **只吃限流错误**：其余错误立刻上抛（权限不足重试一百次还是权限不足）。
 */
export async function retryOnRateLimit<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const log = options.log ?? noopLog;
  const maxRetries = options.maxRetries ?? RATE_LIMIT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const waitMs = rateLimitWaitMs(error, options);
      if (waitMs === null || attempt >= maxRetries) throw error;
      log("warn", `GitHub 限流，等 ${Math.round(waitMs / 1000)}s 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
      await sleep(waitMs);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------- 幂等的建 PR

export interface FindOrCreatePullRequestInput {
  api: PullRequestApi;
  ref: RepoRef;
  /** head 分支名（不含 owner）。 */
  branch: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  retry?: RetryOptions;
  log?: LogFn;
}

export interface FindOrCreatePullRequestResult {
  pullRequest: PullRequestRecord;
  /** true = 这次真的新建了；false = 更新了已存在的那条。 */
  created: boolean;
  /** 已存在的 PR 的 base 与这次请求不一致，把它改过来了。 */
  baseUpdated: boolean;
}

/**
 * 有就更新、没有就创建（§3 的幂等语义）。
 *
 * 判定顺序：`GET /pulls?head=owner:branch&state=open` → 命中就 PATCH，没有就 POST。
 * 命中多条时取第一条并记一条警告——那说明有人手工建过 PR，而我们只维护这一条。
 *
 * **base 变了就更新 base，而不是重建**：重建会在仓库里留下一条关掉的 PR 和一个
 * 新编号，review 的历史就断了（spec 的失败模式表里专门有一条）。title / body 同理：
 * 只在真的不同时才 PATCH（少一次写操作，也少一份"为什么正文被改了"的噪音）。
 */
export async function findOrCreatePullRequest(
  input: FindOrCreatePullRequestInput,
): Promise<FindOrCreatePullRequestResult> {
  const log = input.log ?? noopLog;
  const draft = input.draft ?? DEFAULT_DRAFT;
  const call = <T>(fn: () => Promise<T>): Promise<T> => retryOnRateLimit(fn, { ...input.retry, log });

  const open = await call(() => input.api.listOpenByHead(input.ref, input.branch));
  if (open.length > 1) {
    log("warn", `分支 ${input.branch} 上有 ${open.length} 条打开的 PR，只维护第一条`, {
      numbers: open.map((item) => item.number),
    });
  }
  const existing = open[0] ?? null;
  if (existing === null) {
    const created = await call(() =>
      input.api.create(input.ref, {
        head: input.branch,
        base: input.base,
        title: input.title,
        body: input.body,
        draft,
      }),
    );
    log("info", `已创建 PR #${created.number}（draft=${created.draft}）`, {
      url: created.htmlUrl,
      branch: input.branch,
      base: input.base,
    });
    return { pullRequest: created, created: true, baseUpdated: false };
  }

  const patch: UpdatePullRequestInput = { number: existing.number };
  if (existing.title !== input.title) patch.title = input.title;
  if (existing.body !== input.body) patch.body = input.body;
  const baseUpdated = existing.base !== input.base;
  if (baseUpdated) patch.base = input.base;
  if (patch.title === undefined && patch.body === undefined && patch.base === undefined) {
    return { pullRequest: existing, created: false, baseUpdated: false };
  }
  const updated = await call(() => input.api.update(input.ref, patch));
  log("info", `已更新 PR #${updated.number}（base ${baseUpdated ? `${existing.base} → ${input.base}` : "未变"}）`, {
    url: updated.htmlUrl,
  });
  return { pullRequest: updated, created: false, baseUpdated };
}

// ---------------------------------------------------------------- 验证

/**
 * 一次验证运行的结果。**这是 PR 正文里"测试结果"的唯一来源**。
 */
export interface RunVerification {
  cmd: string[];
  /** 沙箱终态：completed / failed / timeout / killed。 */
  state: string;
  exitCode: number | null;
  /** 只认"跑完了且退出码 0"。被超时杀掉、启动失败（failed）都不算通过。 */
  passed: boolean;
  durationMs: number | null;
  /** 输出的尾部（见 `tailForReport`）。 */
  outputTail: string;
  /** 输出被沙箱截断（完整内容在沙箱日志里；沙箱销毁后失效）。 */
  truncated: boolean;
}

export interface VerifyInSandboxInput {
  api: RepoApi;
  target: SandboxTarget;
  cmd: string[];
  cwd?: string;
  timeoutMs?: number;
  maxCaptureBytes?: number;
  log?: LogFn;
  logContext?: { runId?: string | null; sandboxId?: string | null };
}

/**
 * 在沙箱里跑一条验证命令（一般是仓库自己的测试命令）并拿回结构化结果。
 *
 * 【为什么 agent 跑过了还要再跑一次】agent 说"测试通过"是一句话，而 PR 正文里的那一行
 * 必须是一份可复查的证据。再跑一次的代价是一条 exec，换来的是"这条 PR 声称通过的那个
 * 命令，在**产出这次 diff 的那棵树上**真的通过"。
 *
 * 【输出是"头部捕获 + 尾部呈现"】`execAndWait` 的 `maxCaptureBytes` 是从**头部**收的
 * （事件流顺序读），而人只看尾部。所以收 256 KiB、报告时取最后 20 行。输出超过捕获上限
 * 时 `truncated` 为真，正文会如实标注。真要看全文得在沙箱销毁前用 `/files?offset=`
 * 读日志——MVP 不为它加一条路径（§Phase 11 的 `bash` 工具已经是那条路径）。
 */
export async function verifyInSandbox(input: VerifyInSandboxInput): Promise<RunVerification> {
  const log = input.log ?? noopLog;
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const outcome: AgentExecOutcome = await input.api.execAndWait(
    input.target.endpoint,
    input.target.authToken,
    {
      cmd: input.cmd,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      timeoutMs,
    },
    { maxCaptureBytes: input.maxCaptureBytes ?? DEFAULT_VERIFY_CAPTURE_BYTES },
  );
  const passed = outcome.state === "completed" && outcome.exitCode === 0;
  const outputTail = tailForReport(combineStreams(outcome));
  log(passed ? "info" : "warn", `验证命令${passed ? "通过" : "没有通过"}：${input.cmd.join(" ")}`, {
    state: outcome.state,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    ...input.logContext,
  });
  return {
    cmd: input.cmd,
    state: outcome.state,
    exitCode: outcome.exitCode,
    passed,
    durationMs: outcome.durationMs,
    outputTail,
    truncated: outcome.truncated,
  };
}

/** stdout + stderr。日志文件里两者本来就是交错的，这里退一步用分隔线拼（见 §Phase 11 §5.5）。 */
function combineStreams(outcome: AgentExecOutcome): string {
  if (outcome.stderr.trim() === "") return outcome.stdout;
  if (outcome.stdout.trim() === "") return outcome.stderr;
  return `${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`;
}

/**
 * 报告用的尾部：最后 N 行、每行截断、总长封顶。**不做行级的"不返回半行"**——
 * 这是给人看的报告，不是给模型的 tool_result（那条规矩在 `tools/truncate.ts`）。
 */
export function tailForReport(text: string, options: { lines?: number; maxChars?: number } = {}): string {
  const maxLines = options.lines ?? 20;
  const maxChars = options.maxChars ?? 4 * 1024;
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim() !== "");
  const tail = lines.slice(Math.max(0, lines.length - maxLines));
  const clipped = tail.map((line) => (line.length > 500 ? `${line.slice(0, 500)}…` : line));
  let joined = clipped.join("\n");
  if (joined.length > maxChars) joined = joined.slice(joined.length - maxChars);
  return joined;
}

// ---------------------------------------------------------------- 工作区校验

export interface WorktreeStatus {
  clean: boolean;
  /** `git status --porcelain` 的每一行（去掉行尾换行）。 */
  entries: string[];
}

/** 问一次工作区脏不脏。**不加任何猜**：porcelain 为空就是干净。 */
export async function worktreeStatus(dir: string): Promise<WorktreeStatus> {
  const result = await runGit(["-C", dir, "status", "--porcelain"]);
  if (result.spawnError !== null) {
    throw new RepoError("git_unavailable", `git 起不来：${result.spawnError.message}`, { details: { dir } });
  }
  if (result.timedOut) {
    throw new RepoError("git_timeout", `git status 超过时限没有结束`, { details: { dir } });
  }
  if (result.code !== 0) {
    throw new RepoError("not_a_repository", `git status 失败：${result.stderr.toString("utf8").trim()}`, {
      details: { dir, exitCode: result.code },
    });
  }
  const entries = result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  return { clean: entries.length === 0, entries };
}

/**
 * 提交之后工作区必须真的干净（spec Phase 12 §1：`git status --porcelain` 为空）。
 *
 * 【为什么把时机放在 commit **之后**】`commitAndPush` 是 `git add -A` + commit，
 * 它提交的正是我们要推的那份改动；此时工作区**应该**没有剩下的东西。还脏只有一个解释：
 * 提交之后又有东西改了这棵树（CP 自己的临时文件、残留进程、外部写入）。那种状态下
 * 建出来的 PR 描述的是一个已经不成立的 commit，所以宁可不建。
 *
 * 报告里只列前 20 条：脏的原因通常只有一两条，把整个 `git status` 塞进错误里
 * 会把它埋掉。
 */
export async function assertCleanWorktree(dir: string): Promise<void> {
  const status = await worktreeStatus(dir);
  if (status.clean) return;
  throw new RepoError("dirty_worktree", `提交之后工作区仍不干净（${status.entries.length} 项），拒绝建 PR`, {
    details: { dir, entries: status.entries.slice(0, 20) },
  });
}

// ---------------------------------------------------------------- 分支归属

/** 我们推的 commit 用的 committer 邮箱（与 `push.ts` 的 `DEFAULT_AUTHOR` 同源）。 */
export const OUR_COMMITTER_EMAIL = DEFAULT_AUTHOR.email;

export interface RemoteBranchInspection {
  /** 远端有没有这条分支。 */
  exists: boolean;
  /** 分支 tip 的 sha（不存在就是 null）。 */
  sha: string | null;
  /** tip 那个 commit 的 committer 邮箱（不存在就是 null）。 */
  committerEmail: string | null;
}

export interface InspectRemoteBranchInput {
  /** 本地 clone 的目录（fetch 进它的 object store，用完就丢）。 */
  dir: string;
  url: string;
  branch: string;
  token?: string | null;
  /** `ls-remote` 的时限，缺省 15s（见 `REMOTE_INSPECT_LS_TIMEOUT_MS`）。 */
  timeoutMs?: number;
  log?: LogFn;
}

/**
 * 看远端那条分支的 tip 现在是谁的提交。
 *
 * 【为什么需要这一步】`--force-with-lease` 比较的是"我读到的 sha"与"推送那一刻的 sha"，
 * 它只能防**读与推之间的并发写**。重复 Run 的场景里更早的问题在它之前：分支上的 tip
 * 可能根本不是我们上一次推的（用户手工把 commit 推上去了），而"推之前现读一次远端"
 * 会把这种状态当成合法预期值，然后**静默覆盖掉用户的提交**。所以推之前必须多问一句：
 * 这个 tip 是不是我们自己的（committer 是 bot 身份）。
 *
 * 【为什么不查"上次推的 sha"】那个值需要跨 Run 持久化（`sandboxes` 表里没有它，而
 * tasks / runs 表是 M3）。committer 身份判断**不需要任何持久化**，而且语义更宽：
 * 连"用户在我们推完之后手工 commit 上来"这种非 force 的情况也一起挡了——
 * 那种情况下 sha 变了、分支仍能 fast-forward，光靠 lease 是拦不住的。
 *
 * 【为什么用 FETCH_HEAD 而不是建一个 remote-tracking ref】只取这一个 commit 的对象图，
 * 不建任何 ref，不污染 clone 的引用空间（它只是这次 Run 的临时物）。
 */
export async function inspectRemoteBranch(input: InspectRemoteBranchInput): Promise<RemoteBranchInspection> {
  const log = input.log ?? noopLog;
  const sha = await lsRemoteSha(input.url, input.branch, input.token, input.timeoutMs ?? REMOTE_INSPECT_LS_TIMEOUT_MS, { log });
  if (sha === null) return { exists: false, sha: null, committerEmail: null };

  // fetch 与 ls-remote 同属"只读的远端操作"，同样会因为弱网挂住（真跑 GitHub 时踩到过），
  // 所以走同一套重试。
  const email = await retryTransientGit(
    async () => {
      await gitOrThrow(
        [
          ...tokenAuthArgs(input.token),
          "-C",
          input.dir,
          "fetch",
          "--quiet",
          "--no-tags",
          input.url,
          `refs/heads/${input.branch}`,
        ],
        {
          reason: "git_failed",
          context: { branch: input.branch, step: "inspect-remote-branch" },
          timeoutMs: REMOTE_INSPECT_FETCH_TIMEOUT_MS,
        },
      );
      return (
        await gitOrThrow(["-C", input.dir, "log", "-1", "--format=%ce", "FETCH_HEAD"], {
          reason: "git_failed",
          context: { branch: input.branch, step: "inspect-remote-branch" },
        })
      ).trim();
    },
    { log, describe: `fetch ${input.branch}` },
  );
  return { exists: true, sha, committerEmail: email };
}

// ---------------------------------------------------------------- 发布（收尾流程）

export interface PublishRunInput {
  ref: RepoRef;
  /** clone 在 CP 上的工作区，**改动已经应用在里面**（`collectSandboxChanges` 之后）。 */
  dir: string;
  /** 远端地址，不含凭据。 */
  remoteUrl: string;
  /** head 分支名（`branchNameForTask()` 的产物）。 */
  branch: string;
  /** base 分支（仓库的默认分支）。 */
  baseBranch: string;
  title: string;
  body: string;
  /**
   * 取 installation token。**每次调用都走 `GithubAppCredentials`**（它带提前 5 分钟的
   * 续签）——push 与建 PR 各取一次，中间可能隔着一次很慢的 push，所以不能共用一把。
   */
  token: () => Promise<string>;
  commit?: { message: string; body?: string; author?: { name: string; email: string } };
  /** 注入 PR API（测试给假的；生产 undefined = 真 Octokit，用刚签发的 token）。 */
  api?: PullRequestApi;
  /** 注入 API 工厂（生产不用；它存在的意义是"用哪把 token 建客户端"这件事可被测试替换）。 */
  apiFactory?: (token: string) => PullRequestApi;
  draft?: boolean;
  retry?: RetryOptions;
  /**
   * 显式指定 force-with-lease 的期望值。缺省 = 推之前现读并**校验归属**
   * （见 `inspectRemoteBranch`）。测试用它模拟"远端已经不是那个 sha 了"。
   */
  expectedRemoteSha?: string | null;
  /** push 的时限（不覆盖远端检查那两个短时限）。 */
  timeoutMs?: number;
  log?: LogFn;
}

export interface PublishRunResult {
  push: PushResult;
  pullRequest: PullRequestRecord;
  created: boolean;
  baseUpdated: boolean;
  /** `git status --porcelain` 在提交之后为空（不干净时这里不会有结果——会直接抛）。 */
  worktreeClean: true;
}

/**
 * Run 的收尾：commit → push → 建/更新 PR。**Phase 12 的全部接线就是这一个函数**。
 *
 * 顺序不能乱，每一步都在给下一步提供前提：
 *  ① token（现签，push 用）→ ② **确认远端分支的 tip 是不是我们的**（不是就拒绝覆盖）→
 *  ③ commit + force-with-lease push → ④ 工作区必须干净 → ⑤ token（再签一次，可能已经续过）→
 *  ⑥ 幂等地建/更新 PR。
 *
 * 失败时的语义：任何一步抛出的都是带 `reason` 的 `RepoError`，调用方按 reason 分支
 * （`branch_owned_by_others` = 有人在我们的分支上动过；`pr_permission_denied` = 缺权限；
 * `nothing_to_commit` = 这次 Run 没有产出）。**没有一步会静默降级**。
 */
export async function publishRun(input: PublishRunInput): Promise<PublishRunResult> {
  const log = input.log ?? noopLog;
  const commit = input.commit ?? { message: input.title };
  const author = commit.author ?? DEFAULT_AUTHOR;

  // ① push 用的 token：现签（缓存命中也没关系，它保证不早于 5 分钟过期）。
  const pushToken = await input.token();

  // ② 远端那条分支上是不是我们自己的提交。
  // 这里**不**透 input.timeoutMs：那是 push 的预算，而远端检查有自己的短时限
  // （见 REMOTE_INSPECT_* 常量的注释）。
  const remote = await inspectRemoteBranch({
    dir: input.dir,
    url: input.remoteUrl,
    branch: input.branch,
    token: pushToken,
    log,
  });
  if (remote.exists && remote.committerEmail !== author.email) {
    throw new RepoError(
      "branch_owned_by_others",
      `远端分支 ${input.branch} 的 tip 不是我们推的（committer ${remote.committerEmail ?? "未知"}），拒绝覆盖`,
      {
        details: {
          branch: input.branch,
          sha: remote.sha,
          committerEmail: remote.committerEmail,
          expectedCommitter: author.email,
        },
      },
    );
  }

  const push = await commitAndPush({
    dir: input.dir,
    url: input.remoteUrl,
    branch: input.branch,
    token: pushToken,
    message: commit.message,
    ...(commit.body === undefined ? {} : { body: commit.body }),
    ...(commit.author === undefined ? {} : { author: commit.author }),
    // 显式给的期望值（测试）优先；否则用刚校验过归属的那个 sha——分支不存在时是 null，
    // 它在 push.ts 里变成"空 expect" = 这条分支必须不存在（把并发创建也挡掉）。
    expectedRemoteSha: input.expectedRemoteSha !== undefined ? input.expectedRemoteSha : remote.sha,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    log,
  });

  // ④ 提交之后工作区必须干净——不干净说明这棵树在建 PR 的过程中还在变（见该函数注释）。
  await assertCleanWorktree(input.dir);

  // ⑤ PR 用的 token：重新取一次。push 可能花了几分钟，而 token 的续签窗口是 5 分钟。
  let prApi: PullRequestApi;
  if (input.api !== undefined) {
    prApi = input.api;
  } else {
    const prToken = await input.token();
    prApi =
      input.apiFactory === undefined
        ? new OctokitPullRequestApi({ token: prToken })
        : input.apiFactory(prToken);
  }

  const found = await findOrCreatePullRequest({
    api: prApi,
    ref: input.ref,
    branch: input.branch,
    base: input.baseBranch,
    title: input.title,
    body: input.body,
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    ...(input.retry === undefined ? {} : { retry: input.retry }),
    log,
  });

  log("info", `${found.created ? "已创建" : "已更新"} PR #${found.pullRequest.number}`, {
    url: found.pullRequest.htmlUrl,
    draft: found.pullRequest.draft,
    branch: input.branch,
    base: input.baseBranch,
  });

  return {
    push,
    pullRequest: found.pullRequest,
    created: found.created,
    baseUpdated: found.baseUpdated,
    worktreeClean: true,
  };
}

// ---------------------------------------------------------------- PR 正文

export interface PullRequestBodyInput {
  /** `reuben-cloud: <task title>` 里的那半句。 */
  taskTitle: string;
  /** issue 原文（正文里折叠展示，太长会截断）。 */
  issue: string;
  runId: string;
  attempt: number;
  model: string;
  stopReason: string;
  stopDetail: string;
  turns: number;
  toolCalls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  files: ReadonlyArray<{ path: string; status: string; additions: number; deletions: number; binary: boolean }>;
  /** 验证结果。`null` = 这次没有跑验证命令（正文会如实写）。 */
  verification: RunVerification | null;
  /** `/diff` 直接失败、走了 archive 回退时为真（正文要说明）。 */
  fallbackReason?: string | null;
  transcriptUrl: string | null;
  sandboxId?: string | null;
}

/**
 * PR 正文（**模板 + 实数**，不让模型写：见文件头）。
 *
 * 四个小节：改动 / 验证 / 这次 Run / 原始 issue。读者是 review 的那个人，
 * 他要知道的第一件事是"改了什么、有没有测过"，其次才是"谁跑的"。
 */
export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const additions = input.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = input.files.reduce((sum, file) => sum + file.deletions, 0);
  const lines: string[] = [
    `> 🤖 这是由 reuben-cloud 为「${input.taskTitle}」自动生成的 PR，**请人工 review** 后再决定是否合并。`,
    "",
    "## 改动",
    "",
    `- ${input.files.length} 个文件（+${additions} / -${deletions}）`,
  ];
  if (input.fallbackReason !== null && input.fallbackReason !== undefined) {
    lines.push(`- ⚠️ patch 应用失败，本次树内容来自整棵 workspace 归档（${input.fallbackReason}）`);
  }
  lines.push("");
  if (input.files.length === 0) {
    lines.push("（没有文件改动）", "");
  } else {
    lines.push(
      ...input.files
        .slice(0, MAX_BODY_FILES)
        .map((file) => `- \`${file.path}\`（${file.status}，+${file.additions}/-${file.deletions}${file.binary ? "，二进制" : ""}）`),
    );
    if (input.files.length > MAX_BODY_FILES) {
      lines.push(`- …还有 ${input.files.length - MAX_BODY_FILES} 个文件`);
    }
    lines.push("");
  }

  lines.push("## 验证", "");
  const verification = input.verification;
  if (verification === null) {
    lines.push("⚠️ 这次 Run 没有跑验证命令（没有提供 `--verify`），**测试结果未知**。", "");
  } else {
    const seconds =
      verification.durationMs === null
        ? ""
        : verification.durationMs < 1_000
          ? `（${verification.durationMs}ms）`
          : `（${(verification.durationMs / 1000).toFixed(1)}s）`;
    const code = verification.exitCode === null ? verification.state : `退出码 ${verification.exitCode}`;
    lines.push(
      `- ${verification.passed ? "✅" : "❌"} \`${verification.cmd.join(" ")}\` ${code}${seconds}${verification.truncated ? "（输出被截断）" : ""}`,
    );
    if (verification.outputTail !== "") {
      lines.push("", "```", verification.outputTail, "```");
    }
    lines.push("");
  }

  lines.push("## 这次 Run", "");
  lines.push(`- 模型：\`${input.model}\``);
  lines.push(`- Run：\`${input.runId}\`（attempt ${input.attempt}）`);
  lines.push(`- 结束原因：\`${input.stopReason}\` —— ${input.stopDetail}`);
  lines.push(`- 轮数 / 工具调用：${input.turns} / ${input.toolCalls}`);
  lines.push(
    `- 用量：in=${input.usage.inputTokens} out=${input.usage.outputTokens} ` +
      `cache_read=${input.usage.cacheReadInputTokens} cache_write=${input.usage.cacheCreationInputTokens}`,
  );
  lines.push(
    `- transcript：${input.transcriptUrl === null ? "未上传（没有配对象存储）" : input.transcriptUrl}`,
  );
  if (input.sandboxId !== null && input.sandboxId !== undefined) {
    lines.push(`- 沙箱：\`${input.sandboxId}\`（产出取完已销毁）`);
  }
  lines.push("");
  lines.push("<details><summary>原始 issue</summary>", "", issueExcerpt(input.issue), "", "</details>");

  const body = lines.join("\n");
  return body.length > PR_BODY_MAX_CHARS
    ? `${body.slice(0, PR_BODY_MAX_CHARS - 40)}\n\n…（正文超过 GitHub 上限，已截断）`
    : body;
}

/** issue 原文折叠展示时的截断（它可能是一整篇需求文档）。 */
export function issueExcerpt(issue: string, maxChars = 4_000): string {
  const trimmed = issue.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n…（issue 已截断，全文见 transcript）`;
}

// ---------------------------------------------------------------- 小工具

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
