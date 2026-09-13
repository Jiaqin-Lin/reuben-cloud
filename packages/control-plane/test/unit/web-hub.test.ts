/**
 * Phase 13 · 观察窗的服务端缓冲（`web/hub.ts`）。**不需要网络、不需要浏览器、不需要 Docker**。
 *
 * 这里验的是"重放能不能接上"这一整类性质，也就是 spec 测试要点的第二条
 * （`EventSource` 自带 `Last-Event-ID`，服务端必须按它补发）：
 *  - id 单调递增、订阅者拿到实时事件
 *  - `afterId` 只补发之后的；落在淘汰区时先给一条 `gap` 说明
 *  - 文本增量按窗口合并，且**不越过**下一条非文本事件（顺序不能乱）
 *  - 条数 / 字节两条上限都淘汰最老的
 *  - 单个订阅者积压过多时丢最老的并说明，不拖慢 emit
 *  - run 的淘汰只动已结束的（正在跑的 run 不淘汰）
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunEvent } from "../../src/agent/events.ts";
import { RunHub } from "../../src/web/hub.ts";
import type { RunEventRecord, Subscription } from "../../src/web/hub.ts";

function text(delta: string): RunEvent {
  return { type: "text", delta };
}

function note(message: string): RunEvent {
  return { type: "note", turn: 1, kind: "test", message };
}

function runStart(model = "test-model", issue = "修一个 bug"): RunEvent {
  return {
    type: "run_start",
    runId: "run_1",
    model,
    issue,
    repoDir: "/workspace/repo",
    limits: { maxTurns: 40, wallClockMs: 1000, outputTokenBudget: 1000, maxTokens: 100 },
  };
}

function runEnd(stopReason = "end_turn", ok = true): RunEvent {
  return {
    type: "run_end",
    ok,
    stopReason,
    detail: "模型正常收工",
    turns: 3,
    toolCalls: 5,
    usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
}

/** 把一个订阅者当下能拿到的都收集起来（用于"补发"这类同步可判定的情形）。 */
async function drain(subscription: Subscription, count: number): Promise<RunEventRecord[]> {
  const records: RunEventRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await subscription.next();
    if (next.done === true) break;
    records.push(next.value);
  }
  return records;
}

describe("Phase 13 · hub 的基本行为", () => {
  test("id 从 1 起单调递增，订阅者实时拿到", async () => {
    const hub = new RunHub({ textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    const subscription = hub.subscribe("run_1")!;
    sink.emit(runStart());
    sink.emit(text("你好"));
    sink.emit(note("第二条"));

    const records = await drain(subscription, 3);
    assert.deepEqual(
      records.map((record) => record.id),
      [1, 2, 3],
    );
    assert.deepEqual(
      records.map((record) => record.event.type),
      ["run_start", "text", "note"],
    );
  });

  test("ensure 幂等：两次拿到同一个 run 的 sink", () => {
    const hub = new RunHub();
    hub.ensure("run_1").emit(runStart());
    hub.ensure("run_1").emit(text("继续"));
    hub.flush();
    assert.equal(hub.info("run_1")?.lastEventId, 2);
    assert.equal(hub.runCount, 1);
  });

  test("没有这个 run：subscribe 返回 null，info 也返回 null", () => {
    const hub = new RunHub();
    assert.equal(hub.subscribe("run_missing"), null);
    assert.equal(hub.info("run_missing"), null);
  });

  test("info 从事件里补元信息：run_start 填模型/题面，run_end 填终态", () => {
    const hub = new RunHub();
    const sink = hub.ensure("run_1");
    const before = hub.info("run_1")!;
    assert.equal(before.model, null);
    assert.equal(before.status, "running");
    assert.equal(before.endedAt, null);

    sink.emit(runStart("deepseek-flash", "把测试修好"));
    const during = hub.info("run_1")!;
    assert.equal(during.model, "deepseek-flash");
    assert.equal(during.issue, "把测试修好");

    sink.emit(runEnd("max_turns", false));
    const after = hub.info("run_1")!;
    assert.equal(after.status, "ended");
    assert.equal(after.stopReason, "max_turns");
    assert.equal(after.ok, false);
    assert.notEqual(after.endedAt, null);
  });

  test("latest 是最后登记的那个 run（`GET /` 跳它）", () => {
    const hub = new RunHub();
    assert.equal(hub.latest(), null);
    hub.ensure("run_1");
    hub.ensure("run_2");
    assert.equal(hub.latest(), "run_2");
  });

  test("release 之后订阅者不再收事件，也不会把订阅者数量算错", async () => {
    const hub = new RunHub({ textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    const subscription = hub.subscribe("run_1")!;
    assert.equal(hub.info("run_1")?.subscribers, 1);
    hub.release("run_1", subscription);
    assert.equal(hub.info("run_1")?.subscribers, 0);

    sink.emit(note("没人听了"));
    const next = await subscription.next();
    assert.equal(next.done, true);
  });

  test("两个订阅者各拿一份，互不影响", async () => {
    const hub = new RunHub({ textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    const first = hub.subscribe("run_1")!;
    const second = hub.subscribe("run_1")!;
    sink.emit(note("广播"));
    assert.equal((await first.next()).value?.event.type, "note");
    assert.equal((await second.next()).value?.event.type, "note");
    assert.equal(hub.info("run_1")?.subscribers, 2);
  });

  test("signal 一 abort，订阅就结束（SSE 断线的那条路）", async () => {
    const hub = new RunHub();
    hub.ensure("run_1");
    const controller = new AbortController();
    const subscription = hub.subscribe("run_1", { signal: controller.signal })!;
    controller.abort();
    const next = await subscription.next();
    assert.equal(next.done, true);
  });
});

describe("Phase 13 · 重放（Last-Event-ID）", () => {
  test("afterId 只补发之后的：断线重连不重不漏", async () => {
    const hub = new RunHub({ textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    sink.emit(note("一"));
    sink.emit(note("二"));
    sink.emit(note("三"));

    // 客户端说"我收到 2 了" → 只该给 3。这里先把首连的三条读掉，模拟已经收到 2。
    const first = hub.subscribe("run_1")!;
    await drain(first, 3);
    hub.release("run_1", first);

    const resumed = hub.subscribe("run_1", { afterId: 2 })!;
    const records = await drain(resumed, 1);
    assert.deepEqual(
      records.map((record) => record.id),
      [3],
    );
  });

  test("afterId 等于最大值（没有新东西）时只跟新的", async () => {
    const hub = new RunHub({ textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    sink.emit(note("一"));
    const subscription = hub.subscribe("run_1", { afterId: 1 })!;
    sink.emit(note("二"));
    const records = await drain(subscription, 1);
    assert.equal(records[0]?.id, 2);
  });

  test("游标落在淘汰区：先给一条 gap 说明，再给还在缓冲里的", async () => {
    const hub = new RunHub({ textCoalesceMs: 0, maxEventsPerRun: 3 });
    const sink = hub.ensure("run_1");
    for (let index = 1; index <= 5; index += 1) sink.emit(note(`第 ${index} 条`));
    assert.equal(hub.info("run_1")?.lastEventId, 5);
    assert.equal(hub.info("run_1")?.bufferedEvents, 3);

    const subscription = hub.subscribe("run_1", { afterId: 0 })!;
    const records = await drain(subscription, 4);
    assert.deepEqual(
      records.map((record) => record.id),
      [2, 3, 4, 5],
    );
    const gap = records[0]!.event;
    assert.equal(gap.type, "note");
    assert.equal(gap.type === "note" ? gap.kind : null, "gap");
    // 说明里要写清"你要的第一条已经没了"，而不是静默少一段。
    assert.match(gap.type === "note" ? gap.message : "", /最早的 id 是 3/);
  });

  test("从头订阅（afterId=null）不产生 gap：缓冲里的都给它", async () => {
    const hub = new RunHub({ textCoalesceMs: 0, maxEventsPerRun: 2 });
    const sink = hub.ensure("run_1");
    for (let index = 1; index <= 4; index += 1) sink.emit(note(`第 ${index} 条`));
    const records = await drain(hub.subscribe("run_1")!, 2);
    assert.deepEqual(
      records.map((record) => record.id),
      [3, 4],
    );
  });
});

describe("Phase 13 · 文本增量合并", () => {
  test("coalesceMs=0 时不合并（逐条发）", async () => {
    const hub = new RunHub({ textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    sink.emit(text("你"));
    sink.emit(text("好"));
    const records = await drain(hub.subscribe("run_1")!, 2);
    assert.deepEqual(
      records.map((record) => (record.event.type === "text" ? record.event.delta : null)),
      ["你", "好"],
    );
  });

  test("攒到窗口结束合成一条（flush 之后）", async () => {
    const hub = new RunHub({ textCoalesceMs: 60_000 });
    const sink = hub.ensure("run_1");
    sink.emit(text("你"));
    sink.emit(text("好"));
    assert.equal(hub.info("run_1")?.lastEventId, 0, "还没到窗口，不该发出去");
    hub.flush();
    const records = await drain(hub.subscribe("run_1")!, 1);
    assert.equal(records[0]?.event.type === "text" ? records[0].event.delta : null, "你好");
  });

  test("非文本事件**先把文本放出去**，顺序不乱（`tool_call` 不能跑到它前面）", async () => {
    const hub = new RunHub({ textCoalesceMs: 60_000 });
    const sink = hub.ensure("run_1");
    sink.emit(text("我先说的"));
    sink.emit(note("然后才是这一条"));
    const records = await drain(hub.subscribe("run_1")!, 2);
    assert.equal(records[0]?.event.type, "text");
    assert.equal(records[1]?.event.type, "note");
  });

  test("定时器到点自己会发（不用外部推动）", async () => {
    const hub = new RunHub({ textCoalesceMs: 5 });
    const sink = hub.ensure("run_1");
    const subscription = hub.subscribe("run_1")!;
    sink.emit(text("稍后见"));
    const next = await subscription.next();
    assert.equal(next.value?.event.type, "text");
  });
});

describe("Phase 13 · 上限与淘汰", () => {
  test("字节先到也淘汰最老的（至少留最新一条）", () => {
    const hub = new RunHub({ textCoalesceMs: 0, maxBytesPerRun: 300 });
    const sink = hub.ensure("run_1");
    for (let index = 0; index < 10; index += 1) sink.emit(note("x".repeat(100)));
    const info = hub.info("run_1")!;
    assert.equal(info.lastEventId, 10);
    assert.ok(info.bufferedEvents < 10, `缓冲应该被淘汰过，实际 ${info.bufferedEvents}`);
    assert.ok(info.bufferedBytes <= 300 || info.bufferedEvents === 1);
  });

  test("单个订阅者积压过多：丢最老的 + 一条 gap，emit 不等它", async () => {
    const hub = new RunHub({ textCoalesceMs: 0, maxQueuedEvents: 2 });
    const sink = hub.ensure("run_1");
    const subscription = hub.subscribe("run_1")!;
    for (let index = 1; index <= 4; index += 1) sink.emit(note(`第 ${index} 条`));
    const records = await drain(subscription, 3);
    assert.equal(records[0]?.event.type, "note");
    assert.equal(records[0]?.event.type === "note" ? records[0].event.kind : null, "gap");
    assert.deepEqual(
      records.slice(1).map((record) => record.id),
      [3, 4],
    );
    assert.equal(hub.info("run_1")?.lastEventId, 4, "Run 本身一条都没丢");
  });

  test("超过 maxRuns 淘汰最老的**已结束** run", () => {
    const hub = new RunHub({ maxRuns: 2, textCoalesceMs: 0 });
    hub.ensure("run_1").emit(runEnd());
    hub.ensure("run_2").emit(runEnd());
    hub.ensure("run_3").emit(runEnd());
    assert.equal(hub.runCount, 2);
    assert.equal(hub.info("run_1"), null);
    assert.notEqual(hub.info("run_3"), null);
  });

  test("被淘汰的 run 的订阅者会被结束（不留僵尸连接）", async () => {
    const hub = new RunHub({ maxRuns: 1, textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    const subscription = hub.subscribe("run_1")!;
    sink.emit(runEnd());
    hub.ensure("run_2").emit(runEnd()); // 顶掉 run_1

    const first = await subscription.next();
    assert.equal(first.value?.event.type, "run_end", "已经收到的事件要能读完");
    const second = await subscription.next();
    assert.equal(second.done, true, "淘汰之后订阅必须收尾，而不是永远挂着");
  });

  test("正在跑的 run 一律不淘汰（哪怕超出 maxRuns）", () => {
    const hub = new RunHub({ maxRuns: 1, textCoalesceMs: 0 });
    hub.ensure("run_1").emit(runStart());
    hub.ensure("run_2").emit(runStart());
    assert.equal(hub.runCount, 2);
    assert.notEqual(hub.info("run_1"), null);
  });

  test("服务器关停：所有订阅正常收尾（页面能把已收到的渲染完）", async () => {
    const hub = new RunHub({ textCoalesceMs: 0 });
    const sink = hub.ensure("run_1");
    const subscription = hub.subscribe("run_1")!;
    sink.emit(note("关停前"));
    hub.close();
    const first = await subscription.next();
    assert.equal(first.value?.event.type, "note");
    const second = await subscription.next();
    assert.equal(second.done, true);
  });
});
