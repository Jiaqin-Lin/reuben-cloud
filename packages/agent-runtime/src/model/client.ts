/**
 * `client.ts` —— 模型客户端（从 CP 的 `agent/model.ts` 迁出，Phase 1 §6）。
 *
 * 【这一层为什么在 agent-runtime 里】循环需要它（每一轮都要调模型），而循环在
 * agent-runtime。**"凭据只在 CP"这条红线没有变**：这个文件不读 env 之外的任何秘密，
 * 它只是"把 key 传进来的调用方"的实现细节；CP 是唯一调用 `modelFromEnv()` 的地方，
 * 沙箱侧完全不知道模型的存在（设计文档 §A 的三条边界）。
 *
 * 【为什么是 `stream()` 而不是 M0 的 `create()`】M0 只有一个 `onText` 回调，拿不到
 * 工具调用参数的增量、也拿不到"这一段是思考还是正文"。M2 的事件协议是**唯一真相**
 * （设计文档 §B.5）：增量、工具调用、用量都从同一个流里出来，观察窗、transcript、
 * 测试都从它派生。M0 用流式只是为了不被 SDK 的 HTTP 超时判死
 * （`max_tokens` 给到 64000，非流式会撞），现在流式成了契约本身。
 *
 * 【两家的差异都收在这里，不在循环里】DeepSeek 提供同一套 Messages 协议
 * （`https://api.deepseek.com/anthropic`）：字段名、`stop_reason`、`usage`（含
 * `cache_read_input_tokens`）与工具调用形状都一致。所以"接第二家"的动作是**换 baseURL +
 * 换 key**，不是再写一个客户端。差异只有三条：缓存（Anthropic 要显式 `cache_control`
 * 断点，DeepSeek 自动）、`refusal`（DeepSeek 不返回）、`output_config.effort`（两家都认）。
 *
 * 【不传 temperature / top_p / top_k】当前模型上已被移除，传了会 400（§2 的原话）。
 * 这不是"先不设置"，是"不能设置"。
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  ToolResultBlockParam,
  Tool as SdkTool,
  Usage as SdkUsage,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { createAssistantMessageEventStream } from "../event-stream.ts";
import { noopLog } from "../log.ts";
import type { LogFn } from "../log.ts";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  AssistantStreamEvent,
  Content,
  LlmMessage,
  LlmToolDefinition,
  ModelClient,
  ModelRequest,
  StopReason,
  Usage,
} from "../types.ts";
import { emptyUsage } from "../types.ts";
import { CONSERVATIVE_MODEL_INFO, MODEL_CATALOG } from "./catalog.ts";
import type { RetryPolicy } from "./retry.ts";
import { AbortedError, retryWithBackoff } from "./retry.ts";

// ---------------------------------------------------------------- 常量

/** 默认模型（provider = anthropic）。env `REUBEN_CLOUD_MODEL` 可覆盖（§2）。 */
export const DEFAULT_MODEL = "claude-opus-4-8";

/** DeepSeek 的 Anthropic 兼容端点。 */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";

/** DeepSeek 的默认模型（`REUBEN_CLOUD_MODEL` 可覆盖）。 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

export type ModelProvider = "anthropic" | "deepseek";

/**
 * 思考预算档位（`output_config.effort`）。agent 循环属于"相当复杂"那一档，
 * 默认 high；这个参数比模型选型更影响成本与质量（§2）。
 */
export const DEFAULT_EFFORT = "high";

/** 读 key 的 env 名。**只在 CP 进程里**。 */
export const ENV_API_KEY = "ANTHROPIC_API_KEY";
/** DeepSeek 的 key。与 `ANTHROPIC_API_KEY` 并列：谁在、就用谁（见 `selectProvider`）。 */
export const ENV_DEEPSEEK_API_KEY = "DEEPSEEK_API_KEY";
/** 显式指定 provider（`anthropic` | `deepseek`）。两个 key 都在时才需要它。 */
export const ENV_PROVIDER = "REUBEN_CLOUD_PROVIDER";
/** 覆盖模型的 env 名。 */
export const ENV_MODEL = "REUBEN_CLOUD_MODEL";
/** 覆盖 effort 的 env 名（扫 medium/high/xhigh 时用，§2 结尾那条）。 */
export const ENV_EFFORT = "REUBEN_CLOUD_EFFORT";
/** 覆盖单轮输出上限的 env 名（硬顶是模型目录里的 `maxTokens`）。 */
export const ENV_MAX_TOKENS = "REUBEN_CLOUD_MAX_TOKENS";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// ---------------------------------------------------------------- 错误

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

/**
 * 这个错误值不值得重试。**只认三种**：网络层、限流、服务端 5xx。
 * 400 重试一百次还是 400；401 重试只会把 key 错误拖成"卡住"。
 */
export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ModelError) {
    return error.reason === "unreachable" || error.reason === "rate_limited" || error.reason === "server_error";
  }
  return false;
}

// ---------------------------------------------------------------- 实现

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  /** provider 名（写进日志与账本；同一个实现服务两家）。 */
  provider?: ModelProvider;
  effort?: Effort;
  /** 覆盖 API 端点。给 DeepSeek 用（它说的是同一套 Messages 协议）。 */
  baseURL?: string;
  /** 打开 adaptive thinking。默认开（§2）。关掉只有一个理由：测试要可预测的输出形状。 */
  thinking?: boolean;
  /** 注入 SDK 客户端（测试用；生产不走这条）。 */
  client?: Anthropic;
  /** 重试政策（默认 3 次、1s 起、上限 30s；只在还没吐出任何事件时重试）。 */
  retry?: RetryPolicy;
  log?: LogFn;
}

export class AnthropicModelClient implements ModelClient {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly #client: Anthropic;
  readonly #effort: Effort;
  readonly #thinking: boolean;
  readonly #retry: RetryPolicy;
  readonly #log: LogFn;

  constructor(options: AnthropicModelOptions) {
    if (options.apiKey === "") {
      throw new ModelError("config_missing", `${ENV_API_KEY} 是空的`);
    }
    this.provider = options.provider ?? "anthropic";
    this.model = options.model ?? DEFAULT_MODEL;
    this.#effort = options.effort ?? DEFAULT_EFFORT;
    this.#thinking = options.thinking ?? true;
    this.#retry = options.retry ?? {};
    this.#log = options.log ?? noopLog;
    this.#client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      });
  }

  stream(request: ModelRequest): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream();
    void this.#run(request, out);
    return out;
  }

  /**
   * 跑一次请求（含重试），把结果编码成事件。
   *
   * 【重试的边界：只在还没吐出任何事件时】流式响应一旦开始推送，重试就会让消费方看到
   * 两遍开头。所以谓词是"可重试的错误 **且** 这一轮还没推过事件"——连接阶段失败
   * （最常见的那类）可以安全重试，推到一半断了不行（那会变成 error 终态）。
   */
  async #run(request: ModelRequest, out: AssistantMessageEventStream): Promise<void> {
    let pushed = false;
    try {
      await retryWithBackoff(
        async () => {
          pushed = false;
          await this.#pump(request, out, () => {
            pushed = true;
          });
        },
        {
          ...this.#retry,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          shouldRetry: (error) => !pushed && isRetryableModelError(toModelError(error, request.signal)),
          log: this.#log,
        },
      );
    } catch (error) {
      const modelError = toModelError(error, request.signal);
      const aborted = modelError.reason === "aborted" || error instanceof AbortedError;
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        stopReason: aborted ? "aborted" : "error",
        errorMessage: modelError.message,
        usage: emptyUsage(),
      };
      if (!aborted) this.#log("error", `模型调用失败：${modelError.message}`, { reason: modelError.reason });
      out.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
    }
  }

  /**
   * 一次干净的流：把 Anthropic 的 `RawMessageStreamEvent` 翻译成我们的
   * `AssistantStreamEvent`，并累积出可回传的富消息。
   *
   * 【块对象是不可变的】每次增量都换一个新的块对象与内容数组。这样 `partial` 的
   * **浅拷贝**就是一个真快照（循环把它放进 `message_update`，消费者存下来之后不会被
   * 后续增量改掉），而不需要每次 structuredClone（长回复下那是 O(n²)）。
   */
  async #pump(request: ModelRequest, out: AssistantMessageEventStream, markPushed: () => void): Promise<void> {
    const stream = await this.#client.messages.create(this.#params(request), {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    let partial: AssistantMessage = { role: "assistant", content: [], usage: emptyUsage() };
    /** 每个工具调用的参数 JSON 分片（contentIndex → 已收到的 partial_json）。 */
    const toolJson = new Map<number, string>();
    let refusalReason: string | null = null;

    const emit = (event: AssistantStreamEvent): void => {
      markPushed();
      out.push(event);
    };

    emit({ type: "start", partial });

    for await (const event of stream) {
      switch (event.type) {
        case "message_start": {
          partial = { ...partial, usage: usageFromSdk(event.message.usage) };
          break;
        }
        case "content_block_start": {
          const { index } = event;
          const block = event.content_block;
          switch (block.type) {
            case "text":
              partial = withBlock(partial, index, { type: "text", text: block.text });
              emit({ type: "text_start", contentIndex: index, partial });
              break;
            case "thinking":
              partial = withBlock(partial, index, {
                type: "thinking",
                thinking: block.thinking,
                signature: block.signature,
              });
              emit({ type: "thinking_start", contentIndex: index, partial });
              break;
            case "redacted_thinking":
              partial = withBlock(partial, index, { type: "redacted_thinking", data: block.data });
              break;
            case "tool_use":
              toolJson.set(index, "");
              partial = withBlock(partial, index, {
                type: "toolCall",
                id: block.id,
                name: block.name,
                arguments: {},
              });
              emit({ type: "toolcall_start", contentIndex: index, id: block.id, name: block.name, partial });
              break;
            default:
              // 我们不认识的块（server tool / web search 结果等）：丢掉。
              // 我们没开任何 server tool，真出现它说明协议漂了——丢掉比把
              // 一个没看懂的东西塞回下一轮的 messages 更安全。
              break;
          }
          break;
        }
        case "content_block_delta": {
          const { index } = event;
          const delta = event.delta;
          const block = partial.content[index];
          if (delta.type === "text_delta" && block?.type === "text") {
            partial = withBlock(partial, index, { type: "text", text: block.text + delta.text });
            emit({ type: "text_delta", contentIndex: index, delta: delta.text, partial });
          } else if (delta.type === "thinking_delta" && block?.type === "thinking") {
            partial = withBlock(partial, index, { ...block, thinking: block.thinking + delta.thinking });
            emit({ type: "thinking_delta", contentIndex: index, delta: delta.thinking, partial });
          } else if (delta.type === "signature_delta" && block?.type === "thinking") {
            // 签名是"这段思考确实由模型产生"的凭据，必须原样回传（多轮里丢掉会 400）。
            partial = withBlock(partial, index, { ...block, signature: (block.signature ?? "") + delta.signature });
          } else if (delta.type === "input_json_delta" && block?.type === "toolCall") {
            toolJson.set(index, (toolJson.get(index) ?? "") + delta.partial_json);
            emit({ type: "toolcall_delta", contentIndex: index, delta: delta.partial_json, partial });
          }
          // citations_delta：我们没开引用，忽略。
          break;
        }
        case "content_block_stop": {
          const { index } = event;
          const block = partial.content[index];
          if (block?.type === "text") {
            emit({ type: "text_end", contentIndex: index, content: block.text, partial });
          } else if (block?.type === "thinking") {
            emit({ type: "thinking_end", contentIndex: index, content: block.thinking, partial });
          } else if (block?.type === "toolCall") {
            const finalized: Content = {
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: parseToolArguments(toolJson.get(index) ?? ""),
            };
            partial = withBlock(partial, index, finalized);
            emit({ type: "toolcall_end", contentIndex: index, toolCall: finalized, partial });
          }
          break;
        }
        case "message_delta": {
          if (event.delta.stop_reason !== null && event.delta.stop_reason !== undefined) {
            partial = { ...partial, stopReason: mapStopReason(event.delta.stop_reason) };
            const explanation = event.delta.stop_details?.explanation;
            if (typeof explanation === "string" && explanation.trim() !== "") refusalReason = explanation.trim();
          }
          partial = { ...partial, usage: mergeUsage(partial.usage, event.usage) };
          break;
        }
        case "message_stop":
          break;
        default:
          break;
      }
    }

    // 流结束了但没有 stop_reason：Anthropic 的流不该这样（只有被掐断才会）。
    // 这不是"模型正常收工"，如实报 error 而不是猜一个 stop。
    if (partial.stopReason === undefined) {
      throw new ModelError("unreachable", "模型流结束但没有 stop_reason（连接被中途掐断？）");
    }
    const final: AssistantMessage = {
      ...partial,
      ...(refusalReason === null ? {} : { refusalReason }),
      ...(refusalReason !== null ? { stopReason: "refusal" as StopReason } : {}),
    };
    const reason = final.stopReason ?? "stop";
    if (reason === "error" || reason === "aborted") {
      throw new ModelError("unknown", final.errorMessage ?? "模型返回了 error 终态");
    }
    out.push({ type: "done", reason, message: final });
  }

  /** 请求参数。**system 的最后一块打 `cache_control`**（见文件头与 `toSdkTools` 的排序）。 */
  #params(request: ModelRequest): MessageCreateParamsStreaming {
    return {
      model: this.model,
      max_tokens: request.maxTokens,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: toSdkMessages(request.messages),
      tools: toSdkTools(request.tools),
      ...(this.#thinking ? { thinking: { type: "adaptive" } } : {}),
      output_config: { effort: this.#effort },
      stream: true,
    };
  }
}

// ---------------------------------------------------------------- 从 env 建客户端

/**
 * 一个 provider 选择结果。**只有模型名与 key 的出处**——不含客户端，因为
 * `selectProvider` 是无副作用的纯判断，测试与 `@live` 层都靠它提前知道"有没有凭据"。
 */
export interface ProviderSelection {
  provider: ModelProvider;
  /** 这次要用的模型名（`REUBEN_CLOUD_MODEL` 有值时是它）。 */
  model: string;
  /** 这个 provider 需要的 env 名——报错时要说清缺的是哪一个。 */
  apiKeyEnv: string;
}

/**
 * 选 provider。**这是"多 provider"的全部——没有注册表、没有插件**（§2 的边界）。
 *
 * 优先级（顺序就是排查问题时的顺序）：
 *  1. `REUBEN_CLOUD_PROVIDER` 显式指定（两个 key 都在时唯一的确定性来源）；
 *  2. `REUBEN_CLOUD_MODEL` 的前缀（`deepseek-*` → deepseek，`claude-*` → anthropic）；
 *  3. 哪个 key 在就用哪个（Anthropic 在前——它是 §2 的文档默认值）；
 *  4. 都没有 → `null`（调用方报一句同时提到两个 env 的错）。
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelection | null {
  const explicit = (env[ENV_PROVIDER] ?? "").trim().toLowerCase();
  if (explicit !== "") {
    if (explicit !== "anthropic" && explicit !== "deepseek") {
      throw new ModelError(
        "config_missing",
        `${ENV_PROVIDER} 只认 anthropic / deepseek，收到 ${JSON.stringify(explicit)}`,
      );
    }
    return { provider: explicit, model: modelFor(explicit, env), apiKeyEnv: keyEnvFor(explicit) };
  }

  const rawModel = (env[ENV_MODEL] ?? "").trim();
  if (rawModel.startsWith("deepseek")) {
    return { provider: "deepseek", model: rawModel, apiKeyEnv: ENV_DEEPSEEK_API_KEY };
  }
  if (rawModel.startsWith("claude")) {
    return { provider: "anthropic", model: rawModel, apiKeyEnv: ENV_API_KEY };
  }

  if ((env[ENV_API_KEY] ?? "") !== "") {
    return { provider: "anthropic", model: modelFor("anthropic", env), apiKeyEnv: ENV_API_KEY };
  }
  if ((env[ENV_DEEPSEEK_API_KEY] ?? "") !== "") {
    return { provider: "deepseek", model: modelFor("deepseek", env), apiKeyEnv: ENV_DEEPSEEK_API_KEY };
  }
  return null;
}

/**
 * 从 env 建一个模型客户端，provider 由 `selectProvider()` 决定。
 * 【两家差异与缓存断点的说明见本文件头】。
 *
 * @throws `ModelError(config_missing)` 环境里没有可用凭据，或选中的 provider 缺 key。
 */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env, options: { log?: LogFn } = {}): AnthropicModelClient {
  const selection = selectProvider(env);
  if (selection === null) {
    throw new ModelError(
      "config_missing",
      `没有可用的模型凭据：设 ${ENV_DEEPSEEK_API_KEY} 或 ${ENV_API_KEY}（两个都有时用 ${ENV_PROVIDER} 明确选一个）`,
    );
  }
  const apiKey = env[selection.apiKeyEnv] ?? "";
  if (apiKey === "") {
    throw new ModelError("config_missing", `provider=${selection.provider} 需要 ${selection.apiKeyEnv}`);
  }
  const effort = env[ENV_EFFORT];
  const common = {
    apiKey,
    model: selection.model,
    provider: selection.provider,
    ...(isEffort(effort) ? { effort } : {}),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  return selection.provider === "deepseek"
    ? new AnthropicModelClient({ ...common, baseURL: DEEPSEEK_BASE_URL })
    : new AnthropicModelClient(common);
}

/** 循环要用的默认单轮输出上限：`REUBEN_CLOUD_MAX_TOKENS` 可覆盖，硬顶是模型目录的 `maxTokens`。 */
export function maxTokensFromEnv(model: string, env: NodeJS.ProcessEnv = process.env): number {
  const info = MODEL_CATALOG[model] ?? CONSERVATIVE_MODEL_INFO;
  const raw = env[ENV_MAX_TOKENS];
  if (raw === undefined || raw === "") return info.maxTokens;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelError("config_missing", `${ENV_MAX_TOKENS} 必须是正整数：${raw}`);
  }
  return Math.min(value, info.maxTokens);
}

function modelFor(provider: ModelProvider, env: NodeJS.ProcessEnv): string {
  const raw = (env[ENV_MODEL] ?? "").trim();
  if (raw !== "") return raw;
  return provider === "deepseek" ? DEFAULT_DEEPSEEK_MODEL : DEFAULT_MODEL;
}

function keyEnvFor(provider: ModelProvider): string {
  return provider === "deepseek" ? ENV_DEEPSEEK_API_KEY : ENV_API_KEY;
}

function isEffort(value: string | undefined): value is Effort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

// ---------------------------------------------------------------- 转换

/**
 * 我们的协议消息 → SDK 的参数。
 *
 * 【连续的 toolResult 合成一条 user 消息】Anthropic 要求每个 `tool_use` 紧跟一条配对的
 * `tool_result`；把一次响应里的 3 个工具结果**放在同一条** user 消息里回来是 M0 就有的
 * 契约（拆成三条会训练模型不再并行调用工具，§4 的用例 2）。
 */
export function toSdkMessages(messages: readonly LlmMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  let pendingToolResults: ContentBlockParam[] | null = null;

  const flushToolResults = (): void => {
    if (pendingToolResults !== null) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = null;
    }
  };

  for (const message of messages) {
    if (message.role === "toolResult") {
      const block: ContentBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: toSdkToolResultContent(message.content),
        ...(message.isError ? { is_error: true } : {}),
      };
      if (pendingToolResults === null) pendingToolResults = [block];
      else pendingToolResults.push(block);
      continue;
    }
    flushToolResults();
    if (message.role === "user") {
      out.push({
        role: "user",
        content: typeof message.content === "string" ? message.content : message.content.map(toSdkBlock),
      });
      continue;
    }
    // 空 assistant 消息（error / aborted 的终态）不发出去：Anthropic 不收空 content，
    // 而它也没有任何配对信息可丢。
    const content = message.content.map(toSdkBlock);
    if (content.length === 0) continue;
    out.push({ role: "assistant", content });
  }
  flushToolResults();
  return out;
}

function toSdkBlock(block: Content): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking, signature: block.signature ?? "" };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "toolCall":
      return { type: "tool_use", id: block.id, name: block.name, input: block.arguments };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
      };
  }
}

/** 工具结果的内容：纯文本给字符串，混合内容给数组（与 Anthropic 的两种写法一致）。 */
function toSdkToolResultContent(content: readonly Content[]): ToolResultBlockParam["content"] {
  const texts = content.filter((block): block is Extract<Content, { type: "text" }> => block.type === "text");
  if (texts.length === content.length && texts.length === 1) return texts[0]!.text;
  // 我们的工具结果只可能是 text / image，都在 tool_result 允许的块类型里；
  // SDK 的类型是这个联合的宽泛表达，这里做一次收窄断言（唯一的类型边界）。
  return content.map(toSdkBlock) as ToolResultBlockParam["content"];
}

/** 工具定义 → SDK 参数，**按名字排序**（缓存前缀稳定性，见文件头）。 */
export function toSdkTools(tools: readonly LlmToolDefinition[]): SdkTool[] {
  return [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as SdkTool["input_schema"],
    }));
}

/** `partial.content` 的不可变更新：换新块 + 换新数组（见 `#pump` 的说明）。 */
function withBlock(message: AssistantMessage, index: number, block: Content): AssistantMessage {
  const content = [...message.content];
  content[index] = block;
  return { ...message, content };
}

/**
 * 工具参数的分片拼完之后解析。
 *
 * 【**不做**"抢救解析"】半截 JSON 能被修成一个"合法但内容残缺"的参数，然后执行它——
 * 那比不执行危险得多（设计文档 §B.2 最后一条）。这里解析失败就交一个带
 * `__invalidJson` 的占位参数出去，让 schema 校验报错、模型看到自己发的是什么
 * （`additionalProperties: false` 的 schema 会拒绝它）。
 */
function parseToolArguments(json: string): Record<string, unknown> {
  if (json.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { __invalidJson: json.slice(0, 500) };
  } catch {
    return { __invalidJson: json.slice(0, 500) };
  }
}

/** Anthropic 的 `stop_reason` → 我们 provider 无关的词汇（见 `types.ts` 的 `StopReason`）。 */
function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "refusal";
    case "model_context_window_exceeded":
      // 上下文超窗：让循环把它当成一次"要压缩"的信号（P3 的溢出恢复）。
      return "length";
    default:
      // 认不出的 stop_reason 不猜：当成一次模型错误，至少不会静默地把一次
      // 截断当成正常收工（协议新增取值时这里会先在日志里冒出来）。
      return "error";
  }
}

function usageFromSdk(usage: SdkUsage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** 合并 `message_delta` 的用量（它的语义是"累计值"，null 表示这次没带）。 */
function mergeUsage(current: Usage | undefined, delta: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage {
  const base = current ?? emptyUsage();
  return {
    inputTokens: delta.input_tokens ?? base.inputTokens,
    outputTokens: delta.output_tokens ?? base.outputTokens,
    cacheReadInputTokens: delta.cache_read_input_tokens ?? base.cacheReadInputTokens,
    cacheCreationInputTokens: delta.cache_creation_input_tokens ?? base.cacheCreationInputTokens,
  };
}

/** SDK 的异常 → `ModelError`。**按 reason 分类**，调用方不匹配字符串（与其余模块一致）。 */
export function toModelError(error: unknown, signal?: AbortSignal): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof AbortedError) return new ModelError("aborted", error.message, { cause: error });
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
