/**
 * Phase 1 · 会话的两个入口（`handleUserMessage` / `steer`，不需要 Docker、不需要模型）。
 *
 * 对应 spec 测试要点 13：空闲时来的消息开一次新执行；一句进行中来的消息注入当前执行
 * （不新开）；两者都**不主动建沙箱**。P1 的锁是内存实现，P2 换成 PG 条件更新——接口与
 * 这三条断言不变。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunOutcome, SessionRunStartInput } from "../../src/agent/session-runtime.ts";
import { SessionBusyError, SessionRuntime, createSteeringQueue } from "../../src/agent/session-runtime.ts";
import { emptyUsage } from "@reuben-cloud/agent-runtime";

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return { ok: true, stopReason: "end_turn", detail: "模型正常收工", turns: 1, toolCalls: 0, usage: emptyUsage(), ...overrides };
}

/** 一个"要等我放行才结束"的假执行体。`release()` 放行**所有**还在等的那几次执行。 */
function controllableStarter(): {
  starts: SessionRunStartInput[];
  release: (value?: RunOutcome) => void;
  start: (input: SessionRunStartInput) => Promise<RunOutcome>;
} {
  const starts: SessionRunStartInput[] = [];
  const pending = new Set<(value: RunOutcome) => void>();
  return {
    starts,
    release: (value) => {
      for (const resolve of [...pending]) resolve(value ?? outcome());
      pending.clear();
    },
    async start(input) {
      starts.push(input);
      return new Promise<RunOutcome>((resolve) => {
        pending.add(resolve);
      });
    },
  };
}

describe("Phase 1 · 会话入口", () => {
  test("空闲时来的消息开一次新执行，且给的入参里没有沙箱（用到才建）", async () => {
    const starter = controllableStarter();
    let runSeq = 0;
    const runtime = new SessionRuntime({ start: starter.start, newRunId: () => `run_${++runSeq}` });
    const handle = await runtime.handleUserMessage("ses_1", "帮我看看这段代码");
    assert.equal(handle.runId, "run_1");
    assert.equal(starter.starts.length, 1);
    assert.equal(starter.starts[0]!.sessionId, "ses_1");
    assert.equal(starter.starts[0]!.text, "帮我看看这段代码");
    // "不主动建沙箱"= 起执行的入参里**根本没有**沙箱这个概念；
    // 建不建是工具层第一次真的要碰代码时的事（P2 的 sandbox-lease）。
    assert.deepEqual(Object.keys(starter.starts[0]!).sort(), ["runId", "sessionId", "signal", "steering", "text"]);

    starter.release();
    await handle.result;
    assert.equal(runtime.isBusy("ses_1"), false);
  });

  test("一句进行中来的消息：`steer` 注入当前执行（不新开），`handleUserMessage` 明确被拒", async () => {
    const starter = controllableStarter();
    const runtime = new SessionRuntime({ start: starter.start, newRunId: () => "run_1" });
    const handle = await runtime.handleUserMessage("ses_1", "第一句");
    await Promise.resolve();

    // 插话：进队列，不新开执行。
    assert.equal(runtime.steer(handle.runId, "换个思路"), true);
    assert.equal(starter.starts.length, 1, "插话不能新开一次执行");
    assert.equal(starter.starts[0]!.steering.size, 1);
    assert.deepEqual(starter.starts[0]!.steering.drain(), [{ role: "user", content: "换个思路" }]);
    assert.equal(starter.starts[0]!.steering.size, 0);

    // 同一会话再来一句话：直接拒绝（不是排队、也不是静默串行）。
    await assert.rejects(
      () => runtime.handleUserMessage("ses_1", "第二句"),
      (error: unknown) => {
        assert.ok(error instanceof SessionBusyError);
        assert.equal(error.code, "session_busy");
        assert.equal(error.activeRunId, "run_1");
        return true;
      },
    );
    assert.equal(starter.starts.length, 1);

    // 另一个会话不受影响。
    const other = await runtime.handleUserMessage("ses_2", "另一个会话");
    assert.equal(other.runId, "run_1", "测试的 newRunId 是常量；这里只关心它开起来了");
    assert.equal(starter.starts.length, 2);

    starter.release();
    await handle.result;
    assert.equal(runtime.activeRunId("ses_1"), null);
  });

  test("执行结束后锁释放：下一句开新的一次执行；插话到已结束的 runId 返回 false", async () => {
    const starter = controllableStarter();
    let runSeq = 0;
    const runtime = new SessionRuntime({ start: starter.start, newRunId: () => `run_${++runSeq}` });
    const first = await runtime.handleUserMessage("ses_1", "第一句");
    starter.release();
    await first.result;

    assert.equal(runtime.activeRunId("ses_1"), null);
    assert.equal(runtime.steer(first.runId, "太晚了"), false);

    const second = await runtime.handleUserMessage("ses_1", "第二句");
    assert.equal(second.runId, "run_2");
    assert.equal(starter.starts.length, 2);
    assert.match(starter.starts[1]!.text, /第二句/);
    starter.release();
    await second.result;
  });

  test("执行体抛异常 → 结构化终态（ok=false），且锁照样释放", async () => {
    let runSeq = 0;
    const runtime = new SessionRuntime({
      start: async () => {
        throw new Error("沙箱建不起来");
      },
      newRunId: () => `run_${++runSeq}`,
    });
    const handle = await runtime.handleUserMessage("ses_1", "干活");
    const result = await handle.result;
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "run_error");
    assert.match(result.detail, /沙箱建不起来/);
    assert.equal(runtime.isBusy("ses_1"), false);
  });

  test("插话队列只有进出两个动作（drain 之后为空）", () => {
    const queue = createSteeringQueue();
    assert.equal(queue.size, 0);
    queue.push({ role: "user", content: "a" });
    queue.push({ role: "user", content: "b" });
    assert.equal(queue.size, 2);
    assert.deepEqual(
      queue.drain().map((message) => (message.role === "user" ? message.content : null)),
      ["a", "b"],
    );
    assert.equal(queue.size, 0);
  });
});
