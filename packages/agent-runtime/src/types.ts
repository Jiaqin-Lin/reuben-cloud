/**
 * `types.ts` —— Agent Runtime 的**全部契约**（M2 Phase 1）。
 *
 * 【这个文件是干什么的】它是"循环 / 工具 / 提示词"三者之间唯一的形状约定，也是 CP 与
 * agent-runtime 之间的边界。契约按 pi（`/Users/reuben/Documents/pi` 的
 * `packages/agent/src/types.ts`）的形状写，**字段名不改**——理由不是"照抄"，而是：
 * 同一个概念在两处用不同的名字（我们叫 `tool_use`、pi 叫 `toolCall`）会让"对照实现排查"
 * 这件事每次都多一层翻译。参考的是契约与取舍，不是规模（设计文档 §B）。
 *
 * 【与 M0 的三处形状差异，都是有意的】
 *  ① **富消息（AgentMessage）与协议消息（LlmMessage）分开**。M0 只有一种 `Message`，
 *     于是"压缩摘要 / 技能提示 / 审批记录"只能伪装成 user 文本。伪装会让模型把摘要当新指令，
 *     这是压缩后跑偏最常见的原因（设计文档 §B.4）。这里分成两层：循环内部一律用富消息，
 *     **只在模型边界**用 `convertToLlm` 转一次。
 *  ② **工具内容块叫 `toolCall` + `arguments`**（Anthropic 线上协议叫 `tool_use` + `input`）。
 *     协议细节收在 `model/client.ts` 的转换里；循环与工具不该认识任何一家的线上格式。
 *  ③ **工具有 `label` / `replay` / `executionMode`**：给 UI 显示的名字、崩溃后的重放策略、
 *     并行还是串行。M0 只有前三个字段，M2 的 registry 与 intent/settlement 都要用到这些。
 *
 * 【为什么这里没有"Run 结果"类型】`agentLoop()` 的返回值就是 `AgentMessage[]`（与 pi 一致）。
 * "这次 Run 成功了吗、为什么停的"是**宿主**的判断：CP 侧根据事件流、停止策略与重复守卫
 * 拼出 `AgentStopReason`（见 `control-plane/src/agent/run.ts`）。循环自己不认识
 * "成功/失败"，它只认识"这一轮做了什么、下一轮还要不要跑"。
 */

import type { Static, TSchema } from "typebox";

// ---------------------------------------------------------------- 内容块

/** 纯文本。 */
export interface TextContent {
  type: "text";
  text: string;
}

/**
 * 思考块。多轮对话里**必须原样回传**（含 `signature`），否则 Anthropic 会 400；
 * 这也是它和普通文本一样进 messages 的原因。
 */
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/** 被安全策略加密掉的思考块（我们看不懂，但要原样回传）。 */
export interface RedactedThinkingContent {
  type: "redacted_thinking";
  data: string;
}

/** 图片（M2 的 read 还不会产生它，但协议里有，工具结果类型要能表达）。 */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * 模型发出的一次工具调用。`arguments` 是**未校验**的原始参数
 * （循环在 `execute` 之前用工具的 TypeBox schema 校验，校验失败变成 isError 结果）。
 */
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type Content = TextContent | ThinkingContent | RedactedThinkingContent | ImageContent | ToolCallContent;

// ---------------------------------------------------------------- 停止原因

/**
 * 一次模型响应的停止原因，**provider 无关的词汇**。
 *
 * 与 Anthropic 线上 `stop_reason` 的对应关系收在 `model/client.ts`：
 *  `end_turn`→`stop` / `max_tokens`→`length` / `tool_use`→`toolUse` / `refusal`→`refusal`。
 * `error`（请求失败）与 `aborted`（被取消）是循环自己加的两种终态——模型永远不返回它们。
 *
 * 【为什么 `refusal` 是独立取值而不是折进 `error`】M0 的语义是"模型拒绝"是**正常终态**：
 * 循环如实记录并停下，PR 正文里写"模型拒绝了这次请求"。pi 把它折进 error；我们保留
 * 自己的四个字（这是设计文档允许的偏差：口径以我们的 `AgentStopReason` 为准）。
 */
export type StopReason = "stop" | "length" | "toolUse" | "refusal" | "error" | "aborted";

// ---------------------------------------------------------------- 用量

/**
 * 一次模型调用的用量。字段名沿用 provider 的"输入/输出/缓存读/缓存写"四个量，
 * 而不是 pi 的 `input/output/cacheRead/cacheWrite` 短名——账本（P2 的 `usage_ledger`）
 * 的列名就是这四个，改名的收益只有少敲几个字符。
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 四个量都是 0 的用量（脚本化模型与"还没调用过"的初值用它）。 */
export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

/** 累加用量（就地改 `target`）。账本与 Run 结果都用"这一次执行的总量"。 */
export function accumulateUsage(target: Usage, delta: Usage | undefined): Usage {
  if (delta === undefined) return target;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadInputTokens += delta.cacheReadInputTokens;
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens;
  return target;
}

// ---------------------------------------------------------------- 富消息

export interface UserMessage {
  role: "user";
  content: string | Content[];
}

export interface AssistantMessage {
  role: "assistant";
  content: Content[];
  /** 缺省 = 这一轮还没定稿（流式中的 partial 消息）。 */
  stopReason?: StopReason;
  usage?: Usage;
  /** `error` / `aborted` 时的人读原因（也进事件流与日志）。 */
  errorMessage?: string;
  /** `refusal` 时模型给出的拒绝说明（可能为空）。 */
  refusalReason?: string | null;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Content[];
  /**
   * 结构化事实（退出码、日志路径、截断信息、改动行数、diff）。
   * **不进模型**——它给 UI、日志与恢复用（设计文档 §B.3 最值钱的两条之一）。
   */
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

/**
 * 压缩摘要（P3 生产、P3 的 `convertToLlm` 渲染）。
 *
 * 【为什么它必须是一种消息类型而不是拼进 user 文本】摘要要进存储、要在 UI 上显示，
 * 但**不该伪装成"用户说的话"**——模型会把它当新任务，于是重新开始做已经做完的事。
 * `firstKeptEntryId` 与 `tokensBefore` 是"这份摘要覆盖了哪一段"的证据。
 */
export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

/**
 * 应用自定义消息（技能提示、审批记录、循环旁路说明）。`display` 决定 UI 展不展示；
 * 它总是以 `[系统提示]` 前缀进模型（见 `defaultConvertToLlm`）。
 */
export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string;
  display: boolean;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CompactionSummaryMessage
  | CustomMessage;

// ---------------------------------------------------------------- 协议消息

/**
 * 送进模型的那一层消息（`convertToLlm` 的输出）。
 *
 * 【为什么 toolResult 是一个独立的 role，而不是"user 消息里的一个块"】那是 Anthropic
 * 的线上形状。保持 provider 无关，`model/client.ts` 负责把连续的 toolResult 合成
 * **一条** user 消息（Anthropic 要求 tool_result 配 tool_use，拆成多条 message 也能过，
 * 但合成一条是 pi 的做法，也是缓存前缀更稳定的做法）。
 */
export interface LlmUserMessage {
  role: "user";
  content: string | Content[];
}

export interface LlmAssistantMessage {
  role: "assistant";
  content: Content[];
}

export interface LlmToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Content[];
  isError: boolean;
}

export type LlmMessage = LlmUserMessage | LlmAssistantMessage | LlmToolResultMessage;

/** 发给模型的工具定义。`inputSchema` 是 TypeBox schema（本身就是合法 JSON Schema）。 */
export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------- 流式事件

/**
 * 模型流的一次增量。
 *
 * 【为什么每条都带 `partial`】`message_update` 事件要求带"到目前为止的完整消息"，
 * 而只有累积者（模型客户端）知道它。让每条增量捎上 `partial` 之后，循环与前端都不用
 * 自己再拼一遍（pi 的形状）。循环把 `partial` 做**浅拷贝**当作快照——客户端每产生
 * 一次增量都换一个新的块对象与内容数组，所以旧快照不会被后续增量改掉。
 *
 * 【为什么连 start/end 也要有】工具调用的参数是分片到达的（`input_json_delta`），
 * 只发 delta 的话消费方要自己判断"这个 contentIndex 是新块还是接上一块"；
 * 带上 start/end 之后，前端与测试都能只认事件、不猜状态。
 */
export type AssistantStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; id: string; name: string; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
  /** 正常收尾。`message` 就是终态（与 pi 一样把终态挂在完成事件上）。 */
  | { type: "done"; reason: Exclude<StopReason, "error" | "aborted">; message: AssistantMessage }
  /** 失败 / 被取消。**不抛异常**，终态走这里（契约见 `ModelClient`）。 */
  | { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };

/**
 * 流式响应：异步迭代拿到增量，`result()` 拿最终消息
 * （与 pi 的 `AssistantMessageEventStream` 同形）。
 */
export interface AssistantMessageEventStream extends AsyncIterable<AssistantStreamEvent> {
  /** 推一条增量。完成事件之后推的一律丢弃（一个定稿的流不该再变）。 */
  push(event: AssistantStreamEvent): void;
  /** 结束流（正常情况下完成事件自己就终结了它；这个给"没有完成事件"的兜底用）。 */
  end(result?: AssistantMessage): void;
  /** 终态。可以多次 await。 */
  result(): Promise<AssistantMessage>;
}

// ---------------------------------------------------------------- 模型边界

/** 一次模型请求。**只有协议形状**（富消息已经被 `convertToLlm` 转过一次）。 */
export interface ModelRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
}

/**
 * 模型客户端。M0 的 `create()` 换成 `stream()`：不是"为了打字机效果"，而是
 * 事件流是**唯一真相**（设计文档 §B.5）——把增量、工具调用参数、用量都在一个通道里
 * 交出来，观察窗、transcript、测试都从它派生，不存在第二套。
 *
 * 契约（与 pi 的 StreamFn 一致，两条都必须守）：
 * ① **不抛异常**：请求失败要编码成 `error` / `aborted` 事件 + 一条 stopReason 为
 *    `error`/`aborted` 的 AssistantMessage。抛异常会让循环缺事件、前端卡在半截。
 * ② 返回的流可以被 `for await` 消费，`result()` 与迭代结束后的终态一致。
 */
export interface ModelClient {
  /** provider 名（`anthropic` / `deepseek`），进日志与账本。 */
  readonly provider: string;
  /** 模型名（写进 transcript 与 Run 结果，事后要能对上"这次跑的是哪个模型"）。 */
  readonly model: string;
  stream(request: ModelRequest): AssistantMessageEventStream;
}

// ---------------------------------------------------------------- 工具

/** 工具的执行结果。`content` 进模型，`details` 不进（见 `ToolResultMessage.details`）。 */
export interface AgentToolResult<TDetails = unknown> {
  content: Content[];
  details: TDetails;
  /** 这次工具执行自己的用量（例如 MCP 的计费）；不计入主对话的上下文账。 */
  usage?: Usage;
  /** 整批工具都 `terminate` 时提前收工（只被"重复调用"这类守卫用）。 */
  terminate?: boolean;
  /** 这个结果从此让哪些工具可用（技能/MCP 的懒加载，P11/P13 用）。 */
  addedToolNames?: string[];
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partial: AgentToolResult<TDetails>) => void;

/**
 * 工具契约。与 pi 同形（字段名不改），只有一处**过渡期**扩展：
 * `aliases` 让旧名字（M0 的 `list`）还能被解析到同一个工具——模型看不到别名，
 * 但会话/历史里出现旧名字时不会变成"没有这个工具"。下个版本删掉（spec 附录 A-2）。
 */
export interface AgentTool<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  /** UI 上显示的名字（与 `name` 分开：`name` 是模型看到的标识符）。 */
  label: string;
  /** 直接决定模型调用准确率，值得反复打磨（设计文档 §F.3）。 */
  description: string;
  /** TypeBox schema：一份声明同时给 TS 类型、JSON Schema、运行时校验。 */
  parameters: TParams;
  /** provider 参数怪癖的兜底（在 schema 校验**之前**跑）。 */
  prepareArguments?(args: unknown): unknown;
  /** 执行。**失败要抛异常**，循环把它转成 `isError` 结果（而不是让工具自己编码错误）。 */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
  /** 崩溃恢复时的重放策略（P2 的 intent/settlement 用它；M2 只登记）。 */
  replay?: "never" | "safe";
  /** 有 `sequential` 的工具时，整批工具串行（pi 的判定，见 `loop.ts`）。 */
  executionMode?: "sequential" | "parallel";
  /** 【过渡期】旧工具名。命中别名时执行同一个工具，但工具清单里只出现 `name`。 */
  aliases?: string[];
}

// ---------------------------------------------------------------- 循环上下文与配置

/** 循环的输入：系统提示词 + 已有消息 + 可用工具。 */
export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

/** 一轮结束时的快照（`shouldStopAfterTurn` / `prepareNextTurn` 都拿它）。 */
export interface ShouldStopAfterTurnContext {
  /** 刚结束的那条 assistant 消息。 */
  message: AssistantMessage;
  /** 这一轮的工具结果（source 顺序）。 */
  toolResults: ToolResultMessage[];
  /** 这一轮结束后的完整上下文。 */
  context: AgentContext;
  /** 本次 `agentLoop` 会返回的消息（含 prompt；continue 时为增量）。 */
  newMessages: AgentMessage[];
}

export type PrepareNextTurnContext = ShouldStopAfterTurnContext;

/** `prepareNextTurn` 的返回值：替换下一轮要用的上下文 / 模型。 */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: ModelClient;
}

/**
 * 工具执行模式。`sequential` = 一个一个来（`bash`、`edit` 必须是这个）；
 * `parallel` = 准备阶段串行、执行阶段并发（读类工具）。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/** `beforeToolCall` 的返回：`block: true` 阻止执行，`reason` 成为那条 isError 结果。 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  /** 整批工具都这么标 → 这一批结束后收工（重复调用的"再犯就停"用它）。 */
  terminate?: boolean;
}

export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCallContent;
  args: unknown;
  context: AgentContext;
}

/** `afterToolCall` 的返回：按字段替换执行结果（没有深合并）。 */
export interface AfterToolCallResult {
  content?: Content[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
  terminate?: boolean;
}

export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCallContent;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

/**
 * 循环的全部可配项。**循环自己不知道任何预算**（设计文档 §B.2）：
 * 轮数 / 墙钟 / 输出 token 都在 `shouldStopAfterTurn` 策略里（`limits.ts` 提供默认实现），
 * 压缩挂在 `prepareNextTurn`，上下文编译挂在 `transformContext`。
 */
export interface AgentLoopConfig {
  /** 模型客户端（`prepareNextTurn` 可以换掉它，实现"中途换模型"）。 */
  model: ModelClient;
  maxTokens?: number;
  /**
   * 富消息 → 协议消息。**每轮调用一次**，就在模型调用之前。
   * 缺省用 `defaultConvertToLlm`（user/assistant/toolResult 直通，摘要与自定义消息
   * 渲染成带前缀的 user 文本）。
   */
  convertToLlm?: (messages: AgentMessage[]) => LlmMessage[] | Promise<LlmMessage[]>;
  /**
   * 送模型前对富消息做一次整体变换（上下文编译 / 裁剪）。**不改变存储**。
   * 契约：不抛异常、返回安全的回退值。
   */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /**
   * 一轮完全结束后调用。返回 true → 发 `agent_end` 收工（不再轮询 steering/follow-up）。
   * 预算（40 轮 / 30 分钟 / 300k 输出 token）走的就是这个钩子。
   */
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  /**
   * 下一轮开始前调用（压缩、换模型、重编译上下文）。返回 undefined = 什么都不改。
   * 【注意时机】它在 `turn_end` 之后、`turn_start` 之前跑，跑完会**再取一次** steering
   * （压缩可能耗时，用户可能刚插话）。
   */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  /**
   * 取"插话"消息（P1 的 `steer()`）。**每次只取一条**由调用方决定：
   * 循环在每轮工具结束后取一次，取到就注入、不打断正在跑的工具。
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  /** agent 本来要收工时再问一次：有消息就继续跑（follow-up 队列）。 */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  /** 缺省 `parallel`（有 sequential 工具时自动整批串行）。 */
  toolExecution?: ToolExecutionMode;
  /** 工具执行前（参数已校验）。返回 `{block:true}` 可阻止执行。 */
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  /** 工具执行后、事件发出前。可以改结果（重复提示就挂在这里）。 */
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

// ---------------------------------------------------------------- 事件

/**
 * 循环对外的**唯一**事件协议（设计文档 §B.5：不再有"第二套真相"）。
 *
 * 【每条事件都要能被独立渲染】`turn` / `id` / `toolCallId` 都自带，前端不需要看前一条
 * 才知道怎么渲染这一条。代价是几字节的重复，收益是前端没有状态机、乱序也不会渲染错位。
 *
 * 与 pi 的差异只有三个**新增事件**（设计文档 §B.6）：`context_compiled`（P10）、
 * `compaction`（P3）、`note`（循环旁路信息：重复调用提示、上下文告警）。
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantStreamEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "context_compiled"; turn: number; sections: SectionStat[]; hash: string }
  | { type: "compaction"; reason: "threshold" | "overflow" | "manual"; tokensBefore: number; firstKeptEntryId: string }
  | { type: "note"; kind: string; message: string };

/** `context_compiled` 里每个分区的统计（P10 的 ContextCompiler 产出）。 */
export interface SectionStat {
  name: string;
  tokens: number;
  hash: string;
}

/**
 * 事件的消费者：一个函数。**只有"收"这一个动作**——谁来收、收多少、怎么缓冲是接收端的事。
 * 允许返回 Promise（消费者要落库时），循环会 await 它——但**发射方永远不为消费者兜底**：
 * 消费者的异常在 CP 侧的适配器里被吞掉（一条 warn），不冒泡进循环。
 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 没有观察者时的 sink（比 `() => {}` 表意清楚）。 */
export const noopEventSink: AgentEventSink = () => {};
