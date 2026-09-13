/**
 * `loop.ts` —— Agent 主循环（Phase 11 §4）。
 *
 * 【它在哪、为什么】在 CP，不在沙箱（§A 的四条理由：凭据不进沙箱、循环是可迭代资产、
 * 可观测性、零延迟代价）。这个文件**不知道沙箱的存在**：它只认 `AgentToolkit`
 * （`tools/index.ts` 装配）与 `ModelClient`。所有"命令怎么发下去、输出怎么截断"
 * 都在工具箱那一侧。
 *
 * 【必须遵守的几条】（§4 的原话，每条都对应一个测试用例）
 *  ① 一次响应里的多个 tool_use，结果要放在**同一条 user 消息**里返回。拆成多条会
 *     训练模型不再并行调用工具（用例 2）。
 *  ② 失败的工具有返回，`is_error:true`，**不丢掉它**（用例 4）。
 *  ③ 三重硬上限：40 轮、30 分钟墙钟、累计输出 token。到任何一个就停，并在结果里
 *     如实写"因达到上限而停止"（用例 6）。
 *  ④ 重复调用检测：同工具 + 同参数连续 3 次 → 插一条提示；再犯就停（用例 7）。
 *  ⑤ 上下文策略：工具结果按 §3.5 硬截断（在工具层）＋**只丢最旧的 tool_result 内容**，
 *     不丢 user/assistant 的文字。
 *
 * 【终态一定要有**自己的**理由】"模型说完了"和"我们把它掐了"是两回事。`stopReason`
 * 把这件事分成九个取值，Phase 12 写 PR 正文、排障看日志，都靠它区分。
 */

import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { RunEvent, RunEventSink } from "./events.ts";
import { emitEvent } from "./events.ts";
import type { ContentBlock, Message, ModelClient, ToolResultBlock, Usage } from "./model.ts";
import { REPO_DIR, buildSystemPrompt, initialMessages } from "./prompt.ts";
import type { AgentToolkit } from "./tools/index.ts";
import type { Transcript } from "./transcript.ts";

// ---------------------------------------------------------------- 常量

/** 轮数上限（§4）。 */
export const DEFAULT_MAX_TURNS = 40;

/** 墙钟上限（§4）：30 分钟。 */
export const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;

/**
 * 累计输出 token 上限。spec 只写了"要有"，没给数。
 * 300k 的理由：40 轮 × 平均 7.5k 输出 token 的正常 Run 远远到不了；而一个
 * "模型陷进疯狂输出"的 Run 会在烧掉几十美元之前先撞上它。
 */
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 300_000;

/** 同一工具 + 同样参数连续出现几次开始提示 / 几次就停。 */
export const REPEAT_NOTICE_THRESHOLD = 3;
export const REPEAT_STOP_THRESHOLD = 4;

/** 上下文裁剪的阈值（字符数，粗估 4 字符 ≈ 1 token）。 */
export const DEFAULT_CONTEXT_MAX_CHARS = 600_000;
/** 最近 N 条含 tool_result 的消息不裁剪（模型正在用的就是它们）。 */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 6;

/** 被裁掉的旧结果留下的占位符。**保留块本身**：tool_use 必须有配对的 tool_result。 */
export const ELIDED_TOOL_RESULT = "[earlier tool result elided to save context]";

/** 重复调用的提示语（§4 的原文要求：说清"换个方法或者说明你卡在哪"）。 */
export const REPEAT_NOTICE =
  "你已经用相同的参数调用过这个工具三次，而且结果没有变化。换一个方法，或者说明你卡在哪里、需要什么信息。";

// ---------------------------------------------------------------- 类型

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
  /** 模型往返本身失败（网络 / 401 / 限流）。 */
  | "model_error"
  /** 调用方 abort。 */
  | "aborted"
  /** 模型这一轮既没给 tool_use 也不是正常收尾（例如 `max_tokens` 截断了整轮输出）。 */
  | "incomplete_response";

export interface AgentLoopOptions {
  model: ModelClient;
  tools: AgentToolkit;
  transcript: Transcript;
  /** issue 原文（第一条 user 消息由 `buildTaskPrompt` 拼出来）。 */
  issue: string;
  /** 覆盖系统提示词（默认 `buildSystemPrompt()`）。 */
  system?: string;
  repoDir?: string;
  maxTurns?: number;
  wallClockMs?: number;
  outputTokenBudget?: number;
  /** 单轮输出上限，默认 `MAX_MODEL_OUTPUT_TOKENS`。 */
  maxTokens?: number;
  context?: { maxChars?: number; keepRecentToolResults?: number; enabled?: boolean };
  /**
   * 文字增量回调（Phase 13 的实时 transcript 用）。
   *
   * 【为什么不在这里顺手发一条 `text` 事件】文字是**唯一的高频通道**，而消费它的东西
   * 不止观察窗（`agent-run` 脚本同时把它写到 stdout）。循环只负责把增量交出去；
   * 要发给谁（sink / 终端 / 两个都要）由调用方决定，这样不会出现"同一个增量发了两遍"。
   */
  onText?: (delta: string) => void;
  /**
   * 实时事件出口（Phase 13）。**只在旁路上**：它抛异常不影响 Run（见 `emitEvent`）。
   * 与 `transcript` 不同的是，这里丢一条事件不会让这次 Run 无法回放。
   */
  events?: RunEventSink;
  signal?: AbortSignal;
  /** 可注入时钟（测试用它拨快墙钟）。 */
  now?: () => number;
  log?: LogFn;
}

export interface AgentLoopResult {
  /** 只有 `end_turn` 算成功；其余都是"停了，但原因不是模型说完了"。 */
  ok: boolean;
  stopReason: AgentStopReason;
  /** 人读的一句话（写进日志、Run 结果、Phase 12 的 PR 正文）。 */
  detail: string;
  /** 跑过的轮数（模型往返次数）。 */
  turns: number;
  /** 工具调用总次数。 */
  toolCalls: number;
  /** 最后一条 assistant 文字（给 PR 正文用）。 */
  finalText: string;
  /** 累计用量。`cacheReadInputTokens` 是缓存命中的证据（测试要点 10）。 */
  usage: Usage;
  /** 完整对话（含工具结果），Phase 12 要拿它算"改了什么"。 */
  messages: Message[];
  /** transcript 落点（回放用）。 */
  transcriptPath: string;
  /** transcript 写入有没有出错（出错时这一条 Run 无法完整回放）。 */
  transcriptFailure: string | null;
}

// ---------------------------------------------------------------- 主循环

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const log = options.log ?? noopLog;
  const now = options.now ?? Date.now;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const outputTokenBudget = options.outputTokenBudget ?? DEFAULT_OUTPUT_TOKEN_BUDGET;
  const maxTokens = options.maxTokens ?? 64_000;
  const contextOptions = {
    enabled: options.context?.enabled ?? true,
    maxChars: options.context?.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS,
    keepRecent: options.context?.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  };
  const system = options.system ?? buildSystemPrompt(options.repoDir === undefined ? {} : { repoDir: options.repoDir });
  const deadline = now() + wallClockMs;
  /** 事件出口的快捷方式（`undefined` 时 `emitEvent` 直接返回）。 */
  const emit = (event: RunEvent): void => emitEvent(options.events, event, log);

  const messages: Message[] = initialMessages(options.issue, options.repoDir === undefined ? {} : { repoDir: options.repoDir });
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  /** 每个签名连续出现了几次（跨轮，签名不在这一轮就清零）。 */
  const repeats = new Map<string, number>();
  let repeatNoticeInjected = false;
  let turns = 0;
  let toolCalls = 0;
  let finalText = "";
  let stop: { reason: AgentStopReason; detail: string } | null = null;

  await options.transcript.append("run_start", {
    runId: options.transcript.runId,
    model: options.model.model,
    issue: options.issue,
    system,
    tools: options.tools.definitions.map((tool) => tool.name),
    limits: { maxTurns, wallClockMs, outputTokenBudget, maxTokens, context: contextOptions },
  });
  emit({
    type: "run_start",
    runId: options.transcript.runId,
    model: options.model.model,
    issue: options.issue,
    repoDir: options.repoDir ?? REPO_DIR,
    limits: { maxTurns, wallClockMs, outputTokenBudget, maxTokens },
  });

  while (turns < maxTurns) {
    if (isAborted(options.signal)) {
      stop = { reason: "aborted", detail: "调用方取消了这次 Run" };
      break;
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      stop = {
        reason: "wall_clock",
        detail: `达到墙钟上限（${Math.round(wallClockMs / 1000)}s），在第 ${turns} 轮停下`,
      };
      break;
    }
    if (usage.outputTokens >= outputTokenBudget) {
      stop = {
        reason: "output_token_budget",
        detail: `达到累计输出 token 上限（${outputTokenBudget}），在第 ${turns} 轮停下`,
      };
      break;
    }

    // ---- ① 调模型
    const trimmed = contextOptions.enabled
      ? trimOldToolResults(messages, contextOptions)
      : 0;
    if (trimmed > 0) {
      await options.transcript.append("context_trim", { removed: trimmed, messages: messages.length });
      log("info", `上下文裁剪：丢掉 ${trimmed} 条旧工具结果的内容`, { turn: turns + 1 });
      emit({
        type: "note",
        turn: turns + 1,
        kind: "context_trim",
        message: `上下文太大，丢掉 ${trimmed} 条旧工具结果的内容（只丢结果，不丢对话文字）`,
      });
    }

    turns += 1;
    emit({ type: "turn", turn: turns });
    await options.transcript.append("request", {
      turn: turns,
      model: options.model.model,
      system,
      tools: options.tools.definitions,
      maxTokens,
      messages: structuredClone(messages),
    });

    const startedAt = now();
    const gate = requestDeadline(options.signal, remainingMs);
    let response;
    try {
      response = await options.model.create({
        system,
        messages,
        tools: options.tools.definitions,
        maxTokens,
        signal: gate.signal,
        ...(options.onText === undefined ? {} : { onText: options.onText }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 用函数而不是 `options.signal?.aborted === true`：属性上的窄化在 await 之后是**陈旧**的
      // （TS 不会因为 await 而失效它），直接把"调用方有没有在等待期间取消"判成不可能。
      const aborted = isAborted(options.signal);
      await options.transcript.append("model_error", { turn: turns, error: message, aborted, timedOut: gate.timedOut });
      log("error", `模型调用失败（第 ${turns} 轮）`, { error: message, timedOut: gate.timedOut });
      emit({ type: "note", turn: turns, kind: "model_error", message: `模型调用失败：${message}` });
      stop = gate.timedOut
        ? {
            reason: "wall_clock",
            detail: `第 ${turns} 轮的模型调用超过了墙钟上限（${Math.round(wallClockMs / 1000)}s）`,
          }
        : aborted
          ? { reason: "aborted", detail: `第 ${turns} 轮的模型调用被取消` }
          : { reason: "model_error", detail: `第 ${turns} 轮模型调用失败：${message}` };
      gate.dispose();
      break;
    }
    gate.dispose();

    const durationMs = now() - startedAt;
    accumulate(usage, response.usage);
    await options.transcript.append("response", {
      turn: turns,
      durationMs,
      content: response.content,
      stopReason: response.stopReason,
      usage: response.usage,
      refusalReason: response.refusalReason,
    });

    finalText = textOf(response.content) || finalText;
    // **必须整块 push**（含 tool_use 与 thinking），否则下一轮 API 会因为
    // "tool_use 没有配对" 或者"思考块被改过"而 400。
    messages.push({ role: "assistant", content: response.content });

    // ---- ② 终态判断
    if (response.stopReason === "end_turn") {
      stop = { reason: "end_turn", detail: `模型在第 ${turns} 轮正常收工` };
      break;
    }
    if (response.stopReason === "refusal") {
      stop = {
        reason: "refusal",
        detail: `模型拒绝了这次请求${response.refusalReason === null ? "" : `：${response.refusalReason}`}`,
      };
      break;
    }

    const toolUses = response.content.filter(isToolUse);
    if (toolUses.length === 0) {
      // 既没有 tool_use 也不是 end_turn（例如 max_tokens 把整轮输出截断在文字里）。
      // 如实停下——继续下一轮只会把同一个截断重演一遍。
      stop = {
        reason: "incomplete_response",
        detail: `第 ${turns} 轮以 ${response.stopReason} 结束，且没有工具调用可以执行`,
      };
      await options.transcript.append("note", { turn: turns, kind: "incomplete", stopReason: response.stopReason });
      emit({
        type: "note",
        turn: turns,
        kind: "incomplete",
        message: `第 ${turns} 轮以 ${response.stopReason} 结束，没有工具调用可以执行`,
      });
      break;
    }

    // ---- ③ 并行执行工具（沙箱的单执行闸会串行化 bash；读类工具真的并发）
    const results = await Promise.all(
      toolUses.map(async (use): Promise<ToolResultBlock> => {
        // 事件分两次发（跑之前 tool_call、跑完 tool_result），transcript 仍然只记一条
        // （它是证据，要的是结果；观察窗要的是"现在正在跑什么"）。
        emit({ type: "tool_call", turn: turns, id: use.id, name: use.name, input: use.input });
        const result = await options.tools.run(use.name, use.input);
        toolCalls += 1;
        const resultBytes = Buffer.byteLength(result.content);
        emit({
          type: "tool_result",
          turn: turns,
          id: use.id,
          name: use.name,
          isError: result.isError,
          bytes: resultBytes,
          content: result.content,
        });
        await options.transcript.append("tool_call", {
          turn: turns,
          id: use.id,
          name: use.name,
          input: use.input,
          isError: result.isError,
          resultBytes,
        });
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        };
      }),
    );

    // ---- ④ 重复检测：同工具 + 同参数连续出现（§4）
    const repeat = trackRepeats(repeats, toolUses);
    const userBlocks: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = results;
    if (repeat.count >= REPEAT_NOTICE_THRESHOLD) {
      if (repeatNoticeInjected || repeat.count >= REPEAT_STOP_THRESHOLD) {
        await options.transcript.append("note", { turn: turns, kind: "repeat_stop", signature: repeat.signature });
        emit({
          type: "note",
          turn: turns,
          kind: "repeat_stop",
          message: `同一调用（${repeat.signature}）连续出现了 ${repeat.count} 次，停止`,
        });
        // 结果仍然回填：返回给调用方的 `messages` 要是一段**合法**的对话
        // （tool_use 永远有配对的 tool_result），否则 Phase 12 拿它重发会 400。
        messages.push({ role: "user", content: userBlocks });
        stop = {
          reason: "repeated_tool_calls",
          detail: `同一调用（${repeat.signature}）连续出现了 ${repeat.count} 次，停止`,
        };
        break;
      }
      repeatNoticeInjected = true;
      await options.transcript.append("note", { turn: turns, kind: "repeat_notice", signature: repeat.signature });
      emit({ type: "note", turn: turns, kind: "repeat_notice", message: REPEAT_NOTICE });
      userBlocks.push({ type: "tool_result", tool_use_id: `repeat_notice_${turns}`, content: REPEAT_NOTICE });
      log("warn", `检测到重复调用，已向模型插入提示`, { signature: repeat.signature, turn: turns });
    }

    // **所有 tool_result 放在同一条 user 消息里**（含上面那条提示，它是同一条消息里的
    // 一个额外块——文字与 tool_result 混在同一条 user 消息是合法的，拆成两条则不是）。
    messages.push({ role: "user", content: userBlocks });
  }

  if (stop === null) {
    stop = { reason: "max_turns", detail: `达到轮数上限（${maxTurns} 轮）` };
  }

  await options.transcript.append("run_end", {
    stopReason: stop.reason,
    detail: stop.detail,
    turns,
    toolCalls,
    usage,
    transcriptFailure: options.transcript.failure?.message ?? null,
  });
  emit({
    type: "run_end",
    ok: stop.reason === "end_turn",
    stopReason: stop.reason,
    detail: stop.detail,
    turns,
    toolCalls,
    usage,
  });

  return {
    ok: stop.reason === "end_turn",
    stopReason: stop.reason,
    detail: stop.detail,
    turns,
    toolCalls,
    finalText,
    usage,
    messages,
    transcriptPath: options.transcript.path,
    transcriptFailure: options.transcript.failure?.message ?? null,
  };
}

// ---------------------------------------------------------------- 上下文裁剪

export interface ContextTrimOptions {
  maxChars: number;
  keepRecent: number;
}

/**
 * 只丢**最旧的 tool_result 内容**，不丢 user/assistant 的文字（§4 的 MVP 策略）。
 *
 * "丢内容"而不是"丢块"：Anthropic 要求每个 `tool_use` 都有配对的 `tool_result`，
 * 把整块删掉会让下一次请求 400。所以这里把内容换成占位符，块本身留着。
 *
 * @returns 被替换的块数（0 = 没动）。
 */
export function trimOldToolResults(messages: Message[], options: ContextTrimOptions): number {
  const total = messages.reduce((sum, message) => sum + sizeOf(message), 0);
  if (total <= options.maxChars) return 0;

  // 找出含 tool_result 的消息（从新到旧排），最近 keepRecent 条不碰。
  const withResults: number[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (hasToolResult(messages[index]!)) withResults.push(index);
  }

  let removed = 0;
  let current = total;
  // slice → reverse：从最旧的那条开始丢。
  for (const index of withResults.slice(Math.max(0, options.keepRecent)).reverse()) {
    if (current <= options.maxChars) break;
    const message = messages[index]!;
    if (typeof message.content === "string") continue;
    message.content = message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (block.content === ELIDED_TOOL_RESULT) return block;
      current -= block.content.length - ELIDED_TOOL_RESULT.length;
      removed += 1;
      return { ...block, content: ELIDED_TOOL_RESULT };
    });
  }
  return removed;
}

function hasToolResult(message: Message): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some((block) => block.type === "tool_result");
}

function sizeOf(message: Message): number {
  if (typeof message.content === "string") return message.content.length;
  let size = 0;
  for (const block of message.content) {
    if (block.type === "text") size += block.text.length;
    else if (block.type === "thinking") size += block.thinking.length;
    else if (block.type === "tool_result") size += block.content.length;
    else if (block.type === "tool_use") size += JSON.stringify(block.input ?? null).length;
  }
  return size;
}

// ---------------------------------------------------------------- 小工具

function isToolUse(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
}

/** 有没有被取消。**写成函数**是为了绕开 TS 对属性窄化的陈旧假设，见调用点注释。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function accumulate(target: Usage, delta: Usage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadInputTokens += delta.cacheReadInputTokens;
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens;
}

interface RepeatInfo {
  /** 这一轮里出现次数最多的那个签名的连续计数。 */
  count: number;
  signature: string;
}

/**
 * 更新"连续重复"计数。签名 = 工具名 + 参数的稳定 JSON。
 *
 * 语义：**连续**——某个签名这一轮没出现就把它的计数清零（中间夹了别的调用说明模型
 * 在试探别的方法，不该算重复）。同一轮里多个相同签名只算一次（一次响应里发出两个
 * 一模一样的 tool_use 是模型自己的问题，下一轮就会重复）。
 */
export function trackRepeats(
  counts: Map<string, number>,
  toolUses: readonly { name: string; input: unknown }[],
): RepeatInfo {
  const seen = new Set<string>();
  let best: RepeatInfo = { count: 0, signature: "" };
  for (const use of toolUses) {
    const signature = `${use.name}(${stableJson(use.input)})`;
    seen.add(signature);
    const next = (counts.get(signature) ?? 0) + 1;
    counts.set(signature, next);
    if (next > best.count) best = { count: next, signature };
  }
  for (const key of [...counts.keys()]) {
    if (!seen.has(key)) counts.delete(key);
  }
  return best;
}

/** 参数的稳定序列化（键排序），用来判断"同样参数"。 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/**
 * 给模型调用套一层总时限（墙钟上限的落地）：调用方的 signal 与剩余时间谁先到算谁。
 * `timedOut` 把"到点了"与"调用方取消了"分开——前者是 `wall_clock` 终态，
 * 后者是 `aborted`。两者的排查方向完全不同，不能合成一个。
 */
function requestDeadline(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: boolean; dispose: () => void } {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error("wall clock limit"));
  }, Math.max(1, timeoutMs));
  timer.unref();
  const onAbort = (): void => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut;
    },
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}
