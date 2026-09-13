/**
 * Phase 13 · 事件词汇与埋点（不需要网络、模型、Docker）。
 *
 * 两件事在这里被验到：
 *  ① 沙箱事件 → RunEvent 的映射（`createExecEventMapper`）：字段名从 snake_case 翻过来、
 *     `executionId` 靠 `started` 事件补上、认不出的事件变成 note 而不是异常。
 *  ② 循环与工具真的在发事件：脚本化模型跑一次 → 事件序列与顺序（`tool_call` 必须在
 *     `tool_result` 之前、`text` 必须在它后面的 `tool_call` 之前）；真 `bash` 工具配一个
 *     假 exec 出口 → `exec_start` / `exec_output` / `exec_end` 真的发得出来。
 *
 * 这两条合起来才是"打开页面能看到一次 Run 的实时流"在**没有浏览器**时的可断言形式。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import type { RunEvent, RunEventSink } from "../../src/agent/events.ts";
import { createExecEventMapper, mapExecEvent } from "../../src/agent/events.ts";
import { runAgentLoop } from "../../src/agent/loop.ts";
import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from "../../src/agent/model.ts";
import { ModelError } from "../../src/agent/model.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import { createToolkit } from "../../src/agent/tools/index.ts";
import type { ExecPort, SandboxFilesPort, ToolExecResult } from "../../src/agent/tools/types.ts";
import type { SseEvent } from "../../src/client/sse.ts";
import { noopLog } from "../../src/log.ts";

// ---------------------------------------------------------------- 脚手架

let workDir = "";
let seq = 0;

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "rc-events-"));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 一个把事件收进数组的 sink（RunHub 的最小替身）。 */
function collectingSink(): RunEventSink & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

function sse(event: string, data: unknown): SseEvent {
  return { id: "1", event, data: JSON.stringify(data) };
}

function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

function toolUse(id: string, name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id, name, input };
}

function usage(): ModelResponse["usage"] {
  return { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

/** 按脚本回答的模型；脚本用完之后一直 end_turn（免得忘了写终止条件）。 */
class ScriptedModel implements ModelClient {
  readonly model = "scripted-test";
  readonly #script: Array<ModelResponse | ((request: ModelRequest) => ModelResponse)>;
  #calls = 0;

  constructor(script: Array<ModelResponse | ((request: ModelRequest) => ModelResponse)>) {
    this.#script = script;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    this.#calls += 1;
    const step = this.#script[this.#calls - 1];
    if (step === undefined) {
      return { content: [text("（脚本用完了）")], stopReason: "end_turn", usage: usage(), refusalReason: null };
    }
    return typeof step === "function" ? step(request) : step;
  }
}

async function newTranscript(): Promise<Transcript> {
  seq += 1;
  return Transcript.create({ runId: `run_evt_${seq}`, path: path.join(workDir, `t-${seq}.jsonl`) });
}

function typesOf(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}

// ---------------------------------------------------------------- 映射

describe("Phase 13 · 沙箱事件 → RunEvent", () => {
  test("started 带来 executionId 与命令，后面的输出事件借用它", () => {
    const map = createExecEventMapper();
    const started = map(sse("started", { execution_id: "exe_1", pid: 42, cwd: "/workspace/repo", cmd: ["npm", "test"] }));
    assert.deepEqual(started, [
      { type: "exec_start", executionId: "exe_1", cmd: ["npm", "test"], cwd: "/workspace/repo" },
    ]);
    const out = map(sse("stdout", { chunk: "hello\n" }));
    assert.deepEqual(out, [{ type: "exec_output", executionId: "exe_1", stream: "stdout", text: "hello\n" }]);
    const err = map(sse("stderr", { chunk: "boom\n" }));
    assert.deepEqual(err, [{ type: "exec_output", executionId: "exe_1", stream: "stderr", text: "boom\n" }]);
  });

  test("四种终态都翻成 exec_end，字段一个不少", () => {
    for (const state of ["completed", "failed", "timeout", "killed"]) {
      const events = mapExecEvent(
        sse(state, {
          exit_code: state === "completed" ? 0 : null,
          duration_ms: 1234,
          stdout_bytes: 10,
          stderr_bytes: 20,
          truncated: state === "timeout",
          log_path: "/tmp/reuben-cloud/exec/exe_1.log",
        }),
        { executionId: "exe_1" },
      );
      assert.deepEqual(events, [
        {
          type: "exec_end",
          executionId: "exe_1",
          state,
          exitCode: state === "completed" ? 0 : null,
          durationMs: 1234,
          stdoutBytes: 10,
          stderrBytes: 20,
          truncated: state === "timeout",
          logPath: "/tmp/reuben-cloud/exec/exe_1.log",
        },
      ]);
    }
  });

  test("truncated 变成一条 note，并把完整日志的位置写进去", () => {
    const events = mapExecEvent(
      sse("truncated", { reason: "output_limit", limit: 1024, log_path: "/tmp/reuben-cloud/exec/exe_1.log" }),
      { executionId: "exe_1" },
    );
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "note");
    assert.equal(event.type === "note" ? event.kind : null, "exec_truncated");
    assert.match(event.type === "note" ? event.message : "", /\/tmp\/reuben-cloud\/exec\/exe_1\.log/);
  });

  test("两个映射器互不干扰（每个 exec 一个）", () => {
    const first = createExecEventMapper();
    const second = createExecEventMapper();
    first(sse("started", { execution_id: "exe_a", cmd: ["a"], cwd: "/workspace" }));
    second(sse("started", { execution_id: "exe_b", cmd: ["b"], cwd: "/workspace" }));
    assert.deepEqual(first(sse("stdout", { chunk: "x" }))[0], {
      type: "exec_output",
      executionId: "exe_a",
      stream: "stdout",
      text: "x",
    });
    assert.deepEqual(second(sse("stdout", { chunk: "y" }))[0], {
      type: "exec_output",
      executionId: "exe_b",
      stream: "stdout",
      text: "y",
    });
  });

  test("坏 JSON 与认不出的事件名：给一条 note，不抛异常", () => {
    const broken = mapExecEvent({ id: "1", event: "stdout", data: "{半截" }, { executionId: null });
    assert.equal(broken[0]?.type === "note" ? broken[0].kind : null, "exec_unparsed");
    const unknown = mapExecEvent(sse("restarted", {}), { executionId: null });
    assert.equal(unknown[0]?.type === "note" ? unknown[0].kind : null, "exec_unknown");
  });
});

// ---------------------------------------------------------------- 循环埋点

describe("Phase 13 · 循环发出来的事件", () => {
  test("一次带工具调用的 Run：run_start → turn → tool_call → tool_result → turn → run_end", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    const model = new ScriptedModel([
      { content: [text("先跑一下命令"), toolUse("tu_1", "bash", { cmd: ["echo", "hi"] })], stopReason: "tool_use", usage: usage(), refusalReason: null },
      { content: [text("好了")], stopReason: "end_turn", usage: usage(), refusalReason: null },
    ]);
    const toolkit = {
      definitions: [],
      async run(name: string) {
        return { content: `ok:${name}`, isError: false };
      },
    };

    const result = await runAgentLoop({
      model,
      tools: toolkit,
      transcript,
      issue: "跑一条命令",
      events: sink,
      // 调用方把 onText 接到 sink 上（`scripts/agent-run.ts` 就是这么接的）：
      // 循环本身不碰文字通道，免得同一个增量被发两遍。
      onText: (delta) => sink.emit({ type: "text", delta }),
      // 脚本化模型不调 onText，这里手动模拟两段增量。
      ...{},
    });

    assert.deepEqual(typesOf(sink.events), ["run_start", "turn", "tool_call", "tool_result", "turn", "run_end"]);
    const runStart = sink.events[0]!;
    assert.equal(runStart.type === "run_start" ? runStart.model : null, "scripted-test");
    assert.equal(runStart.type === "run_start" ? runStart.issue : null, "跑一条命令");
    const toolCall = sink.events[2]!;
    assert.deepEqual(
      { turn: toolCall.type === "tool_call" ? toolCall.turn : null, name: toolCall.type === "tool_call" ? toolCall.name : null },
      { turn: 1, name: "bash" },
    );
    const toolResult = sink.events[3]!;
    assert.equal(toolResult.type === "tool_result" ? toolResult.content : null, "ok:bash");
    assert.equal(toolResult.type === "tool_result" ? toolResult.isError : null, false);
    const runEnd = sink.events[5]!;
    assert.equal(runEnd.type === "run_end" ? runEnd.ok : null, true);
    assert.equal(runEnd.type === "run_end" ? runEnd.turns : null, 2);
    assert.equal(runEnd.type === "run_end" ? runEnd.toolCalls : null, 1);
    assert.equal(result.ok, true);
  });

  test("文字增量与工具调用之间的顺序由调用方决定，且事件里不带 turn（归组靠 turn 事件）", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    const model = new ScriptedModel([
      {
        content: [text("我先说一句")],
        stopReason: "tool_use",
        usage: usage(),
        refusalReason: null,
      },
    ]);
    // 上面这一轮 stopReason=tool_use 但没有 tool_use 块 → incomplete_response 终态。
    await runAgentLoop({
      model,
      tools: { definitions: [], async run() { return { content: "ok", isError: false }; } },
      transcript,
      issue: "x",
      events: sink,
      onText: (delta) => sink.emit({ type: "text", delta }),
    });
    assert.deepEqual(typesOf(sink.events), ["run_start", "turn", "note", "run_end"]);
    const end = sink.events.at(-1)!;
    assert.equal(end.type === "run_end" ? end.stopReason : null, "incomplete_response");
  });

  test("模型吐文字时，调用方的 onText 是真的接到事件流上的（Phase 13 复用 Phase 11 的那条回调）", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    // 模型**主动调** onText（真模型是 SDK 的流回调让它响的，这里手动模拟）。
    const model: ModelClient = {
      model: "chatty",
      async create(request: ModelRequest) {
        request.onText?.("你好");
        request.onText?.("，世界");
        return { content: [text("你好，世界")], stopReason: "end_turn", usage: usage(), refusalReason: null };
      },
    };
    await runAgentLoop({
      model,
      tools: { definitions: [], async run() { return { content: "ok", isError: false }; } },
      transcript,
      issue: "x",
      events: sink,
      onText: (delta) => sink.emit({ type: "text", delta }),
    });
    assert.deepEqual(typesOf(sink.events), ["run_start", "turn", "text", "text", "run_end"]);
    assert.deepEqual(
      sink.events.filter((event) => event.type === "text").map((event) => (event.type === "text" ? event.delta : null)),
      ["你好", "，世界"],
    );
  });

  test("模型报错：一条 note（kind=model_error）+ run_end（stopReason=model_error）", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    const failing: ModelClient = {
      model: "broken",
      async create() {
        throw new ModelError("unreachable", "连不上模型服务");
      },
    };
    await runAgentLoop({
      model: failing,
      tools: { definitions: [], async run() { return { content: "ok", isError: false }; } },
      transcript,
      issue: "x",
      events: sink,
    });
    const note = sink.events.find((event) => event.type === "note");
    assert.equal(note?.type === "note" ? note.kind : null, "model_error");
    const end = sink.events.at(-1)!;
    assert.equal(end.type === "run_end" ? end.stopReason : null, "model_error");
  });

  test("重复调用：第三次插提示（note），第四次停（note + run_end）", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    // 永远返回同一个工具调用 → 撞上 REPEAT_NOTICE_THRESHOLD / STOP_THRESHOLD。
    const model: ModelClient = {
      model: "loopy",
      async create() {
        return {
          content: [toolUse("tu_same", "bash", { cmd: ["ls"] })],
          stopReason: "tool_use",
          usage: usage(),
          refusalReason: null,
        };
      },
    };
    const result = await runAgentLoop({
      model,
      tools: { definitions: [], async run() { return { content: "ok", isError: false }; } },
      transcript,
      issue: "x",
      events: sink,
      maxTurns: 10,
    });
    const kinds = sink.events.filter((event) => event.type === "note").map((event) => (event.type === "note" ? event.kind : ""));
    assert.deepEqual(kinds, ["repeat_notice", "repeat_stop"]);
    assert.equal(result.stopReason, "repeated_tool_calls");
    assert.equal(result.turns, 4);
  });

  test("观察者抛异常不会弄死 Run（旁路就是旁路）", async () => {
    const transcript = await newTranscript();
    const result = await runAgentLoop({
      model: new ScriptedModel([{ content: [text("完事")], stopReason: "end_turn", usage: usage(), refusalReason: null }]),
      tools: { definitions: [], async run() { return { content: "ok", isError: false }; } },
      transcript,
      issue: "x",
      events: {
        emit() {
          throw new Error("观察者自己崩了");
        },
      },
    });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------- 工具埋点

describe("Phase 13 · bash 把沙箱事件转发出去", () => {
  test("exec_start / exec_output / exec_end 真的发得出来（真 bash 工具 + 假出口）", async () => {
    const sink = collectingSink();
    const exec: ExecPort = {
      async execInSandbox(_sandboxId, request) {
        request.onEvent?.(sse("started", { execution_id: "exe_9", pid: 7, cwd: "/workspace/repo", cmd: ["echo", "hi"] }));
        request.onEvent?.(sse("stdout", { chunk: "hi\n" }));
        request.onEvent?.(sse("stderr", { chunk: "warn\n" }));
        request.onEvent?.(
          sse("completed", {
            exit_code: 0,
            duration_ms: 8,
            stdout_bytes: 3,
            stderr_bytes: 5,
            truncated: false,
            log_path: null,
          }),
        );
        return {
          executionId: "exe_9",
          state: "completed",
          exitCode: 0,
          signal: null,
          durationMs: 8,
          stdoutBytes: 3,
          stderrBytes: 5,
          truncated: false,
          logPath: null,
          events: [sse("stdout", { chunk: "hi\n" }), sse("stderr", { chunk: "warn\n" })],
        } satisfies ToolExecResult;
      },
    };
    const unused = (): never => {
      throw new Error("这个用例不该走文件 API");
    };
    const api = {
      readFile: unused,
      listFiles: unused,
      putFile: unused,
      readRaw: () => Promise.resolve(Readable.from([])),
    } as unknown as SandboxFilesPort;

    const toolkit = createToolkit({
      sandboxId: "sbx_test",
      exec,
      api,
      target: { endpoint: "http://x", authToken: "t", sandboxId: "sbx_test" },
      events: sink,
      log: noopLog,
    });
    const result = await toolkit.run("bash", { cmd: ["echo", "hi"] });
    assert.equal(result.isError, false);

    assert.deepEqual(typesOf(sink.events), ["exec_start", "exec_output", "exec_output", "exec_end"]);
    const start = sink.events[0]!;
    assert.equal(start.type === "exec_start" ? start.executionId : null, "exe_9");
    assert.deepEqual(sink.events[1], { type: "exec_output", executionId: "exe_9", stream: "stdout", text: "hi\n" });
    assert.deepEqual(sink.events[2], { type: "exec_output", executionId: "exe_9", stream: "stderr", text: "warn\n" });
    const end = sink.events[3]!;
    assert.equal(end.type === "exec_end" ? end.exitCode : null, 0);
    assert.equal(end.type === "exec_end" ? end.state : null, "completed");
  });

  test("没有 sink 时工具照常工作（观察窗不是必需品）", async () => {
    const exec: ExecPort = {
      async execInSandbox(_sandboxId, request) {
        request.onEvent?.(sse("started", { execution_id: "exe_1", cmd: ["echo"], cwd: "/workspace" }));
        return {
          executionId: "exe_1",
          state: "completed",
          exitCode: 0,
          signal: null,
          durationMs: 1,
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
          logPath: null,
          events: [],
        } satisfies ToolExecResult;
      },
    };
    const toolkit = createToolkit({
      sandboxId: "sbx_test",
      exec,
      api: {} as unknown as SandboxFilesPort,
      target: { endpoint: "http://x", authToken: "t", sandboxId: "sbx_test" },
      log: noopLog,
    });
    const result = await toolkit.run("bash", { cmd: ["echo"] });
    assert.equal(result.isError, false);
  });
});
