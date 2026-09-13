/**
 * Phase 8 用例 11：SSE 解析器与重连（**不需要 Docker、不需要 Postgres**）。
 *
 * 【为什么解析器必须被单测】§B 的风险登记表把"SSE 重连语义"列为最难查的一类：
 * `Last-Event-ID`、心跳、跨 chunk 帧三个都能独立出错，而错了的表现是"偶尔丢输出"。
 * 所以这里做的事是**逐字节喂**：把一帧切成三种切法，断言结果一样。
 *
 * 【重连那部分也是真的】本地起一个 http server（不是 mock fetch）：第一条连接发一半
 * 就关掉，断言第二条连接**确实带上了 `Last-Event-ID`**。mock 掉 fetch 就只能测"我以为
 * 我会带头"，测不出"头真的发出去了"。
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { after, describe, test } from "node:test";
import { SseError, SseParser, readSseStream } from "../../src/client/sse.ts";
import type { SseEvent } from "../../src/client/sse.ts";
import { delay } from "../support.ts";

// ---------------------------------------------------------------- 帧解析

/** 把一段文本切成 size 字节的块喂给解析器，返回解析出来的全部事件。 */
function feed(text: string, size: number): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (let i = 0; i < text.length; i += size) {
    const chunk = text.slice(i, i + size);
    events.push(...parser.push(chunk));
  }
  return events;
}

describe("SseParser", () => {
  test("跨 chunk 的帧：任意切法都解析出同样的事件", () => {
    const stream = "id: 1\nevent: stdout\ndata: {\"chunk\":\"hello\"}\n\nid: 2\nevent: completed\ndata: {}\n\n";
    const expected: SseEvent[] = [
      { id: "1", event: "stdout", data: '{"chunk":"hello"}' },
      { id: "2", event: "completed", data: "{}" },
    ];
    for (const size of [1, 3, 7, 64, 4096]) {
      assert.deepEqual(feed(stream, size), expected, `按 ${size} 字符切分时结果不一致`);
    }
  });

  test("心跳注释行被丢掉，不影响后面的帧", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push(": ping\n\n"), []);
    assert.deepEqual(parser.push(": ping\n\n: ping\n\n"), []);
    assert.deepEqual(parser.push(': ping\n\nevent: stdout\ndata: x\n\n'), [{ id: null, event: "stdout", data: "x" }]);
  });

  test("多行 data 用 \\n 连接", () => {
    const parser = new SseParser();
    const events = parser.push("event: stderr\ndata: 第一行\ndata: 第二行\n\n");
    assert.deepEqual(events, [{ id: null, event: "stderr", data: "第一行\n第二行" }]);
  });

  test("CRLF 与孤立的 CR 都算行尾，且可能跨 chunk", () => {
    // `\r` 在第一个 chunk 的末尾、`\n` 在第二个 chunk 的开头——这是最容易漏掉的一种切法。
    const parser = new SseParser();
    assert.deepEqual(parser.push('id: 7\r\nevent: stdout\r\ndata: a\r'), []);
    assert.deepEqual(parser.push("\n\r\n"), [{ id: "7", event: "stdout", data: "a" }]);
    // 只用 CR 的版本
    const cr = new SseParser();
    assert.deepEqual(cr.push("event: stdout\rdata: b\r\r"), [{ id: null, event: "stdout", data: "b" }]);
  });

  test("没有 data 的帧不派发（只有 event 名 / 只有 id）", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push("event: stdout\n\n"), []);
    assert.deepEqual(parser.push("id: 9\n\n"), []);
  });

  test("事件名默认是 message，data 里冒号后的一个空格被吃掉", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push("data: x\ndata: :y\n\n"), [{ id: null, event: "message", data: "x\n:y" }]);
    // 规范只吃掉一个前导空格：两个空格时第一个是内容。
    assert.deepEqual(parser.push("data:  x\n\n"), [{ id: null, event: "message", data: " x" }]);
  });

  test("半截帧留在缓冲里，不会被当成事件吐出来", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push("event: stdout\ndata: {"), []);
    assert.deepEqual(parser.push('"chunk":"abc"}'), []);
    assert.deepEqual(parser.push("\n\n"), [{ id: null, event: "stdout", data: '{"chunk":"abc"}' }]);
  });

  test("reset() 丢掉半截帧（重连时用）", () => {
    const parser = new SseParser();
    parser.push("event: stdout\ndata: half");
    parser.reset();
    assert.deepEqual(parser.push("event: stdout\ndata: whole\n\n"), [
      { id: null, event: "stdout", data: "whole" },
    ]);
  });
});

// ---------------------------------------------------------------- 重连（真 HTTP）

interface FakeSseServer {
  url: string;
  /** 每次连接带上的 `Last-Event-ID` 头（没有就是 null）。 */
  lastEventIds: Array<string | null>;
  close(): Promise<void>;
}

/** 起一个本地 SSE 服务。`onConnection` 拿到连接号，自己往 res 上写。 */
async function startSseServer(
  onConnection: (res: ServerResponse, index: number) => void,
): Promise<FakeSseServer> {
  const lastEventIds: Array<string | null> = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const header = req.headers["last-event-id"];
    const index = lastEventIds.length;
    lastEventIds.push(typeof header === "string" ? header : null);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    onConnection(res, index);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/exec/exe_1/events`,
    lastEventIds,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const servers: FakeSseServer[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("readSseStream", () => {
  test("流断了会重连，并显式带上 Last-Event-ID", async () => {
    const server = await startSseServer((res, index) => {
      if (index === 0) {
        // 第一条连接：两个事件之后**自己关掉**（模拟被代理掐掉）。
        res.write('id: 1\nevent: stdout\ndata: {"chunk":"a"}\n\n');
        res.write('id: 2\nevent: stdout\ndata: {"chunk":"b"}\n\n');
        res.end();
        return;
      }
      // 第二条连接：补发剩下的，然后给终态。
      res.write(": ping\n\n"); // 心跳混在中间
      res.write('id: 3\nevent: stdout\ndata: {"chunk":"c"}\n\n');
      res.write("id: 4\nevent: completed\ndata: {}\n\n");
    });
    servers.push(server);

    const received: SseEvent[] = [];
    for await (const event of readSseStream({
      url: server.url,
      headers: { authorization: "Bearer t" },
      reconnectDelayMs: 10,
    })) {
      received.push(event);
      if (event.event === "completed") break; // 消费者主动收尾
    }

    assert.deepEqual(
      received.map((event) => event.id),
      ["1", "2", "3", "4"],
    );
    // 两条连接：第二条必须带游标（否则沙箱侧会从头重放，输出就重复了）。
    assert.deepEqual(server.lastEventIds, [null, "2"]);
  });

  test("首连也可以自带游标（CP 重启后的续读）", async () => {
    const server = await startSseServer((res) => {
      res.write("id: 9\nevent: killed\ndata: {}\n\n");
    });
    servers.push(server);

    const received: SseEvent[] = [];
    for await (const event of readSseStream({ url: server.url, lastEventId: "8", reconnectDelayMs: 10 })) {
      received.push(event);
      if (event.event === "killed") break;
    }
    assert.deepEqual(received.map((event) => event.id), ["9"]);
    assert.deepEqual(server.lastEventIds, ["8"]);
  });

  test("重连次数用尽 → reconnect_exhausted（默认 3 次 = 一共 4 条连接）", async () => {
    let connections = 0;
    const server = await startSseServer((res) => {
      connections += 1;
      res.end(); // 每次都立刻结束，一个事件都不给
    });
    servers.push(server);

    await assert.rejects(
      (async () => {
        for await (const _event of readSseStream({ url: server.url, reconnectDelayMs: 5 })) {
          // 不会走到这里
        }
      })(),
      (error: unknown) => {
        assert.ok(error instanceof SseError);
        assert.equal(error.reason, "reconnect_exhausted");
        return true;
      },
    );
    assert.equal(connections, 4, "首次 + 3 次重连");
  });

  test("AbortSignal 取消时抛 aborted，不重连", async () => {
    let connections = 0;
    const server = await startSseServer(() => {
      connections += 1; // 连接挂着，什么都不写
    });
    servers.push(server);

    const controller = new AbortController();
    const reading = (async () => {
      for await (const _event of readSseStream({
        url: server.url,
        signal: controller.signal,
        reconnectDelayMs: 5,
      })) {
        // 不会走到这里
      }
    })();
    await delay(50);
    controller.abort();
    await assert.rejects(reading, (error: unknown) => {
      assert.ok(error instanceof SseError);
      assert.equal(error.reason, "aborted");
      return true;
    });
    assert.equal(connections, 1);
  });
});
