/**
 * Phase 13 · 观察窗的 HTTP 面（真 `node:http` + 真 `fetch`，不回环之外的网络）。
 *
 * 这里对应 spec 测试要点的第二条，而且是**真的在 HTTP 上验**：
 * 「SSE 端点断开后浏览器自动重连能接上（`EventSource` 自带 `Last-Event-ID`）」。
 * 浏览器那边的行为没法在 `node --test` 里跑，所以拆成两半：
 *  - 服务端这一半：带 `Last-Event-ID` 的请求必须只补发之后的事件（本文件）；
 *  - 客户端那一半：`EventSource` 会自动带这个头（这是规范行为，不需要我们实现）。
 * 于是这一条的正确性落在一个可以被断言的契约上，而不是"打开浏览器看一眼"。
 *
 * 另外覆盖：路由与 404、静态白名单（含路径穿越）、心跳、背压与断线后订阅者不泄漏。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { MemorySessionStore } from "@reuben-cloud/agent-runtime";
import { MemorySessionStore as MemoryStore, entryForMessage } from "@reuben-cloud/agent-runtime";
import type { HubEvent } from "../../src/agent/events.ts";
import { RunHub } from "../../src/web/hub.ts";
import type { WebServer } from "../../src/web/server.ts";
import { startWebServer } from "../../src/web/server.ts";

// ---------------------------------------------------------------- 脚手架

let hub: RunHub;
let server: WebServer;
let base = "";
let workDir = "";

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "rc-web-"));
  hub = new RunHub({ textCoalesceMs: 0 });
  server = await startWebServer({ hub, port: 0, heartbeatMs: 40 });
  base = server.url;
});

after(async () => {
  await server.close();
  await rm(workDir, { recursive: true, force: true });
});

interface Frame {
  /** `id:` 字段；心跳注释帧是 null。 */
  id: number | null;
  /** `event:` 字段（SSE 通道名）；心跳注释帧是 null。 */
  name: string | null;
  /** `data:` 的 JSON；心跳注释帧是 null。 */
  data: HubEvent | null;
  /** 心跳（`: ping`）等注释帧。 */
  comment: boolean;
}

function parseFrame(raw: string): Frame {
  let id: number | null = null;
  let name: string | null = null;
  const data: string[] = [];
  let comment = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      comment = true;
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = (colon === -1 ? "" : line.slice(colon + 1)).replace(/^ /, "");
    if (field === "id") id = Number(value);
    else if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  return {
    id,
    name,
    data: data.length === 0 ? null : (JSON.parse(data.join("\n")) as HubEvent),
    comment,
  };
}

/** 打开一条 SSE 连接并逐帧读。调用方负责 `close()`（模拟浏览器关页面）。 */
async function openStream(
  runId: string,
  options: { headers?: Record<string, string>; query?: string } = {},
): Promise<{ frames: AsyncGenerator<Frame>; close(): Promise<void> }> {
  const controller = new AbortController();
  const url = `${base}/runs/${encodeURIComponent(runId)}/stream${options.query ?? ""}`;
  const response = await fetch(url, {
    headers: { accept: "text/event-stream", ...options.headers },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `SSE 应该 200，实际 ${response.status}`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function* frames(): AsyncGenerator<Frame> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          yield parseFrame(raw);
          index = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  return {
    frames: frames(),
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

/** 从流里读 n 帧（跳过心跳），带超时保护：卡住时测试要失败，而不是挂到测试超时。 */
async function readFrames(stream: { frames: AsyncGenerator<Frame> }, count: number): Promise<Frame[]> {
  const out: Frame[] = [];
  while (out.length < count) {
    const next = await nextFrame(stream);
    if (next === null) break;
    if (next.comment) continue;
    out.push(next);
  }
  return out;
}

/** 下一帧（心跳也算），5 秒没动静就算失败。 */
async function nextFrame(stream: { frames: AsyncGenerator<Frame> }): Promise<Frame | null> {
  const next = await Promise.race([
    stream.frames.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("等 SSE 帧超时")), 5_000)),
  ]);
  return next.done === true ? null : next.value;
}

function note(message: string): HubEvent {
  return { type: "note", kind: "test", message };
}

// ---------------------------------------------------------------- 用例

describe("Phase 13 · 路由与静态资源", () => {
  test("没有 run 时 GET / 直接渲染页面（空状态由前端说）", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /id="log"/);
    assert.match(html, /<title>reuben-cloud/);
  });

  test("有 run 时 GET / 跳到最近那个", async () => {
    hub.ensure("run_redirect").emit(note("最近"));
    const response = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/runs/run_redirect");
  });

  test("GET /runs/{id} 是页面（不存在的 id 也渲染页面，由前端说「找不到」）", async () => {
    const response = await fetch(`${base}/runs/run_whatever`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="log"/);
  });

  test("静态资源三种类型，字符集显式声明", async () => {
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.ok((await js.text()).length > 1000);

    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /--accent/);

    const icon = await fetch(`${base}/favicon.ico`);
    assert.equal(icon.status, 204);
  });

  test("白名单之外一律 404：`/package.json`、`/.env`、编码过的穿越、多余路径段", async () => {
    for (const pathname of [
      "/package.json",
      "/.env",
      "/../.env",
      "/%2e%2e%2f.env",
      "/runs/a/b/c/stream",
      "/runs/..%2F..%2Fetc/info",
      "/nope",
    ]) {
      const response = await fetch(`${base}${pathname}`, { redirect: "manual" });
      assert.equal(response.status, 404, `${pathname} 应该 404，实际 ${response.status}`);
    }
  });

  test("静态文件在表里但盘上没有：500，而不是 404", async () => {
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "rc-web-empty-"));
    const lonely = await startWebServer({ hub, port: 0, webRoot: emptyRoot });
    try {
      const response = await fetch(`${lonely.url}/app.js`);
      assert.equal(response.status, 500);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "static_missing");
    } finally {
      await lonely.close();
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  test("非 GET：405（观察窗是只读的）", async () => {
    const response = await fetch(`${base}/runs/run_1/stream`, { method: "POST" });
    assert.equal(response.status, 405);
  });
});

describe("Phase 13 · SSE 端点", () => {
  test("不存在的 run：404 + JSON 说明（不是把连接挂在那儿）", async () => {
    const response = await fetch(`${base}/runs/run_missing/stream`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "run_not_found");
  });

  test("事件按 SSE 帧发出：`id:` 单调、`event:` 是通道名、`data:` 是事件的 JSON", async () => {
    const sink = hub.ensure("run_frames");
    sink.emit(note("第一条"));
    const stream = await openStream("run_frames");
    try {
      sink.emit(note("第二条"));
      const frames = await readFrames(stream, 2);
      assert.equal(frames[0]?.id, 1);
      assert.equal(frames[1]?.id, 2);
      assert.equal(frames[0]?.name, "note", "note 事件走 `note` 通道");
      assert.equal(frames[0]?.data?.type, "note");
      assert.equal(frames[1]?.data?.type === "note" ? frames[1].data.message : null, "第二条");
    } finally {
      await stream.close();
    }
  });

  test("通道名按事件族分：Run 生命周期走 run、循环事件走 message/turn/context/compaction、沙箱输出走 exec", async () => {
    const sink = hub.ensure("run_channels");
    sink.emit({
      type: "run_start",
      runId: "run_channels",
      sessionId: null,
      model: "m",
      issue: "i",
      repoDir: "/workspace/repo",
      limits: { maxTurns: 1, wallClockMs: 1, outputTokenBudget: 1, maxTokens: 1 },
    });
    sink.emit({ type: "turn_start" });
    sink.emit({ type: "message_start", message: { role: "user", content: "hi" } });
    sink.emit({ type: "exec_start", executionId: null, cmd: ["ls"], cwd: null });
    // 上下文面板与压缩标记的数据通道（P4 的壳；数据由 P10 的 ContextCompiler 产）。
    sink.emit({ type: "context_compiled", turn: 1, sections: [{ name: "system", tokens: 10, hash: "h" }], hash: "h" });
    sink.emit({ type: "compaction", reason: "threshold", tokensBefore: 100, firstKeptEntryId: "ent_1" });
    const stream = await openStream("run_channels");
    try {
      const frames = await readFrames(stream, 6);
      assert.deepEqual(
        frames.map((frame) => frame.name),
        ["run", "turn", "message", "exec", "context", "compaction"],
      );
    } finally {
      await stream.close();
    }
  });

  test("重连：带 Last-Event-ID 的请求只补发之后的事件（不重不漏）", async () => {
    const sink = hub.ensure("run_resume");
    sink.emit(note("一"));
    sink.emit(note("二"));
    sink.emit(note("三"));

    const stream = await openStream("run_resume", { headers: { "last-event-id": "2" } });
    try {
      const frames = await readFrames(stream, 1);
      assert.equal(frames[0]?.id, 3);
      assert.equal(frames[0]?.data?.type === "note" ? frames[0].data.message : null, "三");
    } finally {
      await stream.close();
    }
  });

  test("`?after=` 也能指定游标（命令行 curl 补读历史用）", async () => {
    hub.ensure("run_after").emit(note("一"));
    const stream = await openStream("run_after", { query: "?after=0" });
    try {
      const frames = await readFrames(stream, 1);
      assert.equal(frames[0]?.id, 1);
    } finally {
      await stream.close();
    }
  });

  test("心跳：安静的时候也发注释帧（中间那层代理才不会掉连接）", async () => {
    hub.ensure("run_ping");
    const stream = await openStream("run_ping");
    try {
      const frame = await nextFrame(stream);
      assert.equal(frame?.comment, true, "第一条应该是心跳注释帧");
    } finally {
      await stream.close();
    }
  });

  test("客户端断开：订阅读数归零（反复刷新不会攒死订阅）", async () => {
    hub.ensure("run_leak");
    const stream = await openStream("run_leak");
    await nextFrame(stream); // 先看到心跳，确认订阅真的建好了
    assert.equal(hub.info("run_leak")?.subscribers, 1);
    await stream.close();
    // 断线是异步的：给 socket 一点时间把 close 事件送到。
    for (let index = 0; index < 50 && hub.info("run_leak")?.subscribers !== 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(hub.info("run_leak")?.subscribers, 0);
  });
});

describe("Phase 4 · 会话视图端点（读 `session_entries`，不看内存缓冲）", () => {
  let store: MemorySessionStore;
  let view: WebServer;
  let sessionId = "";
  let runId = "";
  let base2 = "";

  before(async () => {
    store = new MemoryStore();
    sessionId = (
      await store.createSession({ repoKey: "local/x", baseCommit: "a".repeat(40), cwd: "/workspace/repo", title: "会话标题" })
    ).id;
    runId = await store.startRun({ id: "run_view_1", sessionId, startEntryId: null, provider: "scripted", model: "m1" });
    await store.appendEntry(sessionId, runId, entryForMessage({ role: "user", content: "第一句" }));
    await store.appendEntry(
      sessionId,
      runId,
      entryForMessage({ role: "assistant", content: [{ type: "text", text: "第一句的回答" }] }),
    );
    await store.endRun(runId, { status: "stopped", stopReason: "end_turn", endEntryId: null });
    view = await startWebServer({ hub, store, port: 0, log: () => undefined });
    base2 = view.url;
  });

  after(async () => {
    await view.close();
  });

  test("`GET /sessions/{id}/entries`：runs + entries（页面默认渲染的就是它）", async () => {
    const response = await fetch(`${base2}/sessions/${sessionId}/entries`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      sessionId: string;
      runs: Array<{ id: string; startEntryId: string | null; status: string }>;
      entries: Array<{ id: string; seq: number; type: string; payload: { role?: string } }>;
    };
    assert.equal(body.sessionId, sessionId);
    assert.deepEqual(
      body.runs.map((run) => run.id),
      [runId],
    );
    assert.equal(body.runs[0]?.status, "stopped");
    assert.deepEqual(
      body.entries.map((entry) => entry.payload.role),
      ["user", "assistant"],
    );
    assert.ok(body.entries[0]!.seq < body.entries[1]!.seq);
  });

  test("`GET /runs/{id}/transcript`：run 的边界 + 本次执行的 entries", async () => {
    const response = await fetch(`${base2}/runs/${runId}/transcript`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      run: { id: string; model: string; stopReason: string | null };
      entries: Array<{ runId: string }>;
    };
    assert.equal(body.run.id, runId);
    assert.equal(body.run.model, "m1");
    assert.equal(body.run.stopReason, "end_turn");
    assert.deepEqual(
      body.entries.map((entry) => entry.runId),
      [runId, runId],
    );
  });

  test("`?afterSeq=` 只给之后的（增量拉取）", async () => {
    const first = (await (await fetch(`${base2}/sessions/${sessionId}/entries`)).json()) as { entries: Array<{ seq: number }> };
    const after = first.entries[0]!.seq;
    const body = (await (await fetch(`${base2}/sessions/${sessionId}/entries?afterSeq=${after}`)).json()) as {
      entries: Array<{ seq: number }>;
    };
    assert.equal(body.entries.length, 1);
    assert.ok(body.entries[0]!.seq > after);
  });

  test("不存在：会话 / run 都给 404（而不是空列表）", async () => {
    const missingSession = await fetch(`${base2}/sessions/ses_none/entries`);
    assert.equal(missingSession.status, 404);
    assert.equal(((await missingSession.json()) as { error: string }).error, "session_not_found");
    const missingRun = await fetch(`${base2}/runs/run_none/transcript`);
    assert.equal(missingRun.status, 404);
    assert.equal(((await missingRun.json()) as { error: string }).error, "run_not_found");
  });

  test("没接 store 的观察窗：这两条端点回 503（说得清原因），实时流不受影响", async () => {
    const response = await fetch(`${base}/runs/run_frames/transcript`);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "store_unavailable");
    assert.match(body.message, /会话存储/);
    // 实时流照旧：hub 是独立的。
    const info = await fetch(`${base}/runs/run_frames/info`);
    assert.equal(info.status, 200);
  });

  test("配额与非法参数：`limit=-1` 当作没给（不因为一个坏参数回 400）", async () => {
    const response = await fetch(`${base2}/sessions/${sessionId}/entries?limit=-1&afterSeq=abc`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { entries: unknown[] };
    assert.equal(body.entries.length, 2);
  });
});
