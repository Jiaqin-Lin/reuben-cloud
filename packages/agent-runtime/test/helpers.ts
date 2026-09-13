/**
 * `helpers.ts` —— agent-runtime 单测的脚手架（不是测试文件，`node --test test/*.test.ts` 不会跑它）。
 *
 * 【为什么不 mock 到最底层】循环的测试要能回答"事件顺序对不对、工具按什么顺序跑、
 * 插话在哪一轮注入"这类问题。所以脚本化的是**模型**（它只产出事件），真实的是循环、
 * 校验、工具执行与消息拼装——被测的那一层永远是真的。
 */

import { createAssistantMessageEventStream } from "../src/event-stream.ts";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AssistantMessage,
  AssistantMessageEventStream,
  AssistantStreamEvent,
  Content,
  LlmToolDefinition,
  ModelClient,
  ModelRequest,
  StopReason,
  ToolCallContent,
  Usage,
} from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

// ---------------------------------------------------------------- 脚本化模型

export function text(value: string): Content {
  return { type: "text", text: value };
}

export function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCallContent {
  return { type: "toolCall", id, name, arguments: args };
}

export function usageOf(outputTokens: number): Usage {
  return { inputTokens: 100, outputTokens, cacheReadInputTokens: 90, cacheCreationInputTokens: 0 };
}

/** 一步脚本：拿到流之后自己 push 事件（可以 await，模拟慢响应）。 */
export type ScriptStep = (stream: AssistantMessageEventStream, request: ModelRequest) => void | Promise<void>;

/** 一步文本响应（含增量，用来验证 message_update）。 */
export function stepText(
  text: string,
  options: { stopReason?: StopReason; outputTokens?: number; usage?: Usage } = {},
): ScriptStep {
  const reason = options.stopReason ?? "stop";
  return (stream) => {
    if (reason === "error" || reason === "aborted") throw new Error("stepText 只处理正常终态；用 stepError");
    const message: AssistantMessage = {
      role: "assistant",
      content: [textChunk("")],
      usage: options.usage ?? usageOf(options.outputTokens ?? 10),
    };
    stream.push({ type: "start", partial: { ...message } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...message } });
    let accumulated = "";
    for (const chunk of splitChunks(text)) {
      accumulated += chunk;
      message.content = [textChunk(accumulated)];
      stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: { ...message } });
    }
    message.content = [textChunk(text)];
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: { ...message } });
    message.stopReason = reason;
    stream.push({ type: "done", reason, message: { ...message } });
  };
}

function textChunk(value: string): Content {
  return { type: "text", text: value };
}

/** 一步工具调用响应（每个调用产生 toolcall_start/delta/end）。 */
export function stepToolCalls(
  calls: ToolCallContent[],
  options: { stopReason?: StopReason; usage?: Usage } = {},
): ScriptStep {
  const reason = options.stopReason ?? "toolUse";
  return (stream) => {
    const message: AssistantMessage = { role: "assistant", content: [], usage: options.usage ?? usageOf(20) };
    stream.push({ type: "start", partial: message });
    message.content = [...calls];
    calls.forEach((call, index) => {
      stream.push({ type: "toolcall_start", contentIndex: index, id: call.id, name: call.name, partial: { ...message } });
      stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: JSON.stringify(call.arguments),
        partial: { ...message },
      });
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: { ...message } });
    });
    message.stopReason = reason;
    if (reason === "length") stream.push({ type: "done", reason: "length", message: { ...message } });
    else if (reason === "stop") stream.push({ type: "done", reason: "stop", message: { ...message } });
    else if (reason === "refusal") stream.push({ type: "done", reason: "refusal", message: { ...message } });
    else stream.push({ type: "done", reason: "toolUse", message: { ...message } });
  };
}

/** 一步"流到一半报错"（连接断了 / 被取消）。 */
export function stepError(reason: "error" | "aborted", errorMessage = "boom"): ScriptStep {
  return (stream) => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: reason,
      errorMessage,
      usage: emptyUsage(),
    };
    stream.push({ type: "start", partial: { ...message, stopReason: undefined } });
    stream.push({ type: "error", reason, error: message });
  };
}

/** 按脚本回答的模型。脚本用完之后的请求返回一条 `stop`（避免忘了写终止条件）。 */
export class ScriptedModel implements ModelClient {
  readonly provider = "scripted";
  readonly model = "scripted-test";
  readonly requests: ModelRequest[] = [];
  readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.steps = steps;
  }

  stream(request: ModelRequest): AssistantMessageEventStream {
    const index = this.requests.length;
    this.requests.push(request);
    const step = this.steps[index] ?? stepText("(script exhausted)");
    return streamFromStep(step, request);
  }
}

/**
 * 按请求内容选脚本的模型（摘要请求与主对话请求要分流时用它）。
 *
 * 【为什么需要它】P3 的压缩会在主循环中间插入一次摘要请求，用固定顺序的脚本表达
 * "第几次请求答什么"很脆（加一条断言就要重排全部步骤）。路由函数让测试写成
 * "摘要请求走这个、主对话按计数走"——顺序不再是断言的一部分。
 *
 * 两个分流口按 `cache` 分：P3 的摘要请求一律 `cache: "none"`（见 `summarize.ts`）。
 */
export class RoutingModel implements ModelClient {
  readonly provider = "scripted";
  readonly model = "scripted-test";
  readonly requests: ModelRequest[] = [];
  readonly #route: (request: ModelRequest, index: number) => ScriptStep;

  constructor(route: (request: ModelRequest, index: number) => ScriptStep) {
    this.#route = route;
  }

  /** 主对话请求。 */
  mainRequests(): ModelRequest[] {
    return this.requests.filter((request) => request.cache !== "none");
  }

  /** 摘要请求。 */
  summaryRequests(): ModelRequest[] {
    return this.requests.filter((request) => request.cache === "none");
  }

  stream(request: ModelRequest): AssistantMessageEventStream {
    const index = this.requests.length;
    this.requests.push(request);
    return streamFromStep(this.#route(request, index), request);
  }
}

/** 一步脚本 → 一条流（脚本化模型的共用机器）。 */
function streamFromStep(step: ScriptStep, request: ModelRequest): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  // 异步推：真实的模型不会在同一个 tick 里把整条流吐完，测试也不该假设这一点。
  void Promise.resolve()
    .then(() => step(stream, request))
    .catch((error: unknown) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        usage: emptyUsage(),
      };
      stream.push({ type: "error", reason: "error", error: message });
    });
  return stream;
}

function splitChunks(text: string): string[] {
  if (text.length <= 4) return [text];
  return [text.slice(0, 4), text.slice(4)];
}

// ---------------------------------------------------------------- 录制

/** 把事件收进数组，顺便给一个"只看类型"的视图。 */
export function createEventRecorder(): {
  emit: (event: AgentEvent) => void;
  events: AgentEvent[];
  types: () => string[];
  ofType: <T extends AgentEvent["type"]>(type: T) => Array<Extract<AgentEvent, { type: T }>>;
} {
  const events: AgentEvent[] = [];
  return {
    emit: (event) => {
      events.push(event);
    },
    events,
    types: () => events.map((event) => event.type),
    ofType: <T extends AgentEvent["type"]>(type: T) =>
      events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type),
  };
}

// ---------------------------------------------------------------- 假工具

export interface FakeTool extends AgentTool {
  readonly calls: Array<{ id: string; args: unknown }>;
}

export interface FakeToolOptions {
  /** 执行体（默认立刻返回一段文本）。 */
  execute?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
  /** 执行耗时（给"并行/串行"的判定用）。 */
  delayMs?: number;
  executionMode?: "sequential" | "parallel";
  aliases?: string[];
}

/** 一个可观测的假工具：记下每次调用，行为可注入。 */
export function fakeTool(name: string, options: FakeToolOptions = {}): FakeTool {
  const calls: Array<{ id: string; args: unknown }> = [];
  return {
    name,
    label: name,
    description: `${name} (test)`,
    parameters: { type: "object" },
    ...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    calls,
    async execute(id, args: never, signal, onUpdate) {
      calls.push({ id, args });
      onUpdate?.({ content: [{ type: "text", text: `partial:${name}` }], details: {} });
      if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.execute !== undefined) return options.execute(args as Record<string, unknown>, signal);
      return { content: [{ type: "text", text: `ok:${name}` }], details: {} };
    },
  };
}

/** 从消息数组里挑出 toolResult（按顺序）。 */
export function toolResultsOf(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role === "toolResult");
}

/** 只比对事件类型的顺序，附带第一条不匹配的位置（失败信息可读）。 */
export function assertTypeOrder(actual: readonly string[], expected: readonly string[]): void {
  const limit = Math.max(actual.length, expected.length);
  for (let index = 0; index < limit; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `事件序列在第 ${index} 个不同：期望 ${expected[index] ?? "(无)"}，实际 ${actual[index] ?? "(无)"}\n` +
          `实际序列：${actual.join(" → ")}`,
      );
    }
  }
}

/** 工具定义（给要看 tools 参数的测试用）。 */
export function llmTool(name: string): LlmToolDefinition {
  return { name, description: "", inputSchema: { type: "object" } };
}
