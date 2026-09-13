/**
 * `session/session-run.ts` —— 一次会话执行的编排（Phase 2 §5）。
 *
 * ```
 * handleUserMessage(sessionId, text)
 *   ① 抢会话锁（在 SessionRuntime 里，PG 条件更新）
 *   ② getSession + startRun（记下 start_entry_id）
 *   ③ 读历史（listEntries）→ buildContextEntries（含压缩摘要）
 *   ④ 跑循环。**沙箱不在这里建**——工具层的 `acquire` 第一次真的要用时才建（§6）
 *   ⑤ 结束时 endRun + updateSessionHead（leaf 接上）
 *   ⑥ 释放锁（SessionRuntime 的 finally）
 * ```
 *
 * 【这个文件为什么存在】spec P2 的交付物清单里没有它，但"每句写 entry/usage、工具调用写
 * intent/settlement"必须有一个地方把循环的事件流翻译成存储操作。放进 `run.ts`（M0 的兼容层）
 * 会让兼容层变成第二个 CP；放进工具层会让工具认识 DB。单独一层之后，它只做接线：
 * 读历史 → 交给循环 → 收 run 的终态（entries / intent 的记录在 `entry-recorder.ts`）。
 *
 * 【它怎么知道"每句话的三段"】`runs.start_entry_id` 是上一轮的 leaf，`runs.end_entry_id`
 * 是本轮结束时的 leaf。两个字段加起来就能把 entries 切成互不重叠的两段——这就是
 * spec 测试要点 17 的断言，也是 M3 调度器要用的接口（附录 C）。
 *
 * 【沙箱为什么是懒的】模型每轮都要看到工具清单（进缓存前缀），所以 tools 必须一开始就有；
 * 而容器要到第一次真的读/写/跑命令时才该建。桥梁是 `createLazySandboxToolkit` 的
 * 四个 Operations 代理——只说话的一句从头到尾不会碰沙箱（spec 测试要点 10）。
 */

import type { AgentTool, CompactionSettings, ModelClient, SessionStore } from "@reuben-cloud/agent-runtime";
import {
  buildContextEntries,
  buildSystemPrompt,
  initialMessages,
  REPO_DIR,
} from "@reuben-cloud/agent-runtime";
import type { AgentMessage, LlmMessage, ModelFailureRecoveryContext, PrepareNextTurnContext } from "@reuben-cloud/agent-runtime";
import type { RunOutcome, SessionRunStartInput } from "../agent/session-runtime.ts";
import type { HubEventSink } from "../agent/events.ts";
import type { Transcript } from "../agent/transcript.ts";
import { Transcript as TranscriptFile } from "../agent/transcript.ts";
import { runAgentLoop } from "../agent/run.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { EntryRecorder } from "./entry-recorder.ts";
import { createSessionCompaction } from "./compaction.ts";
import type { RequestRecorder } from "./requests.ts";
import type { ProvisionedSandbox, SandboxLease } from "./sandbox-lease.ts";

export interface SessionTurnRunnerOptions {
  store: SessionStore;
  lease: SandboxLease;
  model: ModelClient;
  /**
   * 建工具集。给的 `acquire` **每次工具调用都会被调**（它同时是续时的入口）。
   * 用 `createLazySandboxToolkit` 装配，或者测试里塞一个脚本化的工具。
   */
  tools: (acquire: () => Promise<ProvisionedSandbox>) => AgentTool[];
  /** 每个 Run 一个 transcript。缺省写 `/tmp/reuben-cloud-cp/<runId>/transcript.jsonl`。 */
  transcript?: (runId: string) => Promise<Transcript>;
  /**
   * 实时事件出口（观察窗）。会话层自己不往里面塞事件：循环的事件由 `run.ts` 转发，
   * 这里只在"循环之外的失败"（建库 / clone / 编排自己崩）时补一条 `run_error`
   * ——否则页面会一直停在"等第一个事件"（Phase 13 的失败模式）。
   */
  events?: HubEventSink;
  requests?: RequestRecorder | null;
  /** 沙箱里的仓库根。缺省 `REPO_DIR`（与工具层、提示词同一个常量）。 */
  repoDir?: string;
  /** 覆盖系统提示词（缺省 `buildSystemPrompt()`）。 */
  system?: string;
  maxTurns?: number;
  wallClockMs?: number;
  outputTokenBudget?: number;
  maxTokens?: number;
  /**
   * 压缩（P3）。缺省 = 按 env 配好（开关默认 on）。
   * `false` = 这个会话不压缩（测试与企业内网离线部署的退路）。
   */
  compaction?: false | { settings?: Partial<CompactionSettings>; forceAtTurn?: number | null };
  log?: LogFn;
}

/**
 * 生成 `SessionRuntime.start` 要的那个函数。
 *
 * 契约（与 `SessionRuntimeOptions.start` 一致）：不抛异常时返回终态；抛异常时这一句算失败，
 * 锁由 Runtime 释放。**这里只保证"失败时也把 run 标成 failed"**，不吞异常。
 */
export function createSessionTurnRunner(
  options: SessionTurnRunnerOptions,
): (input: SessionRunStartInput) => Promise<RunOutcome> {
  return async (input) => runSessionTurn(options, input);
}

async function runSessionTurn(options: SessionTurnRunnerOptions, input: SessionRunStartInput): Promise<RunOutcome> {
  const log = options.log ?? noopLog;
  const { store, lease, model } = options;
  const sessionId = input.sessionId;
  const runId = input.runId;
  const repoDir = options.repoDir ?? REPO_DIR;

  const session = await store.getSession(sessionId);
  if (session === null) throw new Error(`会话不存在：${sessionId}`);

  // ② 记一次执行的开始。start_entry_id = 现在的 leaf（上一轮停在哪）。
  await store.startRun({
    id: runId,
    sessionId,
    startEntryId: session.leafEntryId,
    provider: model.provider,
    model: model.model,
  });

  const historyEntries = await store.listEntries(sessionId);
  const history = buildContextEntries(historyEntries);

  // 第一轮的题面用任务书（M0 的 `initialMessages`）；后续轮是用户原话。
  // **存进 entries 的是模型真看到的那条消息**，所以回放不需要再拼一次任务书。
  const prompts: AgentMessage[] =
    history.length === 0 ? initialMessages(input.text, { repoDir }) : [{ role: "user", content: input.text }];

  const recorder = new EntryRecorder({
    store,
    sessionId,
    runId,
    provider: model.provider,
    model: model.model,
    leafEntryId: session.leafEntryId,
    // 每次模型往返都续时（spec P2 §6 规则 2：一句话跑 50 分钟不会被回收）。
    // 走租约的 touch 而不是直接写 store："续时"的语义归租约（它同时管空闲 TTL）。
    onActivity: () => lease.touch(sessionId),
    log,
  });

  // 工具包装：每次调用先记 intent（在真正执行之前），结果由 message_end 结算。
  const tools = recorder.wrapTools(options.tools(() => lease.acquire(sessionId, { runId })));

  const transcript =
    options.transcript === undefined
      ? await TranscriptFile.create({ runId, log })
      : await options.transcript(runId);

  const system = options.system ?? buildSystemPrompt({ sandbox: { repoDir } });

  // 压缩（P3）：挂在循环的两个钩子上。条目走 recorder——leaf 链在它手里。
  const compactionOptions = options.compaction === false ? null : (options.compaction ?? {});
  const compaction =
    compactionOptions === null
      ? null
      : createSessionCompaction({
          store,
          sessionId,
          runId,
          model,
          appendCompaction: (input) => recorder.appendCompaction(input.payload, input.usage),
          ...(compactionOptions.settings === undefined ? {} : { settings: compactionOptions.settings }),
          ...(compactionOptions.forceAtTurn === undefined ? {} : { forceAtTurn: compactionOptions.forceAtTurn }),
          log,
        });

  try {
    const result = await runAgentLoop({
      model,
      tools,
      transcript,
      issue: input.text,
      history,
      prompts,
      system,
      repoDir,
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
      ...(options.outputTokenBudget === undefined ? {} : { outputTokenBudget: options.outputTokenBudget }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(compaction === null
        ? {}
        : {
            prepareNextTurn: (turn: PrepareNextTurnContext) => compaction.prepareNextTurn(turn),
            recoverFromModelError: (turn: ModelFailureRecoveryContext) => compaction.recoverFromModelError(turn),
          }),
      signal: input.signal,
      sessionId,
      onAgentEvent: (event) => recorder.onAgentEvent(event),
      onRequest: async (info) => {
        await store.touchSession(sessionId);
        await options.requests?.record({
          sessionId,
          runId,
          turn: info.turn,
          system: info.system,
          messages: info.messages as LlmMessage[],
          tools: info.tools,
        });
      },
      getSteeringMessages: async () => input.steering.drain(),
      log,
      ...(options.events === undefined ? {} : { events: options.events }),
    });

    // ⑤ 收尾：run 的终态 + 本轮的 leaf。
    await store.endRun(runId, {
      status: runStatusFor(result.stopReason),
      stopReason: result.stopReason,
      endEntryId: recorder.leafEntryId,
      sandboxId: await lease.currentSandboxId(sessionId),
    });
    await store.updateSessionHead(sessionId, { leafEntryId: recorder.leafEntryId });
    await recorder.interruptRemaining();

    log("info", `会话 ${sessionId} 的第 ${recorder.turn} 轮执行结束`, {
      runId,
      stopReason: result.stopReason,
      toolCalls: recorder.toolCalls,
      leaf: recorder.leafEntryId,
    });
    return {
      ok: result.ok,
      stopReason: result.stopReason,
      detail: result.detail,
      turns: result.turns,
      toolCalls: recorder.toolCalls,
      usage: result.usage,
    };
  } catch (error) {
    // 循环自己不该抛（契约是"终态走事件"），真抛出来说明是编排侧的 bug。
    // 把 run 标成 failed 再原样抛——会话历史里要留下"这一轮没跑完"的记录。
    await store
      .endRun(runId, {
        status: "failed",
        stopReason: "run_error",
        endEntryId: recorder.leafEntryId,
        sandboxId: await lease.currentSandboxId(sessionId).catch(() => null),
      })
      .catch(() => undefined);
    // 观察窗也要看到（这是"循环之外的失败"，run.ts 的 run_end 永远不会发）。
    options.events?.emit({ type: "run_error", message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

// ---------------------------------------------------------------- 帮助函数

/**
 * 停止原因 → run 的状态。
 *
 * 【为什么不是 `ok ? stopped : failed`】"撞上轮数上限"（`max_turns`）与"模型往返失败"
 * （`model_error`）是两件事：前者是一次正常但未完成的收工（产物照样可取），
 * 后者是基础设施问题。M3 的调度器与看板按这个区分处理。
 *
 * 【`compaction_failed` 为什么算 failed】它不是"我们主动停下"，而是"上下文已经到了
 * 压不动的状态"——重跑同样的输入还会失败，必须有人改环境（换模型 / 调预算 / 拆任务）。
 */
export function runStatusFor(stopReason: string): "stopped" | "failed" {
  switch (stopReason) {
    case "model_error":
    case "aborted":
    case "run_error":
    case "compaction_failed":
      return "failed";
    default:
      return "stopped";
  }
}
