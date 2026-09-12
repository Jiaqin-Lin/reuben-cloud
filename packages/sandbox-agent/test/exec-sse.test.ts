/**
 * 用例 11、12 + 心跳。SSE 重连语义是风险登记里排第三的那条：
 * Last-Event-ID、心跳、跨 chunk 帧，三个都能独立出错，且错了表现为「偶尔丢输出」。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  SseClient,
  TEST_TOKEN,
  drainUntilTerminal,
  startTestAgent,
  type SseEvent,
  type TestAgent,
} from "./harness.ts";

let agent: TestAgent;

before(async () => {
  agent = await startTestAgent();
});

after(async () => {
  await agent.close();
});

test("11: Last-Event-ID 重连不丢不重", async () => {
  const response = await agent.exec({
    cmd: ["bash", "-lc", "for i in $(seq 1 10); do echo line$i; sleep 0.12; done"],
  });
  const { execution_id } = (await response.json()) as { execution_id: string };
  const url = `${agent.baseUrl}/exec/${execution_id}/events`;

  const first = await SseClient.connect(url, TEST_TOKEN);
  const firstBatch: SseEvent[] = [];
  try {
    while (firstBatch.length < 3) firstBatch.push(await first.next());
  } finally {
    first.close(); // 模拟断线
  }

  const lastSeen = firstBatch.at(-1)!.id;
  assert.ok(lastSeen !== null, "事件必须带 id");

  const second = await SseClient.connect(url, TEST_TOKEN, lastSeen!);
  const rest = await drainUntilTerminal(second);

  const ids = [...firstBatch, ...rest]
    .map((event) => event.id)
    .filter((id): id is number => id !== null);

  assert.equal(new Set(ids).size, ids.length, "不应该有重复 id");
  const highest = Math.max(...ids);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    Array.from({ length: highest }, (_, i) => i + 1),
    "id 应该从 1 开始连续，无缺口",
  );

  const stdout = [...firstBatch, ...rest]
    .filter((event) => event.event === "stdout")
    .map((event) => event.data.chunk as string)
    .join("");
  assert.match(stdout, /line10/, "重连之后也要拿到完整输出");
});

test("12: 缓冲被淘汰后重连 → truncated{reason:replay_gap}", async () => {
  // 默认容量（1000 条）下制造空洞需要 100 秒起步，所以这里把容量调小。
  const small = await startTestAgent({ config: { eventBufferMaxEvents: 3 } });
  try {
    const response = await small.exec({
      cmd: ["bash", "-lc", "for i in $(seq 1 8); do echo line$i; sleep 0.15; done"],
    });
    const { execution_id } = (await response.json()) as { execution_id: string };
    const url = `${small.baseUrl}/exec/${execution_id}/events`;

    const first = await SseClient.connect(url, TEST_TOKEN);
    let highest = 0;
    try {
      while (highest < 6) {
        const event = await first.next();
        if (event.id !== null) highest = Math.max(highest, event.id);
      }
    } finally {
      first.close();
    }

    const second = await SseClient.connect(url, TEST_TOKEN, 1);
    const replayed: SseEvent[] = [];
    try {
      for (let i = 0; i < 3; i += 1) replayed.push(await second.next());
    } finally {
      second.close();
    }

    const gap = replayed[0]!;
    assert.equal(gap.event, "truncated");
    assert.equal(gap.data.reason, "replay_gap");
    assert.equal(gap.data.from_id, 1);
    assert.equal(gap.id, null, "合成出来的 replay_gap 不应该占用一个真实 id");
    assert.equal(gap.data.log_path, `${small.config.logRoot}/${execution_id}.log`);

    // 缓冲里还在的事件接着补发
    assert.ok(replayed.slice(1).every((event) => event.id !== null));
  } finally {
    await small.close();
  }
});

test("extra: 空闲连接能收到心跳注释帧", async () => {
  const quiet = await startTestAgent({ config: { heartbeatMs: 150 } });
  try {
    const response = await quiet.exec({ cmd: ["sleep", "1.2"] });
    const { execution_id } = (await response.json()) as { execution_id: string };

    const stream = await fetch(`${quiet.baseUrl}/exec/${execution_id}/events`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(stream.status, 200);

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3_000;
    try {
      while (Date.now() < deadline && !text.includes(": ping")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    assert.ok(text.includes(": ping"), `应该收到心跳帧，实际收到：${JSON.stringify(text.slice(0, 200))}`);
  } finally {
    await quiet.close();
  }
});

test("extra: 终态事件之后连接被关掉（客户端可以安全收尾）", async () => {
  const response = await agent.exec({ cmd: ["true"] });
  const { execution_id } = (await response.json()) as { execution_id: string };
  const client = await SseClient.connect(`${agent.baseUrl}/exec/${execution_id}/events`, TEST_TOKEN);

  const events: SseEvent[] = [];
  try {
    for (;;) {
      const event = await client.next();
      events.push(event);
      if (event.event === "completed") break;
    }
    // 终态之后再读应该得到「流已结束」，而不是永远挂着
    await assert.rejects(client.next(2_000), /SSE stream ended|timed out/);
  } finally {
    client.close();
  }
  assert.equal(events.at(-1)!.event, "completed");
});
