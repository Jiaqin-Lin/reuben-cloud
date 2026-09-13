/**
 * Phase 1 · 事件流与对外 API 形状。
 *
 * `EventStream` 是"模型响应"与"循环事件"两个通道的载体，它有两个消费方（边走边看、
 * 只要终态）。这里验的就是那两个消费方能同时成立、以及完成/结束语义不丢事件。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventStream, createAssistantMessageEventStream } from "../src/event-stream.ts";
import { agentLoop, agentLoopContinue } from "../src/loop.ts";
import { ScriptedModel, stepText, stepToolCalls, toolCall } from "./helpers.ts";

describe("Phase 1 · EventStream", () => {
  test("先 push 后消费：按入队顺序取出，完成事件也会被看到", async () => {
    const stream = new EventStream<string, string>((event) => event === "end", () => "DONE");
    stream.push("a");
    stream.push("b");
    stream.push("end");
    stream.push("after-end"); // 完成之后的一律丢弃
    const seen: string[] = [];
    for await (const event of stream) seen.push(event);
    assert.deepEqual(seen, ["a", "b", "end"]);
    assert.equal(await stream.result(), "DONE");
    assert.equal(await stream.result(), "DONE", "result() 可以多次 await");
  });

  test("先消费后 push：等待者被逐个唤醒；end() 放掉剩下的等待者", async () => {
    const stream = new EventStream<number, number>((event) => event === 0, () => 0);
    const collected: number[] = [];
    const consuming = (async () => {
      for await (const event of stream) collected.push(event);
    })();
    await new Promise((resolve) => setImmediate(resolve));
    stream.push(1);
    stream.push(2);
    // 还没结束：消费者应当已经拿到 1、2，但循环没有退出。
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(collected, [1, 2]);
    stream.end(99);
    await consuming;
    assert.deepEqual(collected, [1, 2]);
    assert.equal(await stream.result(), 99);
  });

  test("没有完成事件时 end() 也能收尾（消费方不会永远挂着）", async () => {
    const stream = new EventStream<string, string[]>(() => false, () => []);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    stream.end();
    assert.deepEqual(await pending, { value: undefined, done: true });
  });

  test("AssistantMessageEventStream：done 事件自带终态消息", async () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { role: "assistant", content: [] } });
    stream.push({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
    });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    assert.deepEqual(events, ["start", "done"]);
    assert.deepEqual((await stream.result()).content, [{ type: "text", text: "hi" }]);
  });
});

describe("Phase 1 · 对外 API 形状", () => {
  test("agentLoop 返回事件流：迭代与 result() 指向同一次执行", async () => {
    const model = new ScriptedModel([stepToolCalls([toolCall("tu_1", "read", {})]), stepText("好")]);
    const stream = agentLoop(
      [{ role: "user", content: "干活" }],
      { systemPrompt: "s", messages: [], tools: [fakeRead()] },
      { model },
    );
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    assert.equal(types[0], "agent_start");
    assert.equal(types[types.length - 1], "agent_end");
    const messages = await stream.result();
    assert.equal(messages.length, 4, "user prompt + assistant + toolResult + assistant");
  });

  test("agentLoopContinue：空上下文 / 以 assistant 结尾 → 明确报错；正常续跑能跑", async () => {
    assert.throws(
      () => agentLoopContinue({ systemPrompt: "s", messages: [] }, { model: new ScriptedModel([]) }),
      /一条消息都没有/,
    );
    assert.throws(
      () =>
        agentLoopContinue(
          { systemPrompt: "s", messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }] },
          { model: new ScriptedModel([]) },
        ),
      /最后一条消息是 assistant/,
    );

    const model = new ScriptedModel([stepText("继续完成")]);
    const messages = await agentLoopContinue(
      { systemPrompt: "s", messages: [{ role: "user", content: "上一轮的收尾" }] },
      { model },
    ).result();
    assert.equal(messages.length, 1);
    assert.equal(model.requests.length, 1);
  });
});

function fakeRead() {
  return {
    name: "read",
    label: "read",
    description: "read",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    },
  };
}
