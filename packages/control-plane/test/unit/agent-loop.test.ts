/**
 * Phase 11 · Agent 循环（不需要网络、不需要模型、不需要 Docker）。
 *
 * 用「脚本化模型 + 假工具箱 + 真 transcript（临时目录）」跑，所以这里验的都是**循环
 * 自己的性质**——对应 spec「测试要点」的 1、2、6、7、9：
 *  - 固定 tool_use 序列 → 工具被调用、结果回填、正常终止
 *  - 一条响应里两个 tool_use → 两个 tool_result 在**同一条** user 消息里
 *  - 永远是工具调用 → 撞轮数上限并如实说明
 *  - 同一调用连续 3 次 → 插提示；再犯 → 停止
 *  - transcript 含 system / tools / 每轮 usage
 * 另有墙钟、输出 token 预算、模型报错、abort、上下文裁剪、transcript 上传这六条边界。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { noopLog } from "../../src/log.ts";
import type { StoredObject } from "../../src/artifacts/store.ts";
import type { ArtifactStore } from "../../src/artifacts/store.ts";
import type { ContentBlock, Message, ModelClient, ModelRequest, ModelResponse, ToolDefinition } from "../../src/agent/model.ts";
import { ModelError } from "../../src/agent/model.ts";
import type { AgentToolkit } from "../../src/agent/tools/index.ts";
import type { ToolResult } from "../../src/agent/tools/types.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import {
  DEFAULT_MAX_TURNS,
  ELIDED_TOOL_RESULT,
  REPEAT_NOTICE,
  runAgentLoop,
  stableJson,
  trackRepeats,
  trimOldToolResults,
} from "../../src/agent/loop.ts";

// ---------------------------------------------------------------- 脚手架

let workDir = "";

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "rc-loop-"));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

let transcriptSeq = 0;

async function newTranscript(): Promise<Transcript> {
  transcriptSeq += 1;
  return Transcript.create({
    runId: `run_test_${transcriptSeq}`,
    path: path.join(workDir, `transcript-${transcriptSeq}.jsonl`),
  });
}

function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

function toolUse(id: string, name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id, name, input };
}

function usage(outputTokens = 10): ModelResponse["usage"] {
  return { inputTokens: 100, outputTokens, cacheReadInputTokens: 90, cacheCreationInputTokens: 0 };
}

/** 按脚本回答的模型。脚本用完之后一直返回 end_turn（避免忘了写终止条件）。 */
class ScriptedModel implements ModelClient {
  readonly model = "scripted-test";
  readonly requests: ModelRequest[] = [];
  readonly #script: Array<ModelResponse | ((request: ModelRequest) => ModelResponse)>;

  constructor(script: Array<ModelResponse | ((request: ModelRequest) => ModelResponse)>) {
    this.#script = script;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const step = this.#script[this.requests.length - 1];
    if (step === undefined) {
      return { content: [text("(script exhausted)")], stopReason: "end_turn", usage: usage(), refusalReason: null };
    }
    return typeof step === "function" ? step(request) : step;
  }
}

interface RecordingToolkit extends AgentToolkit {
  readonly calls: Array<{ name: string; input: unknown }>;
}

function fakeToolkit(handler?: (name: string, input: unknown) => ToolResult): RecordingToolkit {
  const calls: Array<{ name: string; input: unknown }> = [];
  const definitions: ToolDefinition[] = [
    { name: "bash", description: "跑命令", input_schema: { type: "object" } },
    { name: "read", description: "读文件", input_schema: { type: "object" } },
  ];
  return {
    definitions,
    calls,
    async run(name, input) {
      calls.push({ name, input });
      if (handler !== undefined) return handler(name, input);
      return { content: `ok:${name}`, isError: false };
    },
  };
}

/** 从 transcript 文件里读回记录。 */
async function readRecords(transcript: Transcript): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(transcript.path, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function userBlocksOf(message: Message | undefined): Array<Record<string, unknown>> {
  assert.ok(message !== undefined);
  assert.equal(typeof message.content === "string", false);
  return message.content as unknown as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------- 用例

describe("Phase 11 · 循环的基本形状", () => {
  test("用例 1：固定 tool_use 序列 → 工具被调用、结果回填、正常终止", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit((name) => ({ content: name === "read" ? "const a = 1;" : "done", isError: false }));
    const model = new ScriptedModel([
      { content: [toolUse("tu_1", "read", { path: "src/a.ts" })], stopReason: "tool_use", usage: usage(), refusalReason: null },
      { content: [toolUse("tu_2", "bash", { cmd: ["npm", "test"] })], stopReason: "tool_use", usage: usage(), refusalReason: null },
      { content: [text("改完了，测试通过")], stopReason: "end_turn", usage: usage(), refusalReason: null },
    ]);

    const result = await runAgentLoop({
      model,
      tools: toolkit,
      transcript,
      issue: "修一个 bug",
      log: noopLog,
    });

    assert.equal(result.ok, true);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.turns, 3);
    assert.equal(result.toolCalls, 2);
    assert.equal(result.finalText, "改完了，测试通过");
    assert.deepEqual(toolkit.calls.map((call) => call.name), ["read", "bash"]);
    assert.deepEqual(toolkit.calls[0]!.input, { path: "src/a.ts" });
    // 结果按 tool_use_id 回填
    const secondUser = userBlocksOf(result.messages[2]);
    assert.equal(secondUser[0]!["type"], "tool_result");
    assert.equal(secondUser[0]!["tool_use_id"], "tu_1");
    assert.equal(secondUser[0]!["content"], "const a = 1;");
    // 累计用量
    assert.equal(result.usage.outputTokens, 30);
    assert.equal(result.usage.cacheReadInputTokens, 270);
    // 每轮请求都带着同一份 system 与工具定义（缓存前缀稳定）
    assert.equal(model.requests.length, 3);
    assert.equal(new Set(model.requests.map((request) => request.system)).size, 1);
    assert.equal(model.requests[0]!.tools, toolkit.definitions);
  });

  test("用例 2：一条响应里两个 tool_use → 两个 tool_result 在**同一条** user 消息里", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit();
    const model = new ScriptedModel([
      {
        content: [toolUse("tu_a", "read", { path: "a" }), toolUse("tu_b", "bash", { cmd: ["true"] })],
        stopReason: "tool_use",
        usage: usage(),
        refusalReason: null,
      },
      { content: [text("好")], stopReason: "end_turn", usage: usage(), refusalReason: null },
    ]);

    const result = await runAgentLoop({ model, tools: toolkit, transcript, issue: "并行调用" });
    const userMessages = result.messages.filter((message) => message.role === "user");
    // 只有两条 user 消息：最初的 issue，和这一轮的结果。
    assert.equal(userMessages.length, 2);
    const blocks = userBlocksOf(userMessages[1]);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((block) => block["tool_use_id"]), ["tu_a", "tu_b"]);
    assert.deepEqual(blocks.map((block) => block["content"]), ["ok:read", "ok:bash"]);
  });

  test("用例 4 + 工具失败：失败的结果带 is_error，循环继续", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit((name) =>
      name === "read" ? { content: "路径越界", isError: true } : { content: "ok", isError: false },
    );
    const model = new ScriptedModel([
      { content: [toolUse("tu_1", "read", { path: "/etc/passwd" })], stopReason: "tool_use", usage: usage(), refusalReason: null },
      { content: [toolUse("tu_2", "bash", { cmd: ["true"] })], stopReason: "tool_use", usage: usage(), refusalReason: null },
      { content: [text("还活着")], stopReason: "end_turn", usage: usage(), refusalReason: null },
    ]);
    const result = await runAgentLoop({ model, tools: toolkit, transcript, issue: "越界" });
    assert.equal(result.stopReason, "end_turn");
    const blocks = userBlocksOf(result.messages[2]);
    assert.equal(blocks[0]!["is_error"], true);
    assert.equal(blocks[0]!["content"], "路径越界");
  });

  test("refusal 是正常终态，不当作异常", async () => {
    const transcript = await newTranscript();
    const model = new ScriptedModel([
      { content: [text("我不能做这个")], stopReason: "refusal", usage: usage(), refusalReason: "我不能做这个" },
    ]);
    const result = await runAgentLoop({ model, tools: fakeToolkit(), transcript, issue: "恶意请求" });
    assert.equal(result.stopReason, "refusal");
    assert.equal(result.ok, false);
    assert.match(result.detail, /拒绝了这次请求/);
    assert.equal(result.turns, 1);
  });
});

describe("Phase 11 · 硬上限", () => {
  test("用例 6：永远调用工具 → 撞轮数上限并如实说明", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit();
    const model = new ScriptedModel([]); // 永远走脚本耗尽那一支
    // 用一个自定义模型：每轮都返回 tool_use
    model.create = async (request: ModelRequest): Promise<ModelResponse> => {
      model.requests.push(request);
      const turn = model.requests.length;
      return {
        content: [toolUse(`tu_${turn}`, "bash", { cmd: ["echo", String(turn)] })],
        stopReason: "tool_use",
        usage: usage(),
        refusalReason: null,
      };
    };

    const result = await runAgentLoop({ model, tools: toolkit, transcript, issue: "停不下来", maxTurns: 5 });
    assert.equal(result.stopReason, "max_turns");
    assert.equal(result.turns, 5);
    assert.equal(result.toolCalls, 5);
    assert.match(result.detail, /达到轮数上限（5 轮）/);
    assert.equal(DEFAULT_MAX_TURNS, 40);
  });

  test("墙钟上限：到点之后不再发起新的模型调用", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit();
    let clock = 1_000;
    const model = new ScriptedModel([
      (): ModelResponse => {
        clock += 5_000; // 第一轮花掉 5 秒
        return {
          content: [toolUse("tu_1", "bash", { cmd: ["true"] })],
          stopReason: "tool_use",
          usage: usage(),
          refusalReason: null,
        };
      },
    ]);
    const result = await runAgentLoop({
      model,
      tools: toolkit,
      transcript,
      issue: "慢慢跑",
      wallClockMs: 4_000,
      now: () => clock,
    });
    assert.equal(result.stopReason, "wall_clock");
    assert.equal(result.turns, 1);
    assert.equal(model.requests.length, 1);
  });

  test("输出 token 预算：累计到上限就停", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit();
    const model = new ScriptedModel([
      {
        content: [toolUse("tu_1", "bash", { cmd: ["a"] })],
        stopReason: "tool_use",
        usage: usage(6),
        refusalReason: null,
      },
      {
        content: [toolUse("tu_2", "bash", { cmd: ["b"] })],
        stopReason: "tool_use",
        usage: usage(6),
        refusalReason: null,
      },
    ]);
    const result = await runAgentLoop({ model, tools: toolkit, transcript, issue: "烧 token", outputTokenBudget: 10 });
    assert.equal(result.stopReason, "output_token_budget");
    // 上限是在**下一轮开始之前**检查的：第 1 轮跑完 6 个，第 2 轮把总量推到 12，
    // 然后在第 3 轮之前停下（不会有半截的 tool_use 留着不管）。
    assert.equal(result.turns, 2);
    assert.equal(result.usage.outputTokens, 12);
    assert.equal(model.requests.length, 2);
  });

  test("模型报错 → model_error（不抛出，部分进展保留）", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit();
    const model = new ScriptedModel([]);
    model.create = async (): Promise<ModelResponse> => {
      throw new ModelError("rate_limited", "429 too many requests", { status: 429 });
    };
    const result = await runAgentLoop({ model, tools: toolkit, transcript, issue: "限流" });
    assert.equal(result.stopReason, "model_error");
    assert.match(result.detail, /429/);
    assert.equal(result.turns, 1);
  });

  test("abort → aborted", async () => {
    const transcript = await newTranscript();
    const controller = new AbortController();
    controller.abort();
    const model = new ScriptedModel([]);
    const result = await runAgentLoop({
      model,
      tools: fakeToolkit(),
      transcript,
      issue: "取消",
      signal: controller.signal,
    });
    assert.equal(result.stopReason, "aborted");
    assert.equal(model.requests.length, 0);
  });

  test("max_tokens 截断且没有 tool_use → incomplete_response（不空转）", async () => {
    const transcript = await newTranscript();
    const model = new ScriptedModel([
      { content: [text("被截断的半句")], stopReason: "max_tokens", usage: usage(), refusalReason: null },
    ]);
    const result = await runAgentLoop({ model, tools: fakeToolkit(), transcript, issue: "截断" });
    assert.equal(result.stopReason, "incomplete_response");
    assert.equal(result.turns, 1);
  });
});

describe("Phase 11 · 重复调用检测", () => {
  test("用例 7：连续 3 次相同调用 → 插提示；第 4 次 → 停止", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit(() => ({ content: "同样的输出", isError: false }));
    const model = new ScriptedModel([]);
    model.create = async (request: ModelRequest): Promise<ModelResponse> => {
      model.requests.push(request);
      const turn = model.requests.length;
      return {
        content: [toolUse(`tu_${turn}`, "read", { path: "same.ts" })],
        stopReason: "tool_use",
        usage: usage(),
        refusalReason: null,
      };
    };

    const result = await runAgentLoop({ model, tools: toolkit, transcript, issue: "卡住", maxTurns: 20 });
    assert.equal(result.stopReason, "repeated_tool_calls");
    assert.equal(result.turns, 4);
    // 第 3 轮的那条 user 消息里有提示块（和第 3 轮的工具结果在**同一条**消息里）。
    const userTurns = result.messages.filter((message) => message.role === "user").slice(1);
    const thirdTurnResults = userBlocksOf(userTurns[2]);
    assert.equal(thirdTurnResults.some((block) => block["content"] === REPEAT_NOTICE), true);
    assert.equal(thirdTurnResults.length, 2);
    // 前两轮没有提示
    assert.equal(userBlocksOf(userTurns[0]).length, 1);
    // 第 4 轮之后没有再请求模型（第 4 轮是停下来之前跑完的最后一轮）。
    assert.equal(model.requests.length, 4);
    // transcript 里记了这件事
    const records = await readRecords(transcript);
    assert.equal(records.some((record) => record["kind"] === "repeat_notice"), true);
    assert.equal(records.some((record) => record["kind"] === "repeat_stop"), true);
  });

  test("中间换了别的调用，连续计数就清零（不误杀）", async () => {
    const counts = new Map<string, number>();
    assert.equal(trackRepeats(counts, [{ name: "read", input: { path: "a" } }]).count, 1);
    assert.equal(trackRepeats(counts, [{ name: "read", input: { path: "a" } }]).count, 2);
    assert.equal(trackRepeats(counts, [{ name: "bash", input: { cmd: ["ls"] } }]).count, 1);
    // read(a) 这一轮没出现 → 清零，下一次重新从 1 开始
    assert.equal(trackRepeats(counts, [{ name: "read", input: { path: "a" } }]).count, 1);
  });

  test("stableJson：键顺序不同也算同一个参数", () => {
    assert.equal(stableJson({ a: 1, b: [1, 2] }), stableJson({ b: [1, 2], a: 1 }));
    assert.notEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
  });
});

describe("Phase 11 · transcript（用例 9）", () => {
  test("JSONL 里有 system、tools、每轮 usage 与完整对话", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit();
    const model = new ScriptedModel([
      { content: [toolUse("tu_1", "read", { path: "a" })], stopReason: "tool_use", usage: usage(11), refusalReason: null },
      { content: [text("完成")], stopReason: "end_turn", usage: usage(22), refusalReason: null },
    ]);
    const result = await runAgentLoop({ model, tools: toolkit, transcript, issue: "写文档", repoDir: "/workspace/repo" });
    assert.equal(result.transcriptFailure, null);

    const records = await readRecords(transcript);
    const start = records.find((record) => record["type"] === "run_start")!;
    assert.equal(start["model"], "scripted-test");
    assert.equal(start["issue"], "写文档");
    assert.equal(typeof start["system"], "string");
    assert.deepEqual(start["tools"], ["bash", "read"]);

    const requests = records.filter((record) => record["type"] === "request");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]!["tools"], toolkit.definitions);
    // 第一轮的请求里只有 issue；第二轮里多了 assistant 的 tool_use 与回填的结果。
    const firstMessages = requests[0]!["messages"] as Message[];
    assert.equal(firstMessages.length, 1);
    const secondMessages = requests[1]!["messages"] as Message[];
    assert.deepEqual(
      secondMessages.map((message) => message.role),
      ["user", "assistant", "user"],
    );

    const responses = records.filter((record) => record["type"] === "response");
    assert.equal(responses.length, 2);
    assert.equal((responses[0]!["usage"] as { outputTokens: number }).outputTokens, 11);
    assert.equal(responses[1]!["stopReason"], "end_turn");
    assert.equal(typeof responses[0]!["durationMs"], "number");

    const end = records.at(-1)!;
    assert.equal(end["type"], "run_end");
    assert.equal(end["stopReason"], "end_turn");
    assert.equal(end["toolCalls"], 1);

    // 每一条都是合法 JSON 行（JSONL 的硬要求）
    for (const record of records) assert.equal(typeof record["ts"], "string");
  });

  test("transcript 能上传对象存储（流式，key 是 runs/<runId>/transcript.jsonl）", async () => {
    const transcript = await newTranscript();
    await transcript.append("run_start", { hello: "world" });
    const uploads: Array<{ key: string; bytes: number }> = [];
    const store: ArtifactStore = {
      async put(objectKey: string, body: Readable): Promise<StoredObject> {
        let bytes = 0;
        for await (const chunk of body) bytes += (chunk as Buffer).length;
        uploads.push({ key: objectKey, bytes });
        return { objectKey, sizeBytes: bytes, sha256: "0".repeat(64) };
      },
      get: async () => Readable.from([]),
      head: async () => null,
      close: () => undefined,
    };
    const stored = await transcript.upload(store);
    assert.equal(stored.objectKey, `runs/${transcript.runId}/transcript.jsonl`);
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0]!.bytes > 0);
  });
});

describe("Phase 11 · 上下文裁剪", () => {
  test("只丢最旧的 tool_result 内容，不丢 user / assistant 的文字", () => {
    const messages: Message[] = [
      { role: "user", content: "原始 issue" },
      { role: "assistant", content: [text("我来看看")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "x".repeat(500) }] },
      { role: "assistant", content: [text("继续")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "y".repeat(500) }] },
    ];
    const removed = trimOldToolResults(messages, { maxChars: 600, keepRecent: 1 });
    assert.equal(removed, 1);
    assert.equal(userBlocksOf(messages[2])[0]!["content"], ELIDED_TOOL_RESULT);
    // 最近那条不动
    assert.equal(userBlocksOf(messages[4])[0]!["content"], "y".repeat(500));
    // 文字原样
    assert.equal(messages[0]!.content, "原始 issue");
    assert.deepEqual(messages[1]!.content, [text("我来看看")]);
  });

  test("没超预算时什么都不动", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "small" }] },
    ];
    assert.equal(trimOldToolResults(messages, { maxChars: 1000, keepRecent: 0 }), 0);
  });

  test("循环中途会自动裁剪", async () => {
    const transcript = await newTranscript();
    const toolkit = fakeToolkit(() => ({ content: "z".repeat(4000), isError: false }));
    const model = new ScriptedModel([]);
    model.create = async (request: ModelRequest): Promise<ModelResponse> => {
      model.requests.push(request);
      const turn = model.requests.length;
      return turn <= 4
        ? {
            content: [toolUse(`tu_${turn}`, "bash", { cmd: ["echo", String(turn)] })],
            stopReason: "tool_use",
            usage: usage(),
            refusalReason: null,
          }
        : { content: [text("好了")], stopReason: "end_turn", usage: usage(), refusalReason: null };
    };
    const result = await runAgentLoop({
      model,
      tools: toolkit,
      transcript,
      issue: "大结果",
      context: { maxChars: 3_000, keepRecentToolResults: 1 },
    });
    assert.equal(result.stopReason, "end_turn");
    const records = await readRecords(transcript);
    assert.equal(records.some((record) => record["type"] === "context_trim"), true);
    // 最旧的那条工具结果已经被换成占位符
    const elided = result.messages.some(
      (message) =>
        typeof message.content !== "string" &&
        message.content.some((block) => block.type === "tool_result" && block.content === ELIDED_TOOL_RESULT),
    );
    assert.equal(elided, true);
  });
});
