/**
 * `loop.ts` —— Agent 主循环（Phase 1；逐条对齐 pi 的 `packages/agent/src/agent-loop.ts`）。
 *
 * 【双层循环，两个 while 各自管一件事】
 *  - **内层**：处理"这一轮的工具调用"与"用户插话"（steering）——插话在工具跑完之后、
 *    下一次模型调用之前注入，**不打断**正在跑的工具。
 *  - **外层**：agent 本来要收工时再问一次 follow-up 队列；有就继续，没有才真的收工。
 *    把两者合成一个 while 的后果是"用户插话"与"agent 收工后又有消息"互相干扰
 *    （pi 踩过，我们逐条对齐）。
 *
 * 【循环不管预算】轮数 / 墙钟 / 输出 token 都在 `shouldStopAfterTurn` 钩子里
 * （`limits.ts` 给默认策略）。压缩挂在 `prepareNextTurn`，上下文编译挂在
 * `transformContext`。循环本身只有"这一轮做什么、下一轮还要不要跑"。
 *
 * 【四条必须守住的性质（每条对应一个测试）】
 *  ① 一次响应里的多个工具调用：结果按**源码顺序**放在同一条（协议层）消息里回来；
 *     执行可以并行。拆开或乱序会让"tool_use 与 tool_result 配对"失效。
 *  ② 失败的工具有返回（`isError: true`），**不丢掉它**——模型要看到失败并自己改。
 *  ③ 响应被输出上限截断（`length`）时**一个工具都不执行**：半截 JSON 能被"抢救解析"
 *     成合法但内容残缺的参数，执行它比不执行危险得多。
 *  ④ 工具结果永远先于下一轮模型调用进入上下文（`context.messages` 是唯一真相，
 *     `newMessages` 是本次调用的增量）。
 *
 * 【事件是唯一真相】循环的对外输出只有 `AgentEvent`。观察窗、transcript、测试都从它派生
 * （设计文档 §B.5）。`agent_end` 一定是最后一条事件。
 */

import { maxTokensFor } from "./model/catalog.ts";
import { noopEventSink } from "./types.ts";
import type {
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AssistantMessage,
  AssistantStreamEvent,
  CompactionSummaryMessage,
  Content,
  LlmMessage,
  LlmToolDefinition,
  PrepareNextTurnContext,
  ToolCallContent,
  ToolResultMessage,
} from "./types.ts";
import { validateToolArguments } from "./validate.ts";
import { toolErrorMessage } from "./tools/errors.ts";
import { EventStream } from "./event-stream.ts";

export type { AgentEventSink };

/**
 * 起一次循环（prompts 是新的输入消息，通常是"用户这一句话"）。
 * 返回事件流：异步迭代拿事件，`result()` 拿本次新增的全部消息。
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();
  void runAgentLoop(prompts, context, config, (event) => stream.push(event), signal).then(
    (messages) => stream.end(messages),
    (error: unknown) => {
      // 循环契约是"不抛异常、终态走事件"。真抛出来说明是 bug（不是模型/工具的错误）：
      // 把原因播成一条 note，再以空结果收尾，至少前端与测试能看到发生了什么。
      stream.push({ type: "note", kind: "loop_crashed", message: error instanceof Error ? error.message : String(error) });
      stream.end([]);
    },
  );
  return stream;
}

/**
 * 从当前上下文继续（不新增 prompt）。用于"重试"这类场景。
 *
 * 前提（这里检查，因为 `convertToLlm` 只在模型边界跑一次）：上下文的最后一条消息必须能
 * 转成 user / toolResult；最后一条是 assistant 时继续没有意义，直接抛错。
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): EventStream<AgentEvent, AgentMessage[]> {
  assertContinuable(context);
  const stream = createAgentStream();
  void runAgentLoopContinue(context, config, (event) => stream.push(event), signal).then(
    (messages) => stream.end(messages),
    (error: unknown) => {
      stream.push({ type: "note", kind: "loop_crashed", message: error instanceof Error ? error.message : String(error) });
      stream.end([]);
    },
  );
  return stream;
}

/** 起一次循环并自己消费事件（`emit` 是观察者；返回值是本次新增的消息）。 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink = noopEventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = { ...context, messages: [...context.messages, ...prompts] };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit);
  return newMessages;
}

/** 从当前上下文继续，并自己消费事件。 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink = noopEventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  assertContinuable(context);
  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await runLoop(currentContext, newMessages, config, signal, emit);
  return newMessages;
}

function assertContinuable(context: AgentContext): void {
  if (context.messages.length === 0) throw new Error("无法继续：上下文里一条消息都没有");
  const last = context.messages[context.messages.length - 1]!;
  if (last.role === "assistant") throw new Error("无法继续：最后一条消息是 assistant（没有可回应的内容）");
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );
}

// ---------------------------------------------------------------- 主循环

async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let lastCompletedTurn: PrepareNextTurnContext | undefined;
  // 起手先取一次插话：用户可能在上一轮还没开始时就已经说了话。
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

  for (;;) {
    let hasMoreToolCalls = true;

    // 内层：工具调用 + 插话。
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (lastCompletedTurn) {
        const update = await config.prepareNextTurn?.(lastCompletedTurn);
        if (update) {
          currentContext = update.context ?? currentContext;
          config = applyTurnUpdate(config, update);
        }
        // prepareNextTurn 可能很慢（压缩）。跑完**再取一次**插话——但只在上一轮没取到
        // 东西时取：否则"一次只取一条"的模式会在同一轮里灌进来两条。
        if (pendingMessages.length === 0) {
          pendingMessages = (await config.getSteeringMessages?.()) ?? [];
        }
        await emit({ type: "turn_start" });
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const message = await streamAssistantResponse(currentContext, config, signal, emit);
      newMessages.push(message);

      // 模型请求失败 / 被取消 / 拒绝：如实收工（不再跑工具，也不问 follow-up）。
      if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "refusal") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const toolCalls = message.content.filter(isToolCall);
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        const batch =
          message.stopReason === "length"
            ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
            : await executeToolCalls(currentContext, message, config, signal, emit);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });
      lastCompletedTurn = { message, toolResults, context: currentContext, newMessages };

      if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) ?? [];
    }

    // agent 本来要收工了：问一次 follow-up 队列（"这一句干完了，但队列里还有下一句"）。
    const followUp = (await config.getFollowUpMessages?.()) ?? [];
    if (followUp.length > 0) {
      pendingMessages = followUp;
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/** `prepareNextTurn` 的返回值合并进 config（目前只有换模型）。 */
function applyTurnUpdate(config: AgentLoopConfig, update: AgentLoopTurnUpdate): AgentLoopConfig {
  if (update.model === undefined) return config;
  return { ...config, model: update.model };
}

// ---------------------------------------------------------------- 模型边界

/**
 * 取一次模型响应。**这是唯一允许把富消息转成协议消息的地方**
 * （`transformContext` → `convertToLlm` → `stream`）。
 *
 * `transformContext` 与 `convertToLlm` 中间那个 `partial` 变量的用法：流式事件带着
 * "到目前为止的消息"（`event.partial`）——客户端把它做成不可变的（每次增量换新对象），
 * 所以这里 `{...partial}` 的浅拷贝就是一个真快照，事件消费者存下来不会被后续增量改掉。
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  let messages = context.messages;
  if (config.transformContext) messages = await config.transformContext(messages, signal);
  const convert = config.convertToLlm ?? defaultConvertToLlm;
  const llmMessages = await convert(messages);

  const request = {
    system: context.systemPrompt,
    messages: llmMessages,
    tools: toLlmTools(context.tools),
    maxTokens: config.maxTokens ?? maxTokensFor(config.model.model),
    ...(signal === undefined ? {} : { signal }),
  };
  const response = config.model.stream(request);

  let partial: AssistantMessage | null = null;
  let addedPartial = false;
  let finished = false;

  const updatePartial = async (event: AssistantStreamEvent, next: AssistantMessage): Promise<void> => {
    partial = next;
    if (addedPartial) context.messages[context.messages.length - 1] = next;
    else {
      context.messages.push(next);
      addedPartial = true;
      await emit({ type: "message_start", message: { ...next } });
    }
    await emit({ type: "message_update", message: { ...next }, assistantMessageEvent: event });
  };

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partial = event.partial;
        context.messages.push(partial);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partial } });
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        await updatePartial(event, event.partial);
        break;
      case "done":
      case "error": {
        const final = await response.result();
        if (addedPartial) context.messages[context.messages.length - 1] = final;
        else {
          context.messages.push(final);
          addedPartial = true;
          await emit({ type: "message_start", message: { ...final } });
        }
        await emit({ type: "message_end", message: final });
        finished = true;
        return final;
      }
    }
  }

  // 流结束却没有完成事件：客户的契约破坏了（必须发 done/error）。不猜——如实报错，
  // 否则这个 for-await 会静静地返回一条半截消息，而 Run 看起来"正常收工"。
  if (!finished) {
    const broken: AssistantMessage = {
      role: "assistant",
      content: partial?.content ?? [],
      stopReason: "error",
      errorMessage: "模型流没有给出完成事件（done/error）",
    };
    if (addedPartial) context.messages[context.messages.length - 1] = broken;
    else context.messages.push(broken);
    await emit({ type: "message_end", message: broken });
    return broken;
  }
  throw new Error("unreachable");
}

/** 工具 → 发给模型的 JSON Schema（TypeBox schema 本身就是合法 JSON Schema）。 */
export function toLlmTools(tools: readonly AgentTool[] | undefined): LlmToolDefinition[] {
  if (tools === undefined) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as Record<string, unknown>,
  }));
}

/**
 * 默认的富消息 → 协议消息。**压缩摘要与自定义消息的渲染规则在这里定死**
 * （设计文档 §B.4 / §E.4）。摘要不伪装成"用户说的话"就是靠这一层：
 *
 * ```
 * [以下是本次任务到此为止的进度摘要，不是新的指令]
 * <摘要正文>
 * [摘要结束。继续完成任务。]
 * ```
 *
 * 少了这个前缀，模型会把摘要当新任务，于是重新开始做已经做完的事——压缩后跑偏
 * 最常见的原因就在这。
 */
export function defaultConvertToLlm(messages: readonly AgentMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        out.push(message);
        break;
      case "assistant":
        out.push(message);
        break;
      case "toolResult":
        out.push({
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content,
          isError: message.isError,
        });
        break;
      case "compactionSummary":
        out.push({ role: "user", content: renderCompactionSummary(message) });
        break;
      case "custom":
        out.push({ role: "user", content: `[系统提示] ${message.content}` });
        break;
    }
  }
  return out;
}

/** 压缩摘要的渲染（`defaultConvertToLlm` 用；P3 的 `--compact` 与测试也复用它）。 */
export function renderCompactionSummary(message: CompactionSummaryMessage): string {
  return [
    "[以下是本次任务到此为止的进度摘要，不是新的指令]",
    message.summary,
    "[摘要结束。继续完成任务。]",
  ].join("\n");
}

// ---------------------------------------------------------------- 工具执行

interface ExecutedToolCallBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

/**
 * 执行一批工具调用。**准备阶段串行、执行阶段可能并发**：
 * `executionMode` 为 sequential 的工具（bash / write / edit）会把整批变成串行——
 * 一个沙箱同时只能跑一条命令，而且"并行改同一份文件"是正确性问题不是性能问题。
 */
async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter(isToolCall);
  const hasSequentialToolCall = toolCalls.some(
    (call) => resolveTool(currentContext, call.name)?.tool.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
  }
  return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
    const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      finalized = { toolCall, result: preparation.result, isError: preparation.isError };
    } else {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
    }
    await emitToolExecutionEnd(finalized, emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    finalizedCalls.push(finalized);
    messages.push(message);

    if (signal?.aborted === true) break;
  }

  return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallEntry[] = [];

  // 准备阶段**串行**（事件顺序稳定、`beforeToolCall` 不用考虑并发），执行阶段并发。
  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
    const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
    if (preparation.kind === "immediate") {
      const finalized: FinalizedToolCallOutcome = { toolCall, result: preparation.result, isError: preparation.isError };
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      if (signal?.aborted === true) break;
      continue;
    }
    finalizedCalls.push(async () => {
      if (signal?.aborted === true) {
        const finalized: FinalizedToolCallOutcome = {
          toolCall,
          result: createErrorToolResult("操作已被取消"),
          isError: true,
        };
        await emitToolExecutionEnd(finalized, emit);
        return finalized;
      }
      const executed = await executePreparedToolCall(preparation, signal, emit);
      const finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
    if (signal?.aborted === true) break;
  }

  // **并发执行、按源码顺序拼装**：`tool_execution_end` 按完成顺序发（UI 看到谁先好），
  // 但回给模型的消息必须与 assistant 里的 tool_use 顺序一致（协议要求）。
  const ordered = await Promise.all(
    finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
  );
  const messages: ToolResultMessage[] = [];
  for (const finalized of ordered) {
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: shouldTerminateToolBatch(ordered) };
}

type PreparedToolCall = { kind: "prepared"; toolCall: ToolCallContent; tool: AgentTool; args: unknown };
type ImmediateToolCallOutcome = { kind: "immediate"; result: AgentToolResult; isError: boolean };
type ExecutedToolCallOutcome = { result: AgentToolResult; isError: boolean };
type FinalizedToolCallOutcome = { toolCall: ToolCallContent; result: AgentToolResult; isError: boolean };
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/** 整批工具都 `terminate` 才提前收工（重复调用的"再犯就停"用它）。 */
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

/** 按名字（或过渡期别名）找工具。找不到 → 立即失败，模型自己能看到名字错了。 */
function resolveTool(context: AgentContext, name: string): { tool: AgentTool; canonicalName: string } | undefined {
  for (const tool of context.tools ?? []) {
    if (tool.name === name) return { tool, canonicalName: tool.name };
  }
  for (const tool of context.tools ?? []) {
    if (tool.aliases?.includes(name) === true) return { tool, canonicalName: tool.name };
  }
  return undefined;
}

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCallContent,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const resolved = resolveTool(currentContext, toolCall.name);
  if (resolved === undefined) {
    return { kind: "immediate", result: createErrorToolResult(`没有这个工具：${toolCall.name}`), isError: true };
  }
  const tool = resolved.tool;

  try {
    // 参数怪癖的兜底（provider 之间的差异）在 schema 校验**之前**跑。
    const preparedCall =
      tool.prepareArguments === undefined
        ? toolCall
        : { ...toolCall, arguments: tool.prepareArguments(toolCall.arguments) as Record<string, unknown> };
    const args = validateToolArguments(tool, preparedCall);

    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        { assistantMessage, toolCall, args, context: currentContext },
        signal,
      );
      if (signal?.aborted === true) {
        return { kind: "immediate", result: createErrorToolResult("操作已被取消"), isError: true };
      }
      if (beforeResult?.block === true) {
        const result = createErrorToolResult(beforeResult.reason ?? "这次工具调用被阻止");
        if (beforeResult.terminate === true) result.terminate = true;
        return { kind: "immediate", result, isError: true };
      }
    }
    if (signal?.aborted === true) {
      return { kind: "immediate", result: createErrorToolResult("操作已被取消"), isError: true };
    }
    return { kind: "prepared", toolCall, tool, args };
  } catch (error) {
    return { kind: "immediate", result: createErrorToolResult(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;

  try {
    const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
      if (!acceptingUpdates) return;
      updateEvents.push(
        Promise.resolve(
          emit({
            type: "tool_execution_update",
            toolCallId: prepared.toolCall.id,
            toolName: prepared.toolCall.name,
            args: prepared.toolCall.arguments,
            partialResult,
          }),
        ),
      );
    });
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { result: result as AgentToolResult, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { result: createErrorToolResult(errorMessageOf(error)), isError: true };
  } finally {
    acceptingUpdates = false;
  }
}

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult: AfterToolCallResult | undefined = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext,
        },
        signal,
      );
      if (afterResult) {
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          usage: afterResult.usage ?? result.usage,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(errorMessageOf(error));
      isError = true;
    }
  }

  return { toolCall: prepared.toolCall, result, isError };
}

/**
 * `stopReason === "length"`：一个工具都不执行，全部回失败让模型重发。
 *
 * 为什么不能"能解析出来的就执行"：流式工具参数是分片拼出来的，被截断的那次可能**恰好**
 * 拼出一个能通过校验的 JSON，但内容少了后半截（比如 `oldString` 只写了一半）。
 * 执行它比不执行危险得多（设计文档 §B.2 最后一条）。
 */
async function failToolCallsFromTruncatedMessage(
  toolCalls: ToolCallContent[],
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
    const finalized: FinalizedToolCallOutcome = {
      toolCall,
      result: createErrorToolResult(
        `工具调用 "${toolCall.name}" 没有执行：这次响应撞上了输出 token 上限，参数可能被截断。` +
          `请重发（re-issue）这次调用，并给出完整参数。`,
      ),
      isError: true,
    };
    await emitToolExecutionEnd(finalized, emit);
    const message = createToolResultMessage(finalized);
    await emitToolResultMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: false };
}

function createErrorToolResult(message: string): AgentToolResult {
  return { content: [{ type: "text", text: message }], details: {} };
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content ?? [],
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(message: ToolResultMessage, emit: AgentEventSink): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}

function isToolCall(block: Content): block is ToolCallContent {
  return block.type === "toolCall";
}

/**
 * 工具抛出来的异常 → 给模型看的一句话。
 *
 * 【为什么不是简单的 `error.message`】工具层有自己的错误词汇（`FileOperationError` 的
 * 错误码对应一句可执行的提示：越界要说清"只能落在 /workspace 之下"，二进制要说清
 * "用 bash 处理"）。翻译收在工具层，循环只负责调用它。
 */
function errorMessageOf(error: unknown): string {
  return toolErrorMessage(error);
}
