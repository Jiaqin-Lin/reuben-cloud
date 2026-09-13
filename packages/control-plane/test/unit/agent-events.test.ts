/**
 * Phase 13 · 事件词汇与埋点（P4 迁到**唯一事件协议**上；不需要网络、模型、Docker）。
 *
 * 三件事在这里被验到：
 *  ① **AgentEvent → SSE 通道的映射**（`sseFrameOf`）：编译期清单
 *     （`Record<AgentEvent["type"], true>`，漏一个类型就编译不过）驱动的运行期逐条断言。
 *  ② 沙箱事件 → 观察窗事件（`createExecEventMapper`）：字段名从 snake_case 翻过来、
 *     `executionId` 靠 `started` 事件补上、认不出的/坏掉的变成 **`AgentEvent` note** 而不是异常。
 *  ③ 兼容层真的在把循环事件发出去：脚本化模型跑一次 → 事件序列与顺序
 *     （`tool_execution_start` 必须在 `tool_execution_end` 之前；文字走 `message_update`）。
 *
 * 【P4 的变化】M0 这里断言的是\"每个事件都翻成 `RunEvent`\"；现在观察窗收的就是循环的
 * 原生事件——**翻译层本身被删掉了**，所以断言换成\"事件按原样、按顺序到达\"加上
 * \"通道名由映射表决定\"。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import type {
  AgentEvent,
  AgentTool,
  AssistantMessageEventStream,
  Content,
  ModelClient,
  ModelRequest,
} from "@reuben-cloud/agent-runtime";
import { createAssistantMessageEventStream, emptyUsage } from "@reuben-cloud/agent-runtime";
import type { ExecEvent, HubEvent, HubEventSink, RunEvent, SseEventName } from "../../src/agent/events.ts";
import { createExecEventMapper, mapExecEvent, sseFrameOf } from "../../src/agent/events.ts";
import { runAgentLoop } from "../../src/agent/run.ts";
import type { ExecPort, SandboxFilesPort, ToolExecResult } from "../../src/agent/sandbox-operations.ts";
import { createSandboxToolkit } from "../../src/agent/sandbox-operations.ts";
import { Transcript } from "../../src/agent/transcript.ts";
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
function collectingSink(): HubEventSink & { events: HubEvent[] } {
  const events: HubEvent[] = [];
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

function typesOf(events: readonly HubEvent[]): string[] {
  return events.map((event) => event.type);
}

/** 事件的紧凑标记（断言顺序用；`message_update` 的三种增量都记成同一个标记）。 */
function markerOf(event: HubEvent): string {
  switch (event.type) {
    case "message_start":
    case "message_end":
      return `${event.type}:${event.message.role}`;
    case "message_update":
      return "message_update";
    case "tool_execution_start":
      return `tool_start:${event.toolName}`;
    case "tool_execution_end":
      return `tool_end:${event.toolName}:${event.isError}`;
    default:
      return event.type;
  }
}

function textBlock(value: string): Content {
  return { type: "text", text: value };
}

/** 一步脚本：文本（含增量）。 */
function say(value: string, stopReason: "stop" | "toolUse" = "stop") {
  return (stream: AssistantMessageEventStream): void => {
    const message = { role: "assistant" as const, content: [textBlock("")], usage: emptyUsage() };
    stream.push({ type: "start", partial: { ...message } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...message } });
    for (const chunk of [value.slice(0, 2), value.slice(2)]) {
      message.content = [textBlock((message.content[0] as { text: string }).text + chunk)];
      stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: { ...message } });
    }
    message.content = [textBlock(value)];
    stream.push({ type: "text_end", contentIndex: 0, content: value, partial: { ...message } });
    const final = { ...message, stopReason };
    stream.push({ type: "done", reason: stopReason, message: final });
  };
}

/** 一步脚本：一个工具调用。 */
function callTool(id: string, name: string, args: Record<string, unknown>) {
  return (stream: AssistantMessageEventStream): void => {
    const call = { type: "toolCall" as const, id, name, arguments: args };
    const message = { role: "assistant" as const, content: [call], usage: emptyUsage() };
    stream.push({ type: "start", partial: { ...message } });
    stream.push({ type: "toolcall_start", contentIndex: 0, id, name, partial: { ...message } });
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: { ...message } });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: { ...message } });
    const final = { ...message, stopReason: "toolUse" as const };
    stream.push({ type: "done", reason: "toolUse", message: final });
  };
}

/** 按脚本回答的模型。脚本用完之后的请求返回一条 stop。 */
function scriptedModel(steps: Array<(stream: AssistantMessageEventStream) => void>): ModelClient {
  let calls = 0;
  return {
    provider: "scripted",
    model: "scripted-test",
    stream(_request: ModelRequest): AssistantMessageEventStream {
      const stream = createAssistantMessageEventStream();
      const step = steps[calls] ?? say("（脚本用完了）");
      calls += 1;
      void Promise.resolve().then(() => step(stream));
      return stream;
    },
  };
}

const UNUSED = (): never => {
  throw new Error("这个用例不该走这条出口");
};

async function newTranscript(): Promise<Transcript> {
  seq += 1;
  return Transcript.create({ runId: `run_evt_${seq}`, path: path.join(workDir, `t-${seq}.jsonl`) });
}

/** 一个只会返回固定结果的假工具（循环的埋点测试用）。 */
function stubTool(name: string, content = "ok"): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object" },
    async execute() {
      return { content: [textBlock(content)], details: {} };
    },
  };
}

// ---------------------------------------------------------------- AgentEvent → SSE 通道

/** 每个 `AgentEvent` 的一个样本（运行时逐条喂给 `sseFrameOf`）。 */
const AGENT_SAMPLE: Record<AgentEvent["type"], AgentEvent> = {
  agent_start: { type: "agent_start" },
  agent_end: { type: "agent_end", messages: [] },
  turn_start: { type: "turn_start" },
  turn_end: { type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] },
  message_start: { type: "message_start", message: { role: "user", content: "hi" } },
  message_update: {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "好",
      partial: { role: "assistant", content: [] },
    },
  },
  message_end: { type: "message_end", message: { role: "user", content: "hi" } },
  tool_execution_start: { type: "tool_execution_start", toolCallId: "tu_1", toolName: "bash", args: {} },
  tool_execution_update: {
    type: "tool_execution_update",
    toolCallId: "tu_1",
    toolName: "bash",
    args: {},
    partialResult: {},
  },
  tool_execution_end: {
    type: "tool_execution_end",
    toolCallId: "tu_1",
    toolName: "bash",
    result: {},
    isError: false,
  },
  context_compiled: { type: "context_compiled", turn: 1, sections: [], hash: "h" },
  compaction: { type: "compaction", reason: "threshold", tokensBefore: 1, firstKeptEntryId: "ent_1" },
  note: { type: "note", kind: "test", message: "说明" },
};

/**
 * 编译期清单：**漏掉一个 `AgentEvent` 这里就是类型错误**；运行期再把每个样本真的
 * 过一遍映射函数（spec 测试要点 1 的\"编译期 switch + 运行时表\"）。
 */
const AGENT_CHANNEL: Record<AgentEvent["type"], SseEventName> = {
  agent_start: "agent",
  agent_end: "agent",
  turn_start: "turn",
  turn_end: "turn",
  message_start: "message",
  message_update: "message",
  message_end: "message",
  tool_execution_start: "tool",
  tool_execution_update: "tool",
  tool_execution_end: "tool",
  context_compiled: "context",
  compaction: "compaction",
  note: "note",
};

describe("Phase 4 · 事件 → SSE 通道", () => {
  test("每个 AgentEvent 都映射到一个通道（逐个样本真跑一遍）", () => {
    const types = Object.keys(AGENT_CHANNEL) as Array<AgentEvent["type"]>;
    assert.ok(types.length >= 13, "AgentEvent 的类型数量不该少于 13");
    for (const type of types) {
      const event = AGENT_SAMPLE[type];
      assert.equal(event.type, type, `样本 ${type} 自己写错了`);
      assert.equal(sseFrameOf(event).event, AGENT_CHANNEL[type], `${type} 的通道不对`);
    }
  });

  test("三个 Run 生命周期事件都走 `run` 通道", () => {
    const samples: RunEvent[] = [
      {
        type: "run_start",
        runId: "run_1",
        sessionId: null,
        model: "m",
        issue: "i",
        repoDir: "/workspace/repo",
        limits: { maxTurns: 1, wallClockMs: 1, outputTokenBudget: 1, maxTokens: 1 },
      },
      { type: "run_end", ok: true, stopReason: "end_turn", detail: "d", turns: 1, toolCalls: 0, usage: emptyUsage() },
      { type: "run_error", message: "崩了" },
    ];
    for (const event of samples) assert.equal(sseFrameOf(event).event, "run");
  });

  test("三个沙箱输出事件都走 `exec` 通道", () => {
    const samples: ExecEvent[] = [
      { type: "exec_start", executionId: null, cmd: ["ls"], cwd: null },
      { type: "exec_output", executionId: null, stream: "stdout", text: "x" },
      {
        type: "exec_end",
        executionId: null,
        state: "completed",
        exitCode: 0,
        durationMs: 1,
        stdoutBytes: 1,
        stderrBytes: 0,
        truncated: false,
        logPath: null,
      },
    ];
    for (const event of samples) assert.equal(sseFrameOf(event).event, "exec");
  });
});

// ---------------------------------------------------------------- 映射

describe("Phase 13 · 沙箱事件 → 观察窗事件", () => {
  test("started 带来 executionId 与命令，后面的输出事件借用它", () => {
    const map = createExecEventMapper();
    const started = map(
      sse("started", { execution_id: "exe_1", pid: 42, cwd: "/workspace/repo", cmd: ["npm", "test"] }),
    );
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

  test("truncated 变成一条 note（AgentEvent），并把完整日志的位置写进去", () => {
    const events = mapExecEvent(
      sse("truncated", { reason: "output_limit", limit: 1024, log_path: "/tmp/reuben-cloud/exec/exe_1.log" }),
      { executionId: "exe_1" },
    );
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

describe("Phase 13 · 兼容层发出来的事件（P4：原生事件直通）", () => {
  test("一次带工具调用的 Run：事件按循环的顺序原样到达，没有翻译层", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    const model = scriptedModel([callTool("tu_1", "bash", { command: "echo hi" }), say("好了")]);

    const result = await runAgentLoop({
      model,
      tools: [stubTool("bash")],
      transcript,
      issue: "跑一条命令",
      sessionId: "ses_evt",
      events: sink,
      onText: () => undefined,
      log: noopLog,
    });

    assert.deepEqual(sink.events.map(markerOf), [
      "run_start",
      "agent_start",
      "turn_start",
      "message_start:user",
      "message_end:user",
      "message_start:assistant",
      "message_update", // toolcall_start
      "message_update", // toolcall_delta
      "message_update", // toolcall_end
      "message_end:assistant",
      "tool_start:bash",
      "tool_end:bash:false",
      "message_start:toolResult",
      "message_end:toolResult",
      "turn_end",
      "turn_start",
      "message_start:assistant",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_end:assistant",
      "turn_end",
      "agent_end",
      "run_end",
    ]);

    const runStart = sink.events[0]!;
    assert.equal(runStart.type === "run_start" ? runStart.model : null, "scripted-test");
    assert.equal(runStart.type === "run_start" ? runStart.issue : null, "跑一条命令");
    assert.equal(runStart.type === "run_start" ? runStart.sessionId : null, "ses_evt");
    const toolEnd = sink.events.find((event) => event.type === "tool_execution_end")!;
    assert.equal(toolEnd.type === "tool_execution_end" ? toolEnd.isError : null, false);
    const runEnd = sink.events.at(-1)!;
    assert.equal(runEnd.type === "run_end" ? runEnd.ok : null, true);
    assert.equal(runEnd.type === "run_end" ? runEnd.turns : null, 2);
    assert.equal(runEnd.type === "run_end" ? runEnd.toolCalls : null, 1);
    assert.equal(result.ok, true);

    // transcript 的三条记录用的是同一个轮次号（曾经因为 turn_start 已经加过而错位）。
    const records = (await readFile(transcript.path, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const turnsOf = (type: string): unknown[] =>
      records.filter((record) => record["type"] === type).map((record) => record["turn"]);
    assert.deepEqual(turnsOf("request"), [1, 2]);
    assert.deepEqual(turnsOf("response"), [1, 2]);
    assert.deepEqual(turnsOf("tool_call"), [1]);
  });

  test("文字增量既能流到事件里，也能交给 onText（两条路同源不互斥）", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    const seen: string[] = [];
    await runAgentLoop({
      model: scriptedModel([say("你好，世界")]),
      tools: [],
      transcript,
      issue: "x",
      events: sink,
      onText: (delta) => seen.push(delta),
    });
    const deltas = sink.events
      .filter((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      .map((event) => (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : null));
    assert.deepEqual(deltas, ["你好", "，世界"]);
    assert.deepEqual(seen, ["你好", "，世界"]);
    assert.deepEqual(typesOf(sink.events).slice(0, 3), ["run_start", "agent_start", "turn_start"]);
  });

  test("stopReason=length 但没有工具调用 → run_end 如实报 incomplete_response", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    await runAgentLoop({
      model: scriptedModel([
        (stream) => {
          // 一轮"说了话但没有工具调用、也不是正常收尾"。
          const message = {
            role: "assistant" as const,
            content: [textBlock("我说了话")],
            usage: emptyUsage(),
            stopReason: "length" as const,
          };
          stream.push({ type: "start", partial: { ...message } });
          stream.push({ type: "done", reason: "length", message });
        },
      ]),
      tools: [],
      transcript,
      issue: "x",
      events: sink,
    });
    const end = sink.events.at(-1)!;
    assert.equal(end.type === "run_end" ? end.stopReason : null, "incomplete_response");
  });

  test("模型报错：一条 AgentEvent note（kind=model_error）+ run_end（stopReason=model_error）", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    const failing: ModelClient = {
      provider: "scripted",
      model: "broken",
      stream(): AssistantMessageEventStream {
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant" as const,
          content: [],
          usage: emptyUsage(),
          stopReason: "error" as const,
          errorMessage: "连不上模型服务",
        };
        void Promise.resolve().then(() => {
          stream.push({ type: "start", partial: { ...message, stopReason: undefined } });
          stream.push({ type: "error", reason: "error", error: message });
        });
        return stream;
      },
    };
    await runAgentLoop({ model: failing, tools: [], transcript, issue: "x", events: sink });
    const note = sink.events.find((event) => event.type === "note");
    assert.equal(note?.type === "note" ? note.kind : null, "model_error");
    const end = sink.events.at(-1)!;
    assert.equal(end.type === "run_end" ? end.stopReason : null, "model_error");
    // note 排在失败的那条消息之后（页面上"模型失败"不会出现在那句失败的话之前）。
    const noteIndex = sink.events.findIndex((event) => event.type === "note");
    const messageEndIndex = sink.events.findIndex((event) => event.type === "message_end");
    assert.ok(noteIndex > messageEndIndex);
  });

  test("重复调用：第三次插提示（note），第四次停（note + run_end）", async () => {
    const sink = collectingSink();
    const transcript = await newTranscript();
    // 永远返回同一个工具调用 → 撞上 REPEAT_NOTICE_THRESHOLD / STOP_THRESHOLD。
    let calls = 0;
    const loopy: ModelClient = {
      provider: "scripted",
      model: "loopy",
      stream(): AssistantMessageEventStream {
        const stream = createAssistantMessageEventStream();
        const call = { type: "toolCall" as const, id: `tu_${calls}`, name: "bash", arguments: { command: "ls" } };
        calls += 1;
        const message = { role: "assistant" as const, content: [call], usage: emptyUsage(), stopReason: "toolUse" as const };
        void Promise.resolve().then(() => {
          stream.push({ type: "start", partial: { ...message } });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: { ...message } });
          stream.push({ type: "done", reason: "toolUse", message });
        });
        return stream;
      },
    };
    const result = await runAgentLoop({
      model: loopy,
      tools: [stubTool("bash")],
      transcript,
      issue: "x",
      events: sink,
      maxTurns: 10,
    });
    const kinds = sink.events
      .filter((event) => event.type === "note")
      .map((event) => (event.type === "note" ? event.kind : ""));
    assert.deepEqual(kinds, ["repeat_notice", "repeat_stop"]);
    assert.equal(result.stopReason, "repeated_tool_calls");
    assert.equal(result.turns, 4);
  });

  test("观察者抛异常不会弄死 Run（旁路就是旁路）", async () => {
    const transcript = await newTranscript();
    const result = await runAgentLoop({
      model: scriptedModel([say("完事")]),
      tools: [],
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
        request.onEvent?.(sse("started", { execution_id: "exe_9", pid: 7, cwd: "/workspace/repo", cmd: ["bash", "-lc", "echo hi"] }));
        request.onEvent?.(sse("stdout", { chunk: "hi\n" }));
        request.onEvent?.(sse("stderr", { chunk: "warn\n" }));
        request.onEvent?.(
          sse("completed", { exit_code: 0, duration_ms: 8, stdout_bytes: 3, stderr_bytes: 5, truncated: false, log_path: null }),
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
    const api = {
      readFile: UNUSED,
      listFiles: UNUSED,
      putFile: UNUSED,
      readRaw: () => Promise.resolve(Readable.from([])),
      kill: UNUSED,
    } as unknown as SandboxFilesPort;

    const toolkit = createSandboxToolkit({
      sandboxId: "sbx_test",
      exec,
      api,
      target: { endpoint: "http://x", authToken: "t", sandboxId: "sbx_test" },
      repoDir: "/workspace/repo",
      events: sink,
      log: noopLog,
    });
    const bash = toolkit.tools.find((tool) => tool.name === "bash")!;
    const result = await bash.execute("call_1", { command: "echo hi" } as never);

    assert.deepEqual(typesOf(sink.events), ["exec_start", "exec_output", "exec_output", "exec_end"]);
    const start = sink.events[0]!;
    assert.equal(start.type === "exec_start" ? start.executionId : null, "exe_9");
    assert.deepEqual(sink.events[1], { type: "exec_output", executionId: "exe_9", stream: "stdout", text: "hi\n" });
    assert.deepEqual(sink.events[2], { type: "exec_output", executionId: "exe_9", stream: "stderr", text: "warn\n" });
    const end = sink.events[3]!;
    assert.equal(end.type === "exec_end" ? end.exitCode : null, 0);
    assert.equal(end.type === "exec_end" ? end.state : null, "completed");
    // 命令原文被包成 `bash -lc` 发下去（偏差 A-1）。
    assert.deepEqual((result.content[0] as { text: string }).text.includes("hi"), true);
  });

  test("没有 sink 时工具照常工作（观察窗不是必需品）", async () => {
    const exec: ExecPort = {
      async execInSandbox(_sandboxId, request) {
        request.onEvent?.(sse("started", { execution_id: "exe_1", cmd: ["bash", "-lc", "echo"], cwd: "/workspace" }));
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
    const toolkit = createSandboxToolkit({
      sandboxId: "sbx_test",
      exec,
      api: {} as unknown as SandboxFilesPort,
      target: { endpoint: "http://x", authToken: "t", sandboxId: "sbx_test" },
      repoDir: "/workspace/repo",
      log: noopLog,
    });
    const bash = toolkit.tools.find((tool) => tool.name === "bash")!;
    const result = await bash.execute("call_1", { command: "echo" } as never);
    assert.equal((result.content[0] as { text: string }).text.includes("no output"), true);
  });
});
