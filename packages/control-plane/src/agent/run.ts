/**
 * `run.ts` —— 一次 Run 的**两端编排**：
 *  · 启动端：`runAgentLoop(options)`（M0 的兼容入口，内部走 agent-runtime 的循环）
 *  · 收尾端：`finishRun(input)`（从 agent 的最后一轮，到仓库里的一条 PR）
 *
 * 【兼容层的边界（Phase 1 §7）】`runAgentLoop` 的**签名保持不变**——它是 M0 的集成测试与
 * `agent:run` 脚本的入口。它只做三件事：把 M0 的参数翻译成 `AgentLoopConfig`、
 * 把循环的事件流交给观察窗与会话层（entries / transcript）、把循环终态翻回
 * `AgentStopReason`。**不复制循环逻辑**（那是 agent-runtime 的事）。
 *
 * 【P4 之后事件不再翻译】M0 这里把 `AgentEvent` 翻成 `RunEvent` 再给观察窗，于是
 * "循环发生了什么"在链路上有两套词汇。现在 `AgentEvent` 是唯一协议：`events` 收到的
 * 就是循环的原生事件（SSE 通道由 `events.ts` 的映射表决定），这里只做 CP 才有的事：
 * 记 usage / 最终文字、写本次执行的 transcript、给准备方决定的终态留一个记号。
 *
 * 【为什么预算与重复检测在这里、不在循环里】它们都是**政策**：40 轮 / 30 分钟 / 300k
 * 输出 token 是默认策略（`defaultStopPolicy`），"同一调用连续 3 次提示、4 次停"是重复守卫
 * （`createRepeatGuard`）。循环只提供 `shouldStopAfterTurn` / `beforeToolCall` 两个钩子。
 * 这样 M3 的配额系统替换的是这里的策略函数，不是循环。
 *
 * 【墙钟的硬约束】策略只能保证"下一轮不再开始"；一次已经开始的模型调用要靠 abort 定时器
 * 掐掉（`policy.deadline`）。两者合起来才是 M0 的"30 分钟上限"。
 *
 * 【收尾编排：从 agent 的最后一轮，到仓库里的一条 PR】
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
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  AssistantMessage,
  LlmMessage,
  ModelClient,
  ModelFailureRecoveryContext,
  PrepareNextTurnContext,
  Usage,
} from "@reuben-cloud/agent-runtime";
import {
  accumulateUsage,
  buildSystemPrompt,
  createRepeatGuard,
  defaultConvertToLlm,
  defaultStopPolicy,
  emptyUsage,
  initialMessages,
  maxTokensFor,
  REPEAT_STOP,
  REPO_DIR,
  runAgentLoop as runAgentLoopCore,
} from "@reuben-cloud/agent-runtime";
import type { RunEvent, HubEventSink } from "./events.ts";
import type { Transcript } from "./transcript.ts";
import { emitEvent } from "./events.ts";
import type { CollectedChanges } from "../repo/apply.ts";
import { collectSandboxChanges } from "../repo/apply.ts";
import type { PullRequestApi, PublishRunResult, RetryOptions, RunVerification } from "../repo/pr.ts";
import { buildPullRequestBody, publishRun, verifyInSandbox } from "../repo/pr.ts";
import type { RepoClone } from "../repo/clone.ts";
import { branchNameForTask } from "../repo/push.ts";
import type { RepoApi, RepoRef, SandboxTarget } from "../repo/types.ts";

/**
 * 仓库在沙箱里的落点。**只有一个出处**：agent-runtime 的 `prompt/system.ts` 的 `REPO_DIR`
 * （工具层、提示词、灌入点三处必须字面一致）。这里只是给收尾编排一个本地别名，
 * 免得同一个字符串在两个包里各写一遍。
 */
export const DEFAULT_REPO_DIR = REPO_DIR;

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


// ================================================================ 启动编排（兼容层）

/** 轮数上限（§4）。 */
export const DEFAULT_MAX_TURNS = 40;

/** 墙钟上限：30 分钟。 */
export const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;

/** 累计输出 token 上限（理由见 agent-runtime 的 `limits.ts`）。 */
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 300_000;

/**
 * 一次 Run 的终态。取值与 M0 一致（外加 P3 的 `compaction_failed`）。
 * "模型说完了"（`end_turn`）与"我们把它掐了"（其余）是两件事。
 */
export type AgentStopReason =
  /** 模型正常收工。 */
  | "end_turn"
  /** 模型拒绝了这次请求（正常终态，不是异常）。 */
  | "refusal"
  /** 撞上轮数上限。 */
  | "max_turns"
  /** 撞上墙钟上限。 */
  | "wall_clock"
  /** 撞上累计输出 token 上限。 */
  | "output_token_budget"
  /** 同一调用重复到无可救药。 */
  | "repeated_tool_calls"
  /** 上下文压缩压不出来（P3）：不能再跑下去，否则下一次请求还是会超窗。 */
  | "compaction_failed"
  /** 模型往返本身失败（网络 / 401 / 限流）。 */
  | "model_error"
  /** 调用方 abort。 */
  | "aborted"
  /** 模型这一轮既没给 tool_use 也不是正常收尾（例如 `max_tokens` 截断了整轮输出）。 */
  | "incomplete_response";

export interface AgentLoopOptions {
  model: ModelClient;
  /** 工具快照（`createSandboxToolkit().tools`）。 */
  tools: AgentTool[];
  transcript: Transcript;
  /** issue 原文（第一条 user 消息由 `buildTaskPrompt` 拼出来）。 */
  issue: string;
  /**
   * 这次执行挂在哪个会话上（写进 `run_start`：观察窗靠它读会话视图）。
   * 单跑（没有会话）时不给，就是 null。
   */
  sessionId?: string | null;
  /**
   * 这一轮之前的历史（会话续轮用；缺省空）。它们进上下文、不进本次的 `newMessages`——
   * 与 pi 的 `AgentContext.messages` 是同一个意思。
   */
  history?: AgentMessage[];
  /**
   * 覆盖"本次要注入的消息"（缺省由 `issue` 拼出任务书）。会话里只有**第一轮**用任务书，
   * 后续轮直接给用户原话，所以这个口必须能覆盖。
   */
  prompts?: AgentMessage[];
  /** 覆盖系统提示词（默认 `buildSystemPrompt()`）。 */
  system?: string;
  repoDir?: string;
  maxTurns?: number;
  wallClockMs?: number;
  outputTokenBudget?: number;
  /** 单轮输出上限，默认取模型目录里的 `maxTokens`。 */
  maxTokens?: number;
  /**
   * 下一轮开始前的准备（P3 的压缩挂在这里）。返回 undefined = 什么都不改。
   * 控制器（`createCompactionController`）实现这个形状，CP 只负责把它传进来。
   */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  /**
   * 模型调用失败后的恢复（P3 的溢出恢复挂在这里）。返回带 `context` 的 update =
   * 压缩之后重试那一轮（只重试一次）。
   */
  recoverFromModelError?: (
    context: ModelFailureRecoveryContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  /**
   * 文字增量回调（给人看的那一份）。
   *
   * 【P4 之后它与观察窗是两条路】观察窗直接从 `message_update` 事件里取增量
   * （事件协议是唯一真相）；这个回调是给 `agent:run` 脚本往 stdout 写用的
   * ——终端里那一段人读的输出不需要 SSE、也不等人开浏览器。两者同源不同消费者，
   * 所以不在这里额外发一条事件（发了就是同一条链路上的第二份）。
   */
  onText?: (delta: string) => void;
  /**
   * 实时事件出口（观察窗）。**只在旁路上**：它抛异常不影响 Run（见 `emitEvent`）。
   *
   * 【P4 起它收的是整族的观察窗事件】Run 生命周期（`run_start` / `run_end` / `run_error`）
   * 与循环的原生 `AgentEvent` 走同一个口——观察窗里就是一条流，不存在"两套真相拼起来"。
   * 沙箱命令输出由 `sandbox-operations.ts` 单独发（它也接同一个 hub）。
   */
  events?: HubEventSink;
  /**
   * 循环的原生事件出口（Phase 2 的会话层用它写 entries / usage / 工具结算）。
   *
   * 【与 `events` 的分工】两个口收的是**同一批** `AgentEvent`（P4 之后没有第二套词汇）：
   * 这个口给存储（会话历史），`events` 给观察窗（人看的流）。分开是因为它们的失败语义与
   * 时机不同——存储要"工具执行前先落 intent"（顺序敏感），观察窗只是旁路。
   * 契约与 `events` 相同：抛异常只是一个副作用失败，不该弄死正在跑的循环。
   */
  onAgentEvent?: AgentEventSink;
  /**
   * 每一轮**真的发给模型**的东西（已经过 `transformContext` + `convertToLlm`）。
   * 会话层用它落 `model_requests`（P10 的编译产物落库也走这里）。
   */
  onRequest?: (info: AgentRequestInfo) => Promise<void> | void;
  /** 插话队列（`SessionRuntime.steer()` 用它；P1 的内存实现）。 */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  signal?: AbortSignal;
  /** 可注入时钟（测试用它拨快墙钟）。 */
  now?: () => number;
  log?: LogFn;
}

/** 每一轮真的发给模型的东西（`onRequest` 的参数）。 */
export interface AgentRequestInfo {
  /** 本次执行内的轮次号（从 1 起，与 tool_invocations.turn 同一个口径）。 */
  turn: number;
  system: string;
  maxTokens: number;
  /** 发给模型的工具定义（名字 + 描述 + JSON Schema）。 */
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /** `convertToLlm` 之后的协议消息。 */
  messages: LlmMessage[];
}

export interface AgentLoopResult {
  /** 只有 `end_turn` 算成功；其余都是"停了，但原因不是模型说完了"。 */
  ok: boolean;
  stopReason: AgentStopReason;
  /** 人读的一句话（写进日志、Run 结果、PR 正文）。 */
  detail: string;
  /** 跑过的轮数（模型往返次数）。 */
  turns: number;
  /** 工具调用总次数。 */
  toolCalls: number;
  /** 最后一条 assistant 文字（给 PR 正文用）。 */
  finalText: string;
  /** 累计用量。`cacheReadInputTokens` 是缓存命中的证据。 */
  usage: Usage;
  /** 完整对话（含工具结果）。 */
  messages: AgentMessage[];
  /** transcript 落点（回放用）。 */
  transcriptPath: string;
  /** transcript 写入有没有出错（出错时这一条 Run 无法完整回放）。 */
  transcriptFailure: string | null;
}

/**
 * 跑一次 agent 循环（**M0 的兼容入口**）。
 *
 * 内部走的是 agent-runtime 的双层循环：预算走 `shouldStopAfterTurn`，重复检测走
 * `beforeToolCall`，上下文裁剪走 `transformContext`，事件流是唯一输出
 * （这里把它交给观察窗与会话层）。
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const log = options.log ?? noopLog;
  const now = options.now ?? Date.now;
  const repoDir = options.repoDir ?? REPO_DIR;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const outputTokenBudget = options.outputTokenBudget ?? DEFAULT_OUTPUT_TOKEN_BUDGET;
  const maxTokens = options.maxTokens ?? maxTokensFor(options.model.model);
  const system = options.system ?? buildSystemPrompt({ sandbox: { repoDir } });
  const policy = defaultStopPolicy({ maxTurns, wallClockMs, outputTokenBudget }, { now });
  /** Run 生命周期事件（只有三个）→ 观察窗。 */
  const emit = (event: RunEvent): void => emitEvent(options.events, event, log);
  /** 循环的原生事件 → 观察窗（与上面的口是同一个 hub）。 */
  const emitAgent = (event: AgentEvent): void => emitEvent(options.events, event, log);

  /** 墙钟到点：策略管"下一轮不再开始"，这个定时器管"掐掉已经在跑的那一轮"。 */
  let wallClockTripped = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    wallClockTripped = true;
    controller.abort(new Error("wall clock limit"));
  }, Math.max(1, policy.deadline - now()));
  timer.unref();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);

  let turn = 0;
  let turnStartedAt = now();
  let toolCalls = 0;
  /** toolCallId → 该次调用的参数（`tool_execution_end` 事件不带 args，transcript 要记）。 */
  const toolArgs = new Map<string, unknown>();
  let finalText = "";
  const usage = emptyUsage();
  /**
   * 准备方直接决定的终态（P3 的 `compaction_failed`）：循环发一条与停止原因同名的 `note`
   * 之后收工，这里把它拦下来当作 Run 的停止原因。
   */
  let forcedStop: { reason: AgentStopReason; detail: string } | null = null;

  const transcriptNote = async (kind: string, message: string): Promise<void> => {
    await options.transcript.append("note", { turn, kind, message });
  };

  /**
   * 一条 **CP 自己产生**的旁路提示（重复调用守卫、模型错误以外的新增提示）：
   * 它既进 transcript（取证），也走 `passEvent` 进 entries 与观察窗。
   *
   * 【为什么单独一个函数】循环自己发的 note 已经在 `handleEvent` 里被 `passEvent`
   * 转发过一次，再转发一遍就是两条——这个口只给"循环不知道的提示"用。
   */
  const emitNote = async (kind: string, message: string): Promise<void> => {
    await transcriptNote(kind, message);
    await passEvent({ type: "note", kind, message });
  };

  /**
   * 还没写完的旁路提示（`onNote` 是同步回调，不能 await）。收工前一并等掉：
   * 否则最后一条提示可能落在 `run_end` 之后，甚至随着进程退出丢掉。
   */
  const pendingNotes = new Set<Promise<void>>();
  const noteFromGuard = (kind: string, message: string): void => {
    const pending = emitNote(kind, message).catch((error: unknown) => {
      log("warn", "旁路提示写入失败（已忽略，Run 继续）", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    pendingNotes.add(pending);
    void pending.finally(() => pendingNotes.delete(pending));
  };

  const repeat = createRepeatGuard({
    onNote: (kind, message) => {
      noteFromGuard(kind, message);
      log("warn", `重复调用守卫：${kind}`, { message });
    },
    log,
  });

  await options.transcript.append("run_start", {
    runId: options.transcript.runId,
    model: options.model.model,
    issue: options.issue,
    system,
    tools: options.tools.map((tool) => tool.name),
    limits: { maxTurns, wallClockMs, outputTokenBudget, maxTokens },
  });
  emit({
    type: "run_start",
    runId: options.transcript.runId,
    sessionId: options.sessionId ?? null,
    model: options.model.model,
    issue: options.issue,
    repoDir,
    limits: { maxTurns, wallClockMs, outputTokenBudget, maxTokens },
  });

  /**
   * 一条原生事件送给两个消费者：① 会话层（entries / intent / usage，`onAgentEvent`）；
   * ② 观察窗（hub）。**顺序不能变**：工具结算的前提是 intent 先落库（`EntryRecorder`）。
   *
   * 两个消费者都是旁路：它们抛异常只记一条 warn，绝不冒泡进循环
   * （观察窗与存储都不该弄死一次已经跑了二十分钟的 Run）。
   */
  const passEvent = async (event: AgentEvent): Promise<void> => {
    if (options.onAgentEvent !== undefined) {
      try {
        await options.onAgentEvent(event);
      } catch (error) {
        log("warn", "onAgentEvent 的消费者抛了异常（已忽略，Run 继续）", {
          event: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    emitAgent(event);
  };

  /**
   * 循环事件 → 观察窗 + 本次执行的账（transcript / usage / 终态记号）。
   *
   * 【为什么先转发再做账】事件顺序就是页面顺序：给模型错误的 assistant 消息补的那条
   * note 必须排在它后面（否则页面上"模型失败"会出现在那句失败的话之前）。
   */
  const handleEvent = async (event: AgentEvent): Promise<void> => {
    await passEvent(event);
    switch (event.type) {
      case "turn_start":
        turn += 1;
        turnStartedAt = now();
        break;
      case "message_update": {
        // 文字仍然要交给 `onText`：`agent:run` 脚本把它写到 stdout（人读的那一份）。
        // 观察窗那一份走事件协议（同一份数据的另一个消费者），两条路互不替代。
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "text_delta") options.onText?.(streamEvent.delta);
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        accumulateUsage(usage, message.usage);
        const text = assistantText(message);
        if (text !== "") finalText = text;
        await options.transcript.append("response", {
          turn,
          durationMs: now() - turnStartedAt,
          content: message.content,
          stopReason: message.stopReason ?? null,
          usage: message.usage,
          refusalReason: message.refusalReason ?? null,
          errorMessage: message.errorMessage ?? null,
        });
        // 模型往返失败：M0 会记一条 transcript 与一条 note（排障时最先看的就是它）。
        // note 自己也走事件协议：它要在页面上、也要在会话视图里（entries）。
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          const aborted = message.stopReason === "aborted";
          const detail = message.errorMessage ?? (aborted ? "模型调用被取消" : "模型调用失败");
          await options.transcript.append("model_error", { turn, error: detail, aborted, timedOut: wallClockTripped });
          log(aborted ? "warn" : "error", `模型调用失败（第 ${turn} 轮）`, { error: detail, timedOut: wallClockTripped });
          await passEvent({ type: "note", kind: "model_error", message: `模型调用失败：${detail}` });
        }
        break;
      }
      case "tool_execution_start":
        toolArgs.set(event.toolCallId, event.args);
        break;
      case "tool_execution_end": {
        toolCalls += 1;
        const content = toolResultText(event.result);
        await options.transcript.append("tool_call", {
          turn,
          id: event.toolCallId,
          name: event.toolName,
          input: toolArgs.get(event.toolCallId) ?? null,
          isError: event.isError,
          resultBytes: Buffer.byteLength(content),
        });
        toolArgs.delete(event.toolCallId);
        break;
      }
      case "note": {
        // 准备方可以用与停止原因同名的 note 直接收工（P3 的 compaction_failed，见
        // agent-runtime 的 `AgentLoopTurnUpdate.stop`）。这里是唯一认识这个约定的地方。
        if (isStopReason(event.kind)) forcedStop = { reason: event.kind, detail: event.message };
        await transcriptNote(event.kind, event.message);
        break;
      }
      default:
        break;
    }
  };

  /**
   * 每一轮**真的发给模型**的东西（已经过 `convertToLlm`）。
   *
   * 【这里不再做上下文裁剪】M0 的"超 600k 字符丢旧工具结果"已经删掉——P3 起上下文缩减
   * 只有 compaction 一种机制（`prepareNextTurn` 钩子），它改的是富消息（不只是一次请求的投影），
   * 而且切点、摘要、文件清单都在那里一起管。这里只剩录制：`onRequest`（`model_requests`）
   * 与 transcript 的 `request` 记录——它们要的正是"真的发出去的那一份"。
   */
  const transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const llmMessages: LlmMessage[] = defaultConvertToLlm(messages);
    // 会话层（P2）在这里落 model_requests；P10 的编译产物也走这个口。
    if (options.onRequest !== undefined) {
      try {
        await options.onRequest({
          turn,
          system,
          maxTokens,
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters as unknown as Record<string, unknown>,
          })),
          messages: llmMessages,
        });
      } catch (error) {
        log("warn", "onRequest 的消费者抛了异常（已忽略，Run 继续）", {
          turn,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await options.transcript.append("request", {
      // `turn_start` 已经把 turn 加过了：请求、响应、工具调用三条记录用的是同一个轮次号。
      turn,
      model: options.model.model,
      system,
      // transcript 里保留 M0 的字段名（`input_schema`）：P2 的 JSONL 导出要能逐字段对上
      // （spec P2 测试要点 6）。发给模型的那一份由 runtime 的 `toLlmTools()` 现场转换。
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
      maxTokens,
      messages: llmMessages,
    });
    return messages;
  };

  const context: AgentContext = { systemPrompt: system, messages: [...(options.history ?? [])], tools: options.tools };
  const prompts = options.prompts ?? initialMessages(options.issue, { repoDir });
  let messages: AgentMessage[] = [];
  try {
    messages = await runAgentLoopCore(
      prompts,
      context,
      {
        model: options.model,
        maxTokens,
        shouldStopAfterTurn: (turnContext) => policy.shouldStopAfterTurn(turnContext),
        beforeToolCall: (toolContext, toolSignal) => repeat.beforeToolCall(toolContext, toolSignal),
        transformContext,
        // 压缩（P3）：会话层/脚本把控制器实现的那两个钩子传进来，兼容层只做透传。
        ...(options.prepareNextTurn === undefined ? {} : { prepareNextTurn: options.prepareNextTurn }),
        ...(options.recoverFromModelError === undefined
          ? {}
          : { recoverFromModelError: options.recoverFromModelError }),
        ...(options.getSteeringMessages === undefined ? {} : { getSteeringMessages: options.getSteeringMessages }),
      },
      handleEvent,
      signal,
    );
  } finally {
    clearTimeout(timer);
  }

  // 把还没写完的旁路提示等完（它们是旁路，但不应在 `run_end` 之后还飘着）。
  if (pendingNotes.size > 0) await Promise.all([...pendingNotes]);

  const lastAssistant = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant") ?? null;
  const stop = resolveStopReason({ lastAssistant, policy, repeat, wallClockTripped, turns: turn, forcedStop });
  await options.transcript.append("run_end", {
    stopReason: stop.reason,
    detail: stop.detail,
    turns: turn,
    toolCalls,
    usage,
    transcriptFailure: options.transcript.failure?.message ?? null,
  });
  emit({
    type: "run_end",
    ok: stop.reason === "end_turn",
    stopReason: stop.reason,
    detail: stop.detail,
    turns: turn,
    toolCalls,
    usage,
  });

  return {
    ok: stop.reason === "end_turn",
    stopReason: stop.reason,
    detail: stop.detail,
    turns: turn,
    toolCalls,
    finalText,
    usage,
    messages,
    transcriptPath: options.transcript.path,
    transcriptFailure: options.transcript.failure?.message ?? null,
  };
}

interface StopResolution {
  reason: AgentStopReason;
  detail: string;
}

/** 循环终态 → M0 的九个 `AgentStopReason`。顺序就是优先级。 */
function resolveStopReason(input: {
  lastAssistant: AssistantMessage | null;
  policy: ReturnType<typeof defaultStopPolicy>;
  repeat: ReturnType<typeof createRepeatGuard>;
  wallClockTripped: boolean;
  turns: number;
  /** 准备方直接决定的终态（P3 的 `compaction_failed`）。**优先级最高**。 */
  forcedStop: { reason: AgentStopReason; detail: string } | null;
}): StopResolution {
  if (input.forcedStop !== null) {
    return { reason: input.forcedStop.reason, detail: input.forcedStop.detail };
  }
  if (input.repeat.stopped) {
    return { reason: "repeated_tool_calls", detail: input.repeat.stopDetail ?? REPEAT_STOP };
  }
  if (input.policy.stopReason !== null) {
    return { reason: input.policy.stopReason, detail: input.policy.detail ?? "" };
  }
  if (input.wallClockTripped) {
    return { reason: "wall_clock", detail: `达到墙钟上限，在第 ${input.turns} 轮停下` };
  }
  const message = input.lastAssistant;
  switch (message?.stopReason) {
    case "stop":
      return { reason: "end_turn", detail: `模型在第 ${input.turns} 轮正常收工` };
    case "refusal":
      return {
        reason: "refusal",
        detail: `模型拒绝了这次请求${message.refusalReason == null ? "" : `：${message.refusalReason}`}`,
      };
    case "aborted":
      return { reason: "aborted", detail: message.errorMessage ?? "调用方取消了这次 Run" };
    case "error":
      return { reason: "model_error", detail: `模型调用失败：${message.errorMessage ?? "未知原因"}` };
    case "length":
      return {
        reason: "incomplete_response",
        detail: `第 ${input.turns} 轮以输出上限结束，且没有工具调用可以执行`,
      };
    case "toolUse":
      return { reason: "incomplete_response", detail: "工具批次被提前终止，模型没有机会收尾" };
    default:
      return { reason: "incomplete_response", detail: "循环在没有明确终态的情况下结束" };
  }
}

/** `note.kind` 是不是一个"直接收工"的约定（见 `handleEvent` 的 note 分支）。 */
function isStopReason(kind: string): kind is AgentStopReason {
  return kind === "compaction_failed";
}

/** assistant 的可见文字（工具调用与思考不算）。 */
function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** 工具结果的文本（写进 transcript 的那一份）。 */
function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | null)?.content ?? [];
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("");
}
