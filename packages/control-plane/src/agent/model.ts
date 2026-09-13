/**
 * `model.ts` —— 模型客户端（Phase 11 §2）。**这一层是 CP 独占的**：§F.3 的红线是
 * "模型 API key 只在 CP，从不进沙箱"，而这条红线落到代码上就是"只有这个文件 import
 * SDK、只有它读 `ANTHROPIC_API_KEY`"。沙箱侧完全不知道模型的存在。
 *
 * 【为什么先定一个 `ModelClient` 接口，而只实现一家】§0.2 的边界：MVP 只有 Anthropic。
 * 接口存在的意义不是"可插拔"，而是让**循环与工具**能在没有网络、没有 key 的情况下被
 * 完整测到（`test/unit/agent-loop.test.ts` 的脚本化模型就是它的一个实现）。
 * 第二个 provider 出现之前，不需要注册表、不需要工厂、不需要配置文件。
 *
 * 【为什么要 `messages.stream()` + `finalMessage()` 而不是 `messages.create()`】
 * agent 循环的 `max_tokens` 要给到 64000（长 tool_use 参数、长 diff 阅读），
 * 非流式请求在这个量级会撞 SDK 的 HTTP 超时。流式不是为了给 UI 打字机效果
 * （那是 Phase 13），是为了不让请求在服务端算完之前被客户端判死。
 * `onText` 回调把文字增量推给 transcript/UI，没有消费者时就是 no-op。
 *
 * 【为什么 system 的最后一块打 `cache_control`】Anthropic 的提示词缓存是**前缀匹配**，
 * 渲染顺序是 tools → system → messages。把断点打在 system 末尾，等于把 tools + system
 * 一起缓存；模型是追加式的，所以这个前缀天然字节稳定（§6 的原话）。
 * 因此这个文件里**没有**任何把 runId / 时间戳插进 system 的写法——那会让每轮都重新写缓存。
 *
 * 【不传 temperature / top_p / top_k】当前模型上已被移除，传了会 400（§2 的原话）。
 * 这不是"先不设置"，是"不能设置"。
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock as SdkContentBlock,
  ContentBlockParam,
  MessageParam,
  Tool as SdkTool,
  StopReason,
} from "@anthropic-ai/sdk/resources/messages/messages";

// ---------------------------------------------------------------- 常量

/** 默认模型。env `REUBEN_CLOUD_MODEL` 可覆盖（§2）。 */
export const DEFAULT_MODEL = "claude-opus-4-8";

/**
 * 单次请求的输出上限。64000 是当前模型的硬上限：给足的理由是"一次 tool_use 里写
 * 一个几百行的文件"完全可能，撞 max_tokens 会让那一轮的 tool_use 变成半截。
 */
export const MAX_MODEL_OUTPUT_TOKENS = 64_000;

/**
 * 思考预算档位（`output_config.effort`）。agent 循环属于"相当复杂"那一档，
 * 默认 high；这个参数比模型选型更影响成本与质量（§2）。
 */
export const DEFAULT_EFFORT = "high";

/** 读 key 的 env 名。**只在 CP 进程里**。 */
export const ENV_API_KEY = "ANTHROPIC_API_KEY";
/** 覆盖模型的 env 名。 */
export const ENV_MODEL = "REUBEN_CLOUD_MODEL";
/** 覆盖 effort 的 env 名（扫 medium/high/xhigh 时用，§2 结尾那条）。 */
export const ENV_EFFORT = "REUBEN_CLOUD_EFFORT";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// ---------------------------------------------------------------- 类型

/** 我们认得的输出块。**认不出的块要原样保留**（见 `fromSdkContent`）。 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 思考块。多轮里要**原样回传**（含 signature），否则 API 会 400。 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;

/** 回填给模型的工具结果。**必须**与某个 tool_use 的 id 配对。 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** 对话里的一条消息。assistant 侧只装 `ContentBlock`，user 侧还装 `ToolResultBlock`。 */
export interface Message {
  role: "user" | "assistant";
  content: string | Array<ContentBlock | ToolResultBlock>;
}

/** 工具的 JSON Schema 定义。**手写**，不引 zod（§3：4 个工具、每个 2–3 个参数）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelRequest {
  system: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  maxTokens: number;
  /** 文字增量回调（Phase 13 的实时 transcript 用；没有消费者时是 no-op）。 */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: ContentBlock[];
  /** `end_turn` / `tool_use` / `max_tokens` / `refusal` / 其他（原样透出，不猜）。 */
  stopReason: string;
  usage: Usage;
  /** `refusal` 时的结构化补充（模型的拒绝说明，可能为空）。 */
  refusalReason: string | null;
}

export interface ModelClient {
  /** 模型名（写进 transcript 与 Run 结果，事后要能对上"这次跑的是哪个模型"）。 */
  readonly model: string;
  create(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelErrorReason =
  /** 没有 API key（启动时就该暴露，不要等到第一轮）。 */
  | "config_missing"
  /** 网络层失败（连不上、超时）。 */
  | "unreachable"
  /** 401 / 403：key 不对或没有权限。 */
  | "unauthorized"
  /** 429：限流。 */
  | "rate_limited"
  /** 5xx / overloaded：服务端的问题，重试有意义。 */
  | "server_error"
  /** 400：请求本身不合法（模型名错、参数错）。 */
  | "invalid_request"
  /** 被调用方 abort（墙钟到点、用户取消）。 */
  | "aborted"
  /** 其他。 */
  | "unknown";

export class ModelError extends Error {
  readonly reason: ModelErrorReason;
  readonly status: number | null;
  readonly details: Record<string, unknown>;

  constructor(
    reason: ModelErrorReason,
    message: string,
    options: { status?: number | null; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelError";
    this.reason = reason;
    this.status = options.status ?? null;
    this.details = options.details ?? {};
  }
}

// ---------------------------------------------------------------- Anthropic 实现

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  effort?: Effort;
  /** 打开 adaptive thinking。默认开（§2）。关掉只有一个理由：测试要可预测的输出形状。 */
  thinking?: boolean;
  /** 注入 SDK 客户端（测试用；生产不走这条）。 */
  client?: Anthropic;
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string;
  readonly #client: Anthropic;
  readonly #effort: Effort;
  readonly #thinking: boolean;

  constructor(options: AnthropicModelOptions) {
    if (options.apiKey === "") {
      throw new ModelError("config_missing", `${ENV_API_KEY} 是空的`);
    }
    this.model = options.model ?? DEFAULT_MODEL;
    this.#effort = options.effort ?? DEFAULT_EFFORT;
    this.#thinking = options.thinking ?? true;
    this.#client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const params = {
      model: this.model,
      max_tokens: request.maxTokens,
      // 断点打在最后一块 = tools + system 一起进缓存（见文件头）。
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: toSdkMessages(request.messages),
      // **按名字排序**：缓存前缀必须字节稳定，而数组顺序一变前缀就变（§6 的验证提示）。
      tools: toSdkTools(request.tools),
      ...(this.#thinking ? { thinking: { type: "adaptive" } } : {}),
      output_config: { effort: this.#effort },
    } satisfies Parameters<Anthropic["messages"]["stream"]>[0];

    const stream = this.#client.messages.stream(
      params,
      request.signal === undefined ? {} : { signal: request.signal },
    );
    if (request.onText !== undefined) {
      const onText = request.onText;
      stream.on("text", (delta) => onText(delta));
    }

    let message;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      throw toModelError(error, request.signal);
    }

    return {
      content: fromSdkContent(message.content),
      stopReason: message.stop_reason ?? "end_turn",
      usage: fromSdkUsage(message.usage),
      refusalReason: refusalReasonOf(message.stop_reason, message.content),
    };
  }
}

/** 从 env 建一个客户端。缺 key → `config_missing`（**不**给默认 key、不延迟到第一轮）。 */
export function anthropicFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicModelClient {
  const apiKey = env[ENV_API_KEY] ?? "";
  if (apiKey === "") {
    throw new ModelError("config_missing", `缺 ${ENV_API_KEY}：agent 循环需要模型凭据（只在 CP 里）`);
  }
  const rawModel = env[ENV_MODEL];
  const effort = env[ENV_EFFORT];
  return new AnthropicModelClient({
    apiKey,
    ...(rawModel === undefined || rawModel === "" ? {} : { model: rawModel }),
    ...(isEffort(effort) ? { effort } : {}),
  });
}

/** 循环要用的默认单轮输出上限：`REUBEN_CLOUD_MAX_TOKENS` 可覆盖，硬顶在 `MAX_MODEL_OUTPUT_TOKENS`。 */
export function maxTokensFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["REUBEN_CLOUD_MAX_TOKENS"];
  if (raw === undefined || raw === "") return MAX_MODEL_OUTPUT_TOKENS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelError("config_missing", `REUBEN_CLOUD_MAX_TOKENS 必须是正整数：${raw}`);
  }
  return Math.min(value, MAX_MODEL_OUTPUT_TOKENS);
}

function isEffort(value: string | undefined): value is Effort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

// ---------------------------------------------------------------- 转换

/**
 * 我们的消息 → SDK 的参数。**一个地方做，所有调用点共用**：
 * 类型边界只在这里有一次断言，别处都是我们的类型。
 */
export function toSdkMessages(messages: readonly Message[]): MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : message.content.map(toSdkBlock),
  }));
}

function toSdkBlock(block: ContentBlock | ToolResultBlock): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
      };
  }
}

/** 工具定义 → SDK 参数，**按名字排序**（缓存前缀稳定性，见文件头）。 */
export function toSdkTools(tools: readonly ToolDefinition[]): SdkTool[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as SdkTool["input_schema"],
    }));
}

/**
 * SDK 的响应块 → 我们的块。
 *
 * 【认不出的块直接丢掉，但 reasoning 类一定留】当前只有这四种会出现（我们没开任何
 * server tool）。真出现别的类型时，丢掉它比把 `unknown` 塞进下一轮的 messages 更安全——
 * 后者会让 API 因为一个我们没看懂的东西 400。**唯独 thinking 不能丢**：
 * 多轮里丢掉思考块会让工具调用失去上下文，而且带 signature 的思考块是校验过的。
 */
function fromSdkContent(blocks: readonly SdkContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "thinking":
        out.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
        break;
      case "redacted_thinking":
        out.push({ type: "redacted_thinking", data: block.data });
        break;
      case "tool_use":
        out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        break;
      default:
        break;
    }
  }
  return out;
}

function fromSdkUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * `stop_reason === "refusal"` 是**正常终态**，不是异常（§2）：content 可能为空，
 * 循环要如实记录并停下，Phase 12 的 PR 正文里也要写"模型拒绝了这次请求"。
 */
function refusalReasonOf(stopReason: StopReason | null, content: readonly SdkContentBlock[]): string | null {
  if (stopReason !== "refusal") return null;
  const texts = content.filter((block) => block.type === "text").map((block) => block.text);
  return texts.join("\n").trim() === "" ? null : texts.join("\n").trim();
}

/** SDK 的异常 → `ModelError`。**按 reason 分类**，调用方不匹配字符串（与其余模块一致）。 */
export function toModelError(error: unknown, signal?: AbortSignal): ModelError {
  if (error instanceof ModelError) return error;
  if (signal?.aborted === true) {
    return new ModelError("aborted", "模型请求被取消", { cause: error });
  }
  const candidate = error as { status?: number; name?: string; message?: string };
  const status = typeof candidate.status === "number" ? candidate.status : null;
  const message = candidate.message ?? String(error);
  if (candidate.name === "AbortError" || candidate.name === "APIUserAbortError") {
    return new ModelError("aborted", message, { cause: error });
  }
  if (status === 401 || status === 403) {
    return new ModelError("unauthorized", message, { status, cause: error });
  }
  if (status === 429) {
    return new ModelError("rate_limited", message, { status, cause: error });
  }
  if (status === 400 || status === 404) {
    return new ModelError("invalid_request", message, { status, cause: error });
  }
  if (status !== null && status >= 500) {
    return new ModelError("server_error", message, { status, cause: error });
  }
  if (status === null && candidate.name === "APIConnectionError") {
    return new ModelError("unreachable", message, { cause: error });
  }
  return new ModelError("unknown", message, { status, cause: error });
}
