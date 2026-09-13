/**
 * Phase 1 · 模型层（不需要网络：SDK 客户端是注入的假实现）。
 *
 * 验三件事：
 *  · 协议转换：我们的富消息 ↔ Anthropic 的线上形状（连续 toolResult 合成一条 user 消息、
 *    工具定义排序、thinking 签名原样回传）；
 *  · 流式映射：Anthropic 的 raw stream events → 我们的 `AssistantStreamEvent` + 终态消息；
 *  · 政策：provider 选择、单轮输出上限、退避重试（含"已经吐出事件就不重试"）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicModelClient,
  DEEPSEEK_BASE_URL,
  ENV_API_KEY,
  ENV_DEEPSEEK_API_KEY,
  ENV_MAX_TOKENS,
  ENV_MODEL,
  ENV_PROVIDER,
  ModelError,
  isRetryableModelError,
  maxTokensFromEnv,
  modelFromEnv,
  selectProvider,
  toSdkMessages,
  toSdkTools,
} from "../src/model/client.ts";
import { CONSERVATIVE_MODEL_INFO, lookupModel } from "../src/model/catalog.ts";
import { retryWithBackoff, sleepWithSignal, AbortedError } from "../src/model/retry.ts";
import type { AssistantMessage, AssistantStreamEvent, LlmMessage } from "../src/types.ts";

// ---------------------------------------------------------------- 假 SDK

type RawEvent = Record<string, unknown>;

/** 一个按脚本回答的 Anthropic 客户端。脚本项是事件数组，或一个要抛的错。 */
function fakeSdk(scripts: Array<RawEvent[] | Error>): Anthropic {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        const step = scripts[calls] ?? [];
        calls += 1;
        if (step instanceof Error) throw step;
        return (async function* () {
          for (const event of step) yield event;
        })();
      },
    },
  };
  return client as unknown as Anthropic;
}

function client(scripts: Array<RawEvent[] | Error>, options: { thinking?: boolean; retry?: object } = {}): AnthropicModelClient {
  return new AnthropicModelClient({
    apiKey: "test-key",
    model: "claude-opus-4-8",
    client: fakeSdk(scripts),
    thinking: options.thinking ?? false,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
}

async function collect(stream: AsyncIterable<AssistantStreamEvent> & { result(): Promise<AssistantMessage> }): Promise<{
  events: AssistantStreamEvent[];
  message: AssistantMessage;
}> {
  const events: AssistantStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

const MSG_START: RawEvent = {
  type: "message_start",
  message: {
    id: "msg_1",
    usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
  },
};
const MSG_DELTA = (stopReason: string): RawEvent => ({
  type: "message_delta",
  delta: { stop_reason: stopReason, stop_details: null },
  usage: { output_tokens: 42, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null },
});
const MSG_STOP: RawEvent = { type: "message_stop" };

function textScript(text: string, stopReason = "end_turn"): RawEvent[] {
  return [
    MSG_START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    MSG_DELTA(stopReason),
    MSG_STOP,
  ];
}

// ---------------------------------------------------------------- 协议转换

describe("Phase 1 · 协议转换", () => {
  test("连续的 toolResult 合成一条 user 消息；空 assistant 消息被丢掉", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "做三件事" },
      { role: "assistant", content: [] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tu_1", name: "read", arguments: { path: "a" } },
          { type: "toolCall", id: "tu_2", name: "read", arguments: { path: "b" } },
        ],
      },
      { role: "toolResult", toolCallId: "tu_1", toolName: "read", content: [{ type: "text", text: "A" }], isError: false },
      { role: "toolResult", toolCallId: "tu_2", toolName: "read", content: [{ type: "text", text: "B" }], isError: true },
    ];
    const sdk = toSdkMessages(messages);
    assert.equal(sdk.length, 3, "空 assistant 应当被丢掉");
    assert.equal(sdk[0]!.role, "user");
    assert.equal(sdk[1]!.role, "assistant");
    assert.equal(sdk[2]!.role, "user");
    const blocks = sdk[2]!.content as unknown as Array<Record<string, unknown>>;
    assert.equal(blocks.length, 2, "两条 toolResult 必须在同一条 user 消息里");
    assert.equal(blocks[0]!["tool_use_id"], "tu_1");
    assert.equal(blocks[1]!["is_error"], true);
  });

  test("thinking 块带签名回传；工具定义按名字排序", () => {
    const sdk = toSdkMessages([
      { role: "assistant", content: [{ type: "thinking", thinking: "想一想", signature: "sig-1" }] },
    ]);
    const block = (sdk[0]!.content as unknown as Array<Record<string, unknown>>)[0]!;
    assert.equal(block["type"], "thinking");
    assert.equal(block["signature"], "sig-1");

    const tools = toSdkTools([
      { name: "write", description: "w", inputSchema: { type: "object" } },
      { name: "bash", description: "b", inputSchema: { type: "object" } },
    ]);
    assert.deepEqual(tools.map((tool) => tool.name), ["bash", "write"]);
  });
});

// ---------------------------------------------------------------- 流式映射

describe("Phase 1 · 流式映射", () => {
  test("文本流 → start / text_start / text_delta / text_end / done，用量与 stopReason 正确", async () => {
    const model = client([textScript("你好")]);
    const { events, message } = await collect(model.stream({ system: "s", messages: [], tools: [], maxTokens: 100 }));
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_start", "text_delta", "text_end", "done"],
    );
    const delta = events.find((event) => event.type === "text_delta");
    assert.equal(delta?.type === "text_delta" ? delta.delta : null, "你好");
    // partial 快照不可变：text_delta 那一刻的 partial 里就是当时的文本。
    assert.deepEqual(message.content, [{ type: "text", text: "你好" }]);
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.usage, {
      inputTokens: 100,
      outputTokens: 42,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 20,
    });
  });

  test("工具调用流：参数分片拼装、toolcall_end 给出解析后的 arguments", async () => {
    const model = client([
      [
        MSG_START,
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'th":"a"}' } },
        { type: "content_block_stop", index: 0 },
        MSG_DELTA("tool_use"),
        MSG_STOP,
      ],
    ]);
    const { events, message } = await collect(model.stream({ system: "s", messages: [], tools: [], maxTokens: 100 }));
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"],
    );
    assert.deepEqual(message.content, [{ type: "toolCall", id: "tu_1", name: "read", arguments: { path: "a" } }]);
    assert.equal(message.stopReason, "toolUse");
  });

  test("stop_reason 映射：max_tokens → length、refusal → refusal（带说明）", async () => {
    const length = await collect(client([textScript("x", "max_tokens")]).stream({ system: "s", messages: [], tools: [], maxTokens: 10 }));
    assert.equal(length.message.stopReason, "length");

    const refusal = await collect(
      client([
        [
          MSG_START,
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "refusal", stop_details: { explanation: "涉及敏感内容" } },
            usage: { output_tokens: 1 },
          },
          MSG_STOP,
        ],
      ]).stream({ system: "s", messages: [], tools: [], maxTokens: 10 }),
    );
    assert.equal(refusal.message.stopReason, "refusal");
    assert.equal(refusal.message.refusalReason, "涉及敏感内容");
  });

  test("请求失败 → error 事件 + stopReason=error（不抛异常）", async () => {
    const failure = Object.assign(new Error("rate limited"), { status: 429 });
    const model = client([failure], { retry: { attempts: 1 } });
    const { events, message } = await collect(model.stream({ system: "s", messages: [], tools: [], maxTokens: 10 }));
    assert.equal(events[0]?.type, "error");
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /rate limited/);
  });

  test("重试：连接阶段失败可以重试；已经吐出事件之后失败不再重试", async () => {
    const failure = Object.assign(new Error("boom"), { status: 500 });
    const slept: number[] = [];
    const retrying = client([failure, textScript("第二次成功")], {
      retry: { attempts: 2, baseDelayMs: 5, sleep: async (ms: number) => void slept.push(ms) },
    });
    const ok = await collect(retrying.stream({ system: "s", messages: [], tools: [], maxTokens: 10 }));
    assert.equal(ok.message.stopReason, "stop");
    assert.deepEqual(ok.message.content, [{ type: "text", text: "第二次成功" }]);
    assert.deepEqual(slept, [5]);

    // 先吐 start 再抛：不能重试（否则消费者会看到两遍开头）。
    let call = 0;
    const clientWithFlakyStream = new AnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-4-8",
      thinking: false,
      client: {
        messages: {
          create: async () => {
            call += 1;
            return (async function* () {
              yield MSG_START;
              yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
              throw new Error("stream broke");
            })();
          },
        },
      } as unknown as Anthropic,
      retry: { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
    });
    const broken = await collect(clientWithFlakyStream.stream({ system: "s", messages: [], tools: [], maxTokens: 10 }));
    assert.equal(broken.message.stopReason, "error");
    assert.equal(call, 1, "已经吐出事件之后不许重试");
  });

  test("abort：signal 已取消 → aborted 终态", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error("aborted"), { name: "APIUserAbortError" });
    const model = client([abortError], { retry: { attempts: 1 } });
    const { message } = await collect(
      model.stream({ system: "s", messages: [], tools: [], maxTokens: 10, signal: controller.signal }),
    );
    assert.equal(message.stopReason, "aborted");
  });
});

// ---------------------------------------------------------------- provider 与目录

describe("Phase 1 · provider 选择与模型目录", () => {
  test("显式 provider > 模型前缀 > 哪个 key 在 > null", () => {
    assert.equal(selectProvider({ [ENV_PROVIDER]: "deepseek" })?.provider, "deepseek");
    assert.equal(selectProvider({ [ENV_MODEL]: "deepseek-flash" })?.provider, "deepseek");
    assert.equal(selectProvider({ [ENV_MODEL]: "claude-opus-4-8" })?.provider, "anthropic");
    assert.equal(selectProvider({ [ENV_API_KEY]: "k" })?.provider, "anthropic");
    assert.equal(selectProvider({ [ENV_DEEPSEEK_API_KEY]: "k" })?.provider, "deepseek");
    assert.equal(selectProvider({}), null);
    assert.throws(() => selectProvider({ [ENV_PROVIDER]: "openai" }), ModelError);
  });

  test("modelFromEnv：deepseek 走兼容端点，缺 key 明确报错", () => {
    const deepseek = modelFromEnv({ [ENV_DEEPSEEK_API_KEY]: "k", [ENV_MODEL]: "deepseek-flash" });
    assert.equal(deepseek.provider, "deepseek");
    assert.equal(deepseek.model, "deepseek-flash");
    assert.ok(DEEPSEEK_BASE_URL.includes("deepseek"));
    assert.throws(() => modelFromEnv({ [ENV_PROVIDER]: "deepseek" }), /DEEPSEEK_API_KEY/);
    assert.throws(() => modelFromEnv({}), /没有可用的模型凭据/);
  });

  test("单轮输出上限取模型目录的值，env 只能往小调", () => {
    assert.equal(maxTokensFromEnv("claude-opus-4-8", {}), 64_000);
    assert.equal(maxTokensFromEnv("claude-opus-4-8", { [ENV_MAX_TOKENS]: "1000" }), 1000);
    assert.equal(maxTokensFromEnv("claude-opus-4-8", { [ENV_MAX_TOKENS]: "999999" }), 64_000);
    assert.throws(() => maxTokensFromEnv("claude-opus-4-8", { [ENV_MAX_TOKENS]: "abc" }), ModelError);
  });

  test("未知模型 → 保守默认 + 一条 warn", () => {
    const logs: string[] = [];
    const info = lookupModel("some-new-model", (level, message) => logs.push(`${level}:${message}`));
    assert.deepEqual(info, CONSERVATIVE_MODEL_INFO);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^warn:/);
  });

  test("isRetryableModelError：只认网络 / 限流 / 5xx", () => {
    assert.equal(isRetryableModelError(new ModelError("rate_limited", "429")), true);
    assert.equal(isRetryableModelError(new ModelError("server_error", "500")), true);
    assert.equal(isRetryableModelError(new ModelError("unreachable", "conn")), true);
    assert.equal(isRetryableModelError(new ModelError("invalid_request", "400")), false);
    assert.equal(isRetryableModelError(new Error("nope")), false);
  });
});

// ---------------------------------------------------------------- 退避重试

describe("Phase 1 · 退避重试", () => {
  test("指数退避、上限封顶、成功即返回", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("flaky");
        return "ok";
      },
      { attempts: 5, baseDelayMs: 100, factor: 3, maxDelayMs: 500, sleep: async (ms) => void delays.push(ms) },
    );
    assert.equal(result, "ok");
    assert.deepEqual(delays, [100, 300]);
  });

  test("shouldRetry=false → 立刻抛原错误；次数用尽 → 抛最后一次", async () => {
    const fatal = new Error("fatal");
    await assert.rejects(
      () => retryWithBackoff(async () => { throw fatal; }, { attempts: 3, shouldRetry: () => false, sleep: async () => {} }),
      fatal,
    );
    let calls = 0;
    await assert.rejects(
      () =>
        retryWithBackoff(
          async () => {
            calls += 1;
            throw new Error(`第 ${calls} 次`);
          },
          { attempts: 2, baseDelayMs: 1, sleep: async () => {} },
        ),
      /第 2 次/,
    );
  });

  test("等待期间被取消 → AbortedError", async () => {
    const controller = new AbortController();
    await assert.rejects(
      () =>
        retryWithBackoff(
          async () => {
            controller.abort();
            throw new Error("flaky");
          },
          { attempts: 3, baseDelayMs: 1, signal: controller.signal },
        ),
      (error: unknown) => error instanceof AbortedError,
    );
    const already = new AbortController();
    already.abort();
    await assert.rejects(() => sleepWithSignal(10, already.signal), AbortedError);
  });
});
