/**
 * Phase 11 · 模型客户端（不需要网络、不需要 key）。
 *
 * 这里守的是"发出去的请求长什么样"——因为**提示词缓存是前缀匹配**，请求形状里任何
 * 一处不稳定（工具顺序、system 里插了时间戳、传了 temperature）都会让缓存静默失效，
 * 而失效的表现只是"账单变贵"，没有任何报错。测试要点 10 就是对它的验证。
 *
 * 另外两点是 spec §2 的硬要求：`thinking: adaptive` + `output_config.effort` 必须传，
 * `temperature` / `top_p` / `top_k` 绝对不能传（当前模型上会 400）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicModelClient,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  MAX_MODEL_OUTPUT_TOKENS,
  ModelError,
  anthropicFromEnv,
  maxTokensFromEnv,
  toModelError,
  toSdkMessages,
  toSdkTools,
} from "../../src/agent/model.ts";
import type { Message, ToolDefinition } from "../../src/agent/model.ts";
import { buildSystemPrompt, buildTaskPrompt } from "../../src/agent/prompt.ts";

interface FakeResponse {
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** 一个假的 SDK 客户端：把请求参数记下来，按脚本回一个最终消息。 */
function fakeAnthropic(captured: unknown[], response: FakeResponse, deltas: string[] = []) {
  const client = {
    messages: {
      stream: (params: unknown) => {
        captured.push(params);
        const handlers: Array<(delta: string) => void> = [];
        const stream = {
          on: (event: string, callback: (delta: string) => void) => {
            if (event === "text") handlers.push(callback);
            return stream;
          },
          finalMessage: async () => {
            for (const delta of deltas) for (const handler of handlers) handler(delta);
            return response;
          },
        };
        return stream;
      },
    },
  };
  return client as unknown as Anthropic;
}

const TOOLS: ToolDefinition[] = [
  { name: "write", description: "写文件", input_schema: { type: "object", properties: {} } },
  { name: "bash", description: "跑命令", input_schema: { type: "object", properties: {} } },
  { name: "read", description: "读文件", input_schema: { type: "object", properties: {} } },
  { name: "list", description: "列目录", input_schema: { type: "object", properties: {} } },
];

const MESSAGES: Message[] = [
  { role: "user", content: "把 bug 修了" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先看看代码", signature: "sig-1" },
      { type: "tool_use", id: "tu_1", name: "read", input: { path: "src/a.ts" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu_1", content: "const a = 1;\n", is_error: false }],
  },
];

describe("Phase 11 · AnthropicModelClient 的请求形状", () => {
  test("model / max_tokens / adaptive thinking / effort 都在；temperature 绝不在", async () => {
    const captured: unknown[] = [];
    const client = new AnthropicModelClient({
      apiKey: "sk-test",
      client: fakeAnthropic(captured, {
        content: [{ type: "text", text: "好" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    });
    const response = await client.create({
      system: "你是 agent",
      messages: MESSAGES,
      tools: TOOLS,
      maxTokens: MAX_MODEL_OUTPUT_TOKENS,
    });

    const params = captured[0] as Record<string, unknown>;
    assert.equal(params["model"], DEFAULT_MODEL);
    assert.equal(params["max_tokens"], MAX_MODEL_OUTPUT_TOKENS);
    assert.deepEqual(params["thinking"], { type: "adaptive" });
    assert.deepEqual(params["output_config"], { effort: DEFAULT_EFFORT });
    assert.equal("temperature" in params, false);
    assert.equal("top_p" in params, false);
    assert.equal("top_k" in params, false);
    assert.equal(response.stopReason, "end_turn");
    assert.deepEqual(response.usage, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  test("system 的最后一块带 cache_control（tools + system 一起进缓存）", async () => {
    const captured: unknown[] = [];
    const client = new AnthropicModelClient({
      apiKey: "sk-test",
      client: fakeAnthropic(captured, {
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    });
    await client.create({ system: "S", messages: [], tools: [], maxTokens: 100 });
    const params = captured[0] as { system: Array<Record<string, unknown>> };
    assert.deepEqual(params.system, [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  });

  test("工具按名字排序后再发（缓存前缀必须字节稳定）", async () => {
    const captured: unknown[] = [];
    const client = new AnthropicModelClient({
      apiKey: "sk-test",
      client: fakeAnthropic(captured, {
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    });
    await client.create({ system: "S", messages: [], tools: TOOLS, maxTokens: 100 });
    const params = captured[0] as { tools: Array<{ name: string }> };
    assert.deepEqual(
      params.tools.map((tool) => tool.name),
      ["bash", "list", "read", "write"],
    );
    // 输入的数组本身不能被改动（否则第二轮的前缀就变了）。
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      ["write", "bash", "read", "list"],
    );
  });

  test("消息转换：thinking 与 tool_use / tool_result 原样往返", () => {
    const converted = toSdkMessages(MESSAGES);
    assert.equal(converted.length, 3);
    assert.deepEqual(converted[0], { role: "user", content: "把 bug 修了" });
    const assistant = converted[1]!.content as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(assistant[0], { type: "thinking", thinking: "先看看代码", signature: "sig-1" });
    assert.deepEqual(assistant[1], { type: "tool_use", id: "tu_1", name: "read", input: { path: "src/a.ts" } });
    const user = converted[2]!.content as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(user[0], { type: "tool_result", tool_use_id: "tu_1", content: "const a = 1;\n", is_error: false });
  });

  test("onText 收到文字增量", async () => {
    const captured: unknown[] = [];
    const client = new AnthropicModelClient({
      apiKey: "sk-test",
      client: fakeAnthropic(
        captured,
        { content: [{ type: "text", text: "hello world" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
        ["hello ", "world"],
      ),
    });
    const deltas: string[] = [];
    await client.create({ system: "S", messages: [], tools: [], maxTokens: 10, onText: (delta) => deltas.push(delta) });
    assert.deepEqual(deltas, ["hello ", "world"]);
  });

  test("响应映射：thinking / tool_use / cache_read 都留下", async () => {
    const captured: unknown[] = [];
    const client = new AnthropicModelClient({
      apiKey: "sk-test",
      client: fakeAnthropic(captured, {
        content: [
          { type: "thinking", thinking: "想", signature: "sig" },
          { type: "redacted_thinking", data: "gAAAA" },
          { type: "text", text: "我来改" },
          { type: "tool_use", id: "tu_9", name: "bash", input: { cmd: ["ls"] } },
          { type: "server_tool_use", id: "st_1", name: "web_search", input: {} },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 },
      }),
    });
    const response = await client.create({ system: "S", messages: [], tools: [], maxTokens: 100 });
    assert.deepEqual(
      response.content.map((block) => block.type),
      ["thinking", "redacted_thinking", "text", "tool_use"],
    );
    assert.equal(response.usage.cacheReadInputTokens, 4096);
    assert.equal(response.stopReason, "tool_use");
  });

  test("refusal 是正常终态（带上模型的说明）", async () => {
    const captured: unknown[] = [];
    const client = new AnthropicModelClient({
      apiKey: "sk-test",
      client: fakeAnthropic(captured, {
        content: [{ type: "text", text: "我不能做这件事" }],
        stop_reason: "refusal",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const response = await client.create({ system: "S", messages: [], tools: [], maxTokens: 10 });
    assert.equal(response.stopReason, "refusal");
    assert.equal(response.refusalReason, "我不能做这件事");
    assert.equal(response.content.length, 1);
  });
});

describe("Phase 11 · 配置与错误分类", () => {
  test("缺 ANTHROPIC_API_KEY 在构造时就抛 config_missing", () => {
    assert.throws(() => anthropicFromEnv({}), (error: unknown) => (error as ModelError).reason === "config_missing");
    const withKey = anthropicFromEnv({ ANTHROPIC_API_KEY: "sk-test", REUBEN_CLOUD_MODEL: "claude-opus-4-5" });
    assert.equal(withKey.model, "claude-opus-4-5");
  });

  test("maxTokensFromEnv 有硬顶，非法值直接报错（不静默截断）", () => {
    assert.equal(maxTokensFromEnv({}), MAX_MODEL_OUTPUT_TOKENS);
    assert.equal(maxTokensFromEnv({ REUBEN_CLOUD_MAX_TOKENS: "1000" }), 1000);
    assert.equal(maxTokensFromEnv({ REUBEN_CLOUD_MAX_TOKENS: "999999" }), MAX_MODEL_OUTPUT_TOKENS);
    assert.throws(() => maxTokensFromEnv({ REUBEN_CLOUD_MAX_TOKENS: "abc" }));
  });

  test("toModelError 按状态码分类", () => {
    assert.equal(toModelError({ status: 401 }).reason, "unauthorized");
    assert.equal(toModelError({ status: 403 }).reason, "unauthorized");
    assert.equal(toModelError({ status: 429 }).reason, "rate_limited");
    assert.equal(toModelError({ status: 400 }).reason, "invalid_request");
    assert.equal(toModelError({ status: 529 }).reason, "server_error");
    assert.equal(toModelError({ name: "APIConnectionError" }).reason, "unreachable");
    assert.equal(toModelError({ name: "APIUserAbortError" }).reason, "aborted");
    assert.equal(toModelError(new Error("???"), AbortSignal.abort()).reason, "aborted");
    assert.equal(toModelError(new Error("???")).reason, "unknown");
  });

  test("toSdkTools 不修改入参", () => {
    const tools: ToolDefinition[] = [
      { name: "b", description: "b", input_schema: { type: "object" } },
      { name: "a", description: "a", input_schema: { type: "object" } },
    ];
    const converted = toSdkTools(tools);
    assert.deepEqual(converted.map((tool) => tool.name), ["a", "b"]);
    assert.deepEqual(tools.map((tool) => tool.name), ["b", "a"]);
  });
});

describe("Phase 11 · 提示词", () => {
  test("system 字节稳定：同一输入两次拼出来完全一样，且不含会变的东西", () => {
    const first = buildSystemPrompt();
    const second = buildSystemPrompt();
    assert.equal(first, second);
    // 缓存前缀不能带 runId / 时间戳 / commit（§6）。
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(first), false);
    assert.equal(first.includes("run_"), false);
    assert.equal(first.includes("/workspace/repo"), true);
    assert.equal(first.includes("2000 行或 50 KB"), true);
    assert.equal(first.includes('["bash","-lc","…"]'), true);
  });

  test("issue 在第一条 user 消息里（不是 system 里）", () => {
    const task = buildTaskPrompt("登录按钮点不动");
    assert.equal(task.includes("登录按钮点不动"), true);
    assert.equal(buildSystemPrompt().includes("登录按钮点不动"), false);
  });
});
