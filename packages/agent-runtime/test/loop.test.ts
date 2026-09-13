/**
 * Phase 1 · Agent 循环（不需要网络、不需要模型、不需要 Docker）。
 *
 * 用「脚本化模型 + 假工具 + 事件录制」跑，验的都是**循环自己的性质**——对应 spec
 * 「测试要点」的 1–9：
 *  · 事件序列与顺序（含 message_update 增量）
 *  · 一条响应里 3 个 tool call：并行执行、结果按源码顺序、同一条协议消息
 *  · `length` 截断：一个工具都不执行，全部回 isError
 *  · 工具抛异常：变成 isError 结果，循环继续
 *  · `executionMode` 混用：有 sequential 时整批串行
 *  · steering / follow-up / abort / shouldStopAfterTurn
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConvertToLlm, runAgentLoop, toLlmTools } from "../src/loop.ts";
import { defaultStopPolicy, createRepeatGuard, REPEAT_NOTICE } from "../src/limits.ts";
import { toSdkMessages } from "../src/model/client.ts";
import type { AgentEvent, AgentMessage, AgentTool, AssistantMessage, ToolResultMessage } from "../src/types.ts";
import {
  ScriptedModel,
  assertTypeOrder,
  createEventRecorder,
  fakeTool,
  stepText,
  stepToolCalls,
  text,
  toolCall,
  toolResultsOf,
} from "./helpers.ts";

function textOf(message: AgentMessage): string {
  if (message.role === "toolResult") {
    return message.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  if (message.role === "user") return typeof message.content === "string" ? message.content : "";
  return "";
}

function toolResultMessages(messages: readonly AgentMessage[]): ToolResultMessage[] {
  return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

// ---------------------------------------------------------------- 用例 1

describe("Phase 1 · 事件序列", () => {
  test("用例 1：两轮工具 + 收工 → 事件类型与顺序完全匹配（含 message_update 增量）", async () => {
    const model = new ScriptedModel([
      stepToolCalls([toolCall("tu_1", "read", { path: "a.ts" })]),
      stepToolCalls([toolCall("tu_2", "bash", { command: "npm test" })]),
      stepText("改完了，测试通过"),
    ]);
    const recorder = createEventRecorder();
    const tools: AgentTool[] = [
      fakeTool("read"),
      fakeTool("bash"),
    ];
    const messages = await runAgentLoop(
      [{ role: "user", content: "修一个 bug" }],
      { systemPrompt: "system", messages: [], tools },
      { model },
      recorder.emit,
    );

    assertTypeOrder(recorder.types(), [
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);

    // 第一条 message_start 是任务书（user prompt）。
    const starts = recorder.ofType("message_start");
    assert.equal(starts[0]?.message.role, "user");
    assert.match(textOf(starts[0]!.message), /修一个 bug/);

    // 文字增量拼起来 == 最终文本（打字机效果的契约）。
    const deltas = recorder
      .ofType("message_update")
      .map((event) => event.assistantMessageEvent)
      .filter((event): event is Extract<typeof event, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.delta);
    assert.equal(deltas.join(""), "改完了，测试通过");

    // agent_end 是最后一条，且带回全部新增消息。
    const last = recorder.events[recorder.events.length - 1];
    assert.equal(last?.type, "agent_end");
    assert.deepEqual(messages, (last as Extract<AgentEvent, { type: "agent_end" }>).messages);
    assert.equal(toolResultsOf(messages).length, 2);
  });
});

// ---------------------------------------------------------------- 用例 2

describe("Phase 1 · 工具批次", () => {
  test("用例 2：一条响应里 3 个 tool call → 并行执行、结果按源码顺序、同一条协议消息", async () => {
    const slow = fakeTool("slow", { delayMs: 40 });
    const fastB = fakeTool("fastB");
    const fastC = fakeTool("fastC");
    const model = new ScriptedModel([
      stepToolCalls([
        toolCall("tu_a", "slow", { n: 1 }),
        toolCall("tu_b", "fastB", { n: 2 }),
        toolCall("tu_c", "fastC", { n: 3 }),
      ]),
      stepText("好"),
    ]);
    const recorder = createEventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", content: "并行做三件事" }],
      { systemPrompt: "system", messages: [], tools: [slow, fastB, fastC] },
      { model },
      recorder.emit,
    );

    // 三个工具都被调到、参数正确。
    assert.deepEqual(slow.calls.map((call) => call.id), ["tu_a"]);
    assert.deepEqual(fastB.calls.map((call) => call.id), ["tu_b"]);
    assert.deepEqual(fastC.calls.map((call) => call.id), ["tu_c"]);

    // 结果按**源码顺序**（a/b/c）拼装，且都在同一条（协议层的）user 消息里。
    const results = toolResultMessages(messages);
    assert.deepEqual(results.map((message) => message.toolCallId), ["tu_a", "tu_b", "tu_c"]);
    const sdk = toSdkMessages(defaultConvertToLlm(messages.slice(1)));
    const toolResultMessage = sdk.filter((message) => JSON.stringify(message.content).includes("tool_result"));
    assert.equal(toolResultMessage.length, 1, "三个 tool_result 必须在同一条 user 消息里");
    assert.deepEqual(
      (toolResultMessage[0]!.content as Array<{ tool_use_id: string }>).map((block) => block.tool_use_id),
      ["tu_a", "tu_b", "tu_c"],
    );

    // 并行：慢的那个**最后**结束（end 事件按完成顺序发）。
    const ends = recorder.ofType("tool_execution_end").map((event) => event.toolCallId);
    assert.deepEqual(ends, ["tu_b", "tu_c", "tu_a"]);
    // 但 start 是按源码顺序发的。
    assert.deepEqual(
      recorder.ofType("tool_execution_start").map((event) => event.toolCallId),
      ["tu_a", "tu_b", "tu_c"],
    );
  });

  test("用例 5：有 sequential 工具时整批串行（start/end 交错）", async () => {
    const a = fakeTool("a", { delayMs: 5 });
    const b = fakeTool("b", { delayMs: 5, executionMode: "sequential" });
    const c = fakeTool("c", { delayMs: 5 });
    const model = new ScriptedModel([
      stepToolCalls([toolCall("tu_a", "a", {}), toolCall("tu_b", "b", {}), toolCall("tu_c", "c", {})]),
      stepText("好"),
    ]);
    const recorder = createEventRecorder();
    await runAgentLoop(
      [{ role: "user", content: "做三件事" }],
      { systemPrompt: "system", messages: [], tools: [a, b, c] },
      { model },
      recorder.emit,
    );

    const executionEvents = recorder
      .types()
      .filter((type) => type === "tool_execution_start" || type === "tool_execution_end")
      .map((type) => (type === "tool_execution_start" ? "start" : "end"));
    // 串行 = 一个跑完才起下一个。
    assert.deepEqual(executionEvents, ["start", "end", "start", "end", "start", "end"]);
  });

  test("用例 3：stopReason=length 且有 tool call → 一个工具都不执行，全部回 isError（含\"重发\"）", async () => {
    const read = fakeTool("read");
    const write = fakeTool("write");
    const model = new ScriptedModel([
      stepToolCalls([toolCall("tu_1", "read", {}), toolCall("tu_2", "write", {})], { stopReason: "length" }),
      stepText("重发完了"),
    ]);
    const messages = await runAgentLoop(
      [{ role: "user", content: "改代码" }],
      { systemPrompt: "system", messages: [], tools: [read, write] },
      { model },
    );

    assert.equal(read.calls.length, 0, "被截断的批次不能执行任何工具");
    assert.equal(write.calls.length, 0);
    const results = toolResultMessages(messages);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.isError, true);
      assert.match(textOf(result), /重发/);
    }
  });

  test("用例 4：工具抛异常 → 变 isError 结果，循环继续（模型能看到失败）", async () => {
    const broken = fakeTool("broken", {
      execute: async () => {
        throw new Error("磁盘满了");
      },
    });
    const model = new ScriptedModel([stepToolCalls([toolCall("tu_1", "broken", {})]), stepText("换个办法")]);
    const messages = await runAgentLoop(
      [{ role: "user", content: "干活" }],
      { systemPrompt: "system", messages: [], tools: [broken] },
      { model },
    );

    const results = toolResultMessages(messages);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true);
    assert.match(textOf(results[0]!), /磁盘满了/);
    // 循环继续到了第二轮，且第二轮看到了失败结果。
    assert.equal(model.requests.length, 2);
    assert.match(JSON.stringify(model.requests[1]!.messages), /磁盘满了/);
  });
});

// ---------------------------------------------------------------- 用例 6/7

describe("Phase 1 · 插话与 follow-up", () => {
  test("用例 6：工具执行中 steer → 在这一轮工具跑完后、下一轮模型调用前注入", async () => {
    const queue: AgentMessage[] = [];
    const worker = fakeTool("worker", {
      execute: async () => {
        // 模拟"用户在这条命令还在跑的时候说了话"。
        queue.push({ role: "user", content: "换个思路" });
        return { content: [text("ok")], details: {} };
      },
    });
    const model = new ScriptedModel([stepToolCalls([toolCall("tu_1", "worker", {})]), stepText("好的")]);
    await runAgentLoop(
      [{ role: "user", content: "干活" }],
      { systemPrompt: "system", messages: [], tools: [worker] },
      { model, getSteeringMessages: async () => queue.splice(0, queue.length) },
    );

    assert.equal(model.requests.length, 2, "插话不该新开一次执行");
    const second = model.requests[1]!.messages;
    const injected = second.findIndex((message) => JSON.stringify(message).includes("换个思路"));
    const toolResult = second.findIndex((message) => message.role === "toolResult");
    assert.ok(injected > toolResult, "插话必须在工具结果之后注入");
  });

  test("用例 6b：工具**跑的时候**注入的插话不会打断它（工具照常完成）", async () => {
    let sawSteeringDuringTool = false;
    const queue: AgentMessage[] = [];
    const worker = fakeTool("worker", {
      execute: async () => {
        queue.push({ role: "user", content: "插一句" });
        // 等一拍：如果循环"打断工具"，这里之后就看不到自己的结果了。
        await new Promise((resolve) => setTimeout(resolve, 10));
        sawSteeringDuringTool = true;
        return { content: [text("ok")], details: {} };
      },
    });
    const model = new ScriptedModel([stepToolCalls([toolCall("tu_1", "worker", {})]), stepText("好的")]);
    await runAgentLoop(
      [{ role: "user", content: "干活" }],
      { systemPrompt: "system", messages: [], tools: [worker] },
      { model, getSteeringMessages: async () => queue.splice(0, queue.length) },
    );
    assert.equal(sawSteeringDuringTool, true);
    assert.equal(worker.calls.length, 1);
  });

  test("用例 7：agent 要收工时队列里有消息 → 不结束，继续下一轮", async () => {
    const followUps: AgentMessage[] = [{ role: "user", content: "再加一个日志" }];
    const model = new ScriptedModel([stepText("做完了"), stepText("日志加好了")]);
    const messages = await runAgentLoop(
      [{ role: "user", content: "第一件事" }],
      { systemPrompt: "system", messages: [], tools: [] },
      {
        model,
        getFollowUpMessages: async () => followUps.splice(0, followUps.length),
      },
    );
    assert.equal(model.requests.length, 2, "follow-up 应该再跑一轮");
    assert.match(JSON.stringify(model.requests[1]!.messages), /再加一个日志/);
    // 两条 assistant 消息都在结果里。
    assert.equal(messages.filter((message) => message.role === "assistant").length, 2);
  });
});

// ---------------------------------------------------------------- 用例 8

describe("Phase 1 · abort 与停止策略", () => {
  test("用例 8：abort → 当轮工具收到 signal、循环以 aborted 结束、事件齐全", async () => {
    const controller = new AbortController();
    let toolSawAbort = false;
    const worker = fakeTool("worker", {
      execute: async (_args, signal) => {
        // 命令跑到一半被取消：工具必须能看见 signal（这样它才能杀进程组）。
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        toolSawAbort = signal?.aborted === true;
        return { content: [text("killed")], details: {} };
      },
    });
    const model = new ScriptedModel([
      stepToolCalls([toolCall("tu_1", "worker", {})]),
      // 下一轮模型调用在 abort 之后：客户端应当直接给 aborted 终态。
      (stream, request) => {
        assert.equal(request.signal?.aborted, true, "模型调用必须收到 abort 信号");
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "被取消",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "error", reason: "aborted", error: message });
      },
    ]);
    const recorder = createEventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", content: "干活" }],
      { systemPrompt: "system", messages: [], tools: [worker] },
      { model },
      recorder.emit,
      controller.signal,
    );

    assert.equal(toolSawAbort, true);
    const last = messages[messages.length - 1]!;
    assert.equal(last.role === "assistant" && last.stopReason, "aborted");
    assert.equal(recorder.events[recorder.events.length - 1]?.type, "agent_end");
    assert.ok(recorder.ofType("tool_execution_end").length === 1);
    assert.ok(recorder.ofType("turn_end").length === 2);
  });

  test("用例 9：shouldStopAfterTurn 在第 3 轮返回 true → 策略停下（原因可查）", async () => {
    const worker = fakeTool("worker");
    const model = new ScriptedModel([
      stepToolCalls([toolCall("tu_1", "worker", {})]),
      stepToolCalls([toolCall("tu_2", "worker", {})]),
      stepToolCalls([toolCall("tu_3", "worker", {})]),
      stepText("这本该跑不到"),
    ]);
    const policy = defaultStopPolicy({ maxTurns: 3 });
    const recorder = createEventRecorder();
    await runAgentLoop(
      [{ role: "user", content: "一直干活" }],
      { systemPrompt: "system", messages: [], tools: [worker] },
      { model, shouldStopAfterTurn: (context) => policy.shouldStopAfterTurn(context) },
      recorder.emit,
    );

    assert.equal(model.requests.length, 3, "第 3 轮结束就停，不该有第 4 次模型调用");
    assert.equal(policy.stopReason, "max_turns");
    assert.match(policy.detail ?? "", /3 轮/);
    // 事件以 turn_end → agent_end 收尾，没有多出来的 turn_start。
    const types = recorder.types();
    assert.equal(types[types.length - 1], "agent_end");
    assert.equal(types[types.length - 2], "turn_end");
  });
});

// ---------------------------------------------------------------- 用例 10

describe("Phase 1 · 重复调用守卫", () => {
  test("用例 10：第 3 次注入提示、第 4 次停止（挂在 beforeToolCall 上）", async () => {
    const worker = fakeTool("read");
    const notes: string[] = [];
    const guard = createRepeatGuard({ onNote: (kind) => notes.push(kind) });
    const model = new ScriptedModel([
      stepToolCalls([toolCall("tu_1", "read", { path: "a.ts" })]),
      stepToolCalls([toolCall("tu_2", "read", { path: "a.ts" })]),
      stepToolCalls([toolCall("tu_3", "read", { path: "a.ts" })]),
      stepToolCalls([toolCall("tu_4", "read", { path: "a.ts" })]),
      stepText("不该跑到这里"),
    ]);
    const messages = await runAgentLoop(
      [{ role: "user", content: "读文件" }],
      { systemPrompt: "system", messages: [], tools: [worker] },
      { model, beforeToolCall: (context, signal) => guard.beforeToolCall(context, signal) },
    );

    // 第 1、2 次正常执行；第 3 次被拦下（提示）；第 4 次被拦下并终止。
    assert.equal(worker.calls.length, 2);
    const results = toolResultMessages(messages);
    assert.equal(results.length, 4);
    assert.equal(results[0]!.isError, false);
    assert.equal(results[1]!.isError, false);
    assert.equal(results[2]!.isError, true);
    assert.match(textOf(results[2]!), /换一个方法/);
    assert.equal(results[3]!.isError, true);
    assert.equal(guard.stopped, true);
    assert.deepEqual(notes, ["repeat_notice", "repeat_stop"]);
    // 终止发生在第 4 轮结束（模型调用 4 次，第 5 次没跑）。
    assert.equal(model.requests.length, 4);
    assert.equal(REPEAT_NOTICE.length > 0, true);
  });

  test("用例 10b：中间夹了别的调用 → 计数清零（\"连续\"的定义）", async () => {
    const a = fakeTool("a");
    const b = fakeTool("b");
    const guard = createRepeatGuard();
    const model = new ScriptedModel([
      stepToolCalls([toolCall("tu_1", "a", {})]),
      stepToolCalls([toolCall("tu_2", "b", {})]),
      stepToolCalls([toolCall("tu_3", "a", {})]),
      stepToolCalls([toolCall("tu_4", "a", {})]),
      stepText("好"),
    ]);
    await runAgentLoop(
      [{ role: "user", content: "干活" }],
      { systemPrompt: "system", messages: [], tools: [a, b] },
      { model, beforeToolCall: (context, signal) => guard.beforeToolCall(context, signal) },
    );
    // a 出现过 tu_1 / tu_3 / tu_4：中间被 b 打断过一次，所以计数最多到 2。
    assert.equal(guard.stopped, false);
    assert.equal(a.calls.length, 3);
  });
});

// ---------------------------------------------------------------- 工具定义

describe("Phase 1 · 工具定义与别名", () => {
  test("别名（过渡期的 list → ls）能被解析，但工具清单里只有正式名", async () => {
    const lister = fakeTool("ls", { aliases: ["list"] });
    const model = new ScriptedModel([stepToolCalls([toolCall("tu_1", "list", { path: "." })]), stepText("好")]);
    await runAgentLoop(
      [{ role: "user", content: "列目录" }],
      { systemPrompt: "system", messages: [], tools: [lister] },
      { model },
    );
    assert.equal(lister.calls.length, 1, "旧名字应当落到 ls 上");
    const definitions = toLlmTools([lister]);
    assert.deepEqual(definitions.map((tool) => tool.name), ["ls"]);
  });

  test("没有这个工具 → 立即回一条 isError（模型自己能看到名字错了）", async () => {
    const model = new ScriptedModel([stepToolCalls([toolCall("tu_1", "nope", {})]), stepText("好")]);
    const messages = await runAgentLoop(
      [{ role: "user", content: "干活" }],
      { systemPrompt: "system", messages: [], tools: [fakeTool("read")] },
      { model },
    );
    const results = toolResultMessages(messages);
    assert.equal(results[0]!.isError, true);
    assert.match(textOf(results[0]!), /没有这个工具/);
  });
});
