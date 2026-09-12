/**
 * Phase 6 单元测试之二：代理本体（**不需要 Docker、不需要外网**）。
 *
 * 做法是进程内起一个真的代理 + 一个真的本地 origin / echo 服务，所以这里测的是
 * 真实的 socket 行为（CONNECT 隧道、绝对 URI 转发、403、字节计数），而不是对函数的猜测。
 * 需要容器才能回答的问题（从沙箱里 `curl github.com` 到底通不通、npm/pip 真装包）
 * 在 `test/integration/egress-proxy.integration.test.ts` 里。
 *
 * 本文件里的 "localhost" 是刻意的：白名单只认域名，而 IP 直连一律拒绝（见用例 3），
 * 所以本地的 origin 只能用 `localhost` 这个名字去够——这恰好也证明了那条规则是真的在生效。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEgressProxy } from "../../../../deploy/egress-proxy/src/proxy.ts";
import type { EgressProxy, LogLine } from "../../../../deploy/egress-proxy/src/proxy.ts";

const PROXY_ENTRY = fileURLToPath(new URL("../../../../deploy/egress-proxy/src/proxy.ts", import.meta.url));

/** 一个本地 origin：把请求形状原样回给调用方，便于断言转发是否忠实。 */
async function startOrigin(): Promise<{
  port: number;
  requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      });
      const body = `ORIGIN ${req.method} ${req.url}`;
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  const port = await listen(server);
  return { port, requests, close: () => closeServer(server) };
}

/** 一个 TCP echo：CONNECT 隧道两端的字节原样返回，便于断言 in/out 计数。 */
async function startEcho(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.pipe(socket);
  });
  const port = await listen(server);
  return { port, close: () => closeServer(server) };
}

interface ProxyHarness {
  port: number;
  logs: LogLine[];
  proxy: EgressProxy;
  /** 把新内容写进白名单文件并 reload。 */
  rewrite: (text: string) => void;
  close: () => Promise<void>;
}

/** 起一个进程内代理，白名单文件写在临时目录里（SIGHUP 那条路径在集成测试里测真容器）。 */
async function startProxy(allowlistText: string): Promise<ProxyHarness> {
  const dir = mkdtempSync(join(tmpdir(), "rc-egress-"));
  const allowlistPath = join(dir, "allowlist.txt");
  writeFileSync(allowlistPath, allowlistText);
  const logs: LogLine[] = [];
  const proxy = createEgressProxy({
    allowlistPath,
    port: 0,
    host: "127.0.0.1",
    connectTimeoutMs: 3_000,
    log: (line) => logs.push(line),
  });
  const { port } = await proxy.listen();
  return {
    port,
    logs,
    proxy,
    rewrite: (text) => {
      // **原地覆盖**（writeFileSync 保留 inode）。生产里是 bind mount，rename 换文件
      // 不会反映到容器里——这个陷阱在集成测试里也踩同一份语义。
      writeFileSync(allowlistPath, text);
      proxy.reload();
    },
    close: async () => {
      await proxy.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 走代理发一个绝对 URI 的明文请求。 */
function proxyGet(proxyPort: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: absoluteUrl, headers: { host: new URL(absoluteUrl).host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 走代理建一条 CONNECT 隧道。返回状态码与（200 时的）可读写 socket。 */
function proxyConnect(
  proxyPort: number,
  authority: string,
): Promise<{ status: number; socket: net.Socket | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket: res.statusCode === 200 ? socket : null }));
    req.on("error", reject);
    req.end();
  });
}

/** 往 socket 写一段字节并等回显。 */
function echoOnce(socket: net.Socket, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const received = Buffer.concat(chunks);
      if (received.length >= payload.length) {
        socket.off("data", onData);
        resolve(received);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(payload);
  });
}

test("原文 HTTP 转发：放行的域名能过，转发是忠实的（方法/路径/body）", async () => {
  const origin = await startOrigin();
  const proxy = await startProxy("localhost\n");
  try {
    const get = await proxyGet(proxy.port, `http://localhost:${origin.port}/hello?x=1`);
    assert.equal(get.status, 200);
    assert.equal(get.body, "ORIGIN GET /hello?x=1");

    // POST + body：代理不能吃掉或改掉请求体。
    const post = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "POST",
          path: `http://localhost:${origin.port}/submit`,
          headers: { host: `localhost:${origin.port}`, "content-type": "text/plain" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end("payload-body");
    });
    assert.equal(post.status, 200);
    assert.equal(post.body, "ORIGIN POST /submit");
    assert.equal(origin.requests[1]!.body, "payload-body");

    // 日志字段：域名、决策、字节数、耗时（spec 用例 7）。
    const line = proxy.logs.find((item) => item.kind === "http" && item.decision === "allow");
    assert.equal(line?.host, "localhost");
    assert.equal(line?.rule, "localhost");
    assert.equal(line?.port, origin.port);
    assert.equal(typeof line?.ms, "number");
    assert.ok((line?.out as number) > 0, `日志里要有出方向字节数：${JSON.stringify(line)}`);
  } finally {
    await proxy.close();
    await origin.close();
  }
});

test("非白名单域名：403，且**根本不会去连上游**", async () => {
  const origin = await startOrigin();
  const proxy = await startProxy("localhost\n");
  try {
    const response = await proxyGet(proxy.port, `http://example.com:${origin.port}/secret`);
    assert.equal(response.status, 403);
    assert.match(response.body, /example\.com/);
    assert.equal(origin.requests.length, 0, "被拒的请求不该碰到上游");

    const line = proxy.logs.find((item) => item.decision === "deny");
    assert.equal(line?.host, "example.com");
    assert.equal(line?.reason, "not_allowlisted");
  } finally {
    await proxy.close();
    await origin.close();
  }
});

test("CONNECT 隧道：放行的域名能建隧道，两个方向字节原样到达", async () => {
  const echo = await startEcho();
  const proxy = await startProxy("localhost\n");
  try {
    const tunnel = await proxyConnect(proxy.port, `localhost:${echo.port}`);
    assert.equal(tunnel.status, 200);
    assert.notEqual(tunnel.socket, null);
    try {
      const payload = Buffer.from("ping-隧道-bytes");
      const received = await echoOnce(tunnel.socket!, payload);
      assert.deepEqual(received, payload);
    } finally {
      tunnel.socket!.destroy();
    }

    // 字节计数：in = 客户端→上游，out = 上游→客户端。echo 让两边相等。
    await waitFor(() => proxy.logs.some((item) => item.kind === "connect" && item.decision === "allow"));
    const line = proxy.logs.find((item) => item.kind === "connect" && item.decision === "allow")!;
    assert.equal(line.host, "localhost");
    assert.equal(line.port, echo.port);
    assert.equal(line.in, Buffer.byteLength("ping-隧道-bytes"));
    assert.equal(line.out, Buffer.byteLength("ping-隧道-bytes"));
    assert.equal(typeof line.ms, "number");
  } finally {
    await proxy.close();
    await echo.close();
  }
});

test("CONNECT 到 IP：403（IP 直连一律拒绝，哪怕端口上真有人）", async () => {
  const echo = await startEcho();
  // 白名单里连 `*` 都没有，更不会有 IP——但这不依赖名单内容，是独立的一条规则。
  const proxy = await startProxy("localhost\n");
  try {
    const tunnel = await proxyConnect(proxy.port, `127.0.0.1:${echo.port}`);
    assert.equal(tunnel.status, 403);
    const line = proxy.logs.find((item) => item.kind === "connect" && item.decision === "deny")!;
    assert.equal(line.reason, "ip_literal");
  } finally {
    await proxy.close();
    await echo.close();
  }
});

test("CONNECT 到非白名单域名：403", async () => {
  const proxy = await startProxy("localhost\n");
  try {
    const tunnel = await proxyConnect(proxy.port, "github.com:443");
    assert.equal(tunnel.status, 403, "§F.2 红线：沙箱到 github.com 必须失败");
    const line = proxy.logs.find((item) => item.kind === "connect" && item.decision === "deny")!;
    assert.equal(line.host, "github.com");
    assert.equal(line.reason, "not_allowlisted");
  } finally {
    await proxy.close();
  }
});

test("归一化绕过：大写 + 尾点仍然是同一个域名", async () => {
  const echo = await startEcho();
  const proxy = await startProxy("localhost\n");
  try {
    const tunnel = await proxyConnect(proxy.port, `LOCALHOST.:${echo.port}`);
    assert.equal(tunnel.status, 200, "不归一化的话这里会 403（等于开了一个加个点就能绕过的后门）");
    tunnel.socket?.destroy();

    // 明文方向同样要归一化。
    const origin = await startOrigin();
    try {
      const response = await proxyGet(proxy.port, `http://LOCALHOST.:${origin.port}/x`);
      assert.equal(response.status, 200);
    } finally {
      await origin.close();
    }
  } finally {
    await proxy.close();
    await echo.close();
  }
});

test("SIGHUP 重载语义（进程内）：换清单双向生效，坏清单保留旧名单", async () => {
  const echo = await startEcho();
  const proxy = await startProxy("localhost\n");
  try {
    assert.equal((await proxyConnect(proxy.port, `localhost:${echo.port}`)).status, 200);

    // 收窄到"什么都不过"。
    proxy.rewrite("# 空清单\n");
    assert.equal((await proxyConnect(proxy.port, `localhost:${echo.port}`)).status, 403);

    // 坏清单（裸 `*`）不能把旧名单顶掉：reload 抛错，localhost 仍然被拒。
    assert.throws(() => proxy.rewrite("*\n"), /裸 `\*`/);
    assert.equal((await proxyConnect(proxy.port, `localhost:${echo.port}`)).status, 403);

    // 写回正确内容 → 重新放行。
    proxy.rewrite("localhost\n");
    assert.equal((await proxyConnect(proxy.port, `localhost:${echo.port}`)).status, 200);
  } finally {
    await proxy.close();
    await echo.close();
  }
});

test("重载不影响已建立的隧道（旧连接不受影响）", async () => {
  const echo = await startEcho();
  const proxy = await startProxy("localhost\n");
  try {
    const tunnel = await proxyConnect(proxy.port, `localhost:${echo.port}`);
    assert.equal(tunnel.status, 200);
    const socket = tunnel.socket!;
    assert.deepEqual(await echoOnce(socket, Buffer.from("before")), Buffer.from("before"));

    // 把 localhost 从名单里拿掉并重载：已经在跑的隧道不该被掐断。
    proxy.rewrite("# 空清单\n");
    assert.deepEqual(await echoOnce(socket, Buffer.from("after")), Buffer.from("after"));

    // 新的连接则按新名单拒绝。
    assert.equal((await proxyConnect(proxy.port, `localhost:${echo.port}`)).status, 403);
    socket.destroy();
  } finally {
    await proxy.close();
    await echo.close();
  }
});

test("/healthz 与 origin-form 的边界", async () => {
  const proxy = await startProxy("localhost\n");
  try {
    const health = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.port, method: "GET", path: "/healthz" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(health.status, 200);
    const payload = JSON.parse(health.body) as { status: string; rules: number };
    assert.equal(payload.status, "ready");
    assert.equal(payload.rules, 1);

    // origin-form 的非健康检查路径：说人话的 400，而不是把它当成"域名是空"的代理请求。
    const wrong = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.port, method: "GET", path: "/some/path" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(wrong, 400);
  } finally {
    await proxy.close();
  }
});

test("上游连不上：502，日志里带 error，而不是静默挂住", async () => {
  // 先拿一个空闲端口，然后立刻放掉——连上去必然被拒。
  const { port: deadPort } = await new Promise<{ port: number }>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve({ port: address.port }));
    });
  });
  const proxy = await startProxy("localhost\n");
  try {
    const response = await proxyGet(proxy.port, `http://localhost:${deadPort}/x`);
    assert.equal(response.status, 502);
    const line = proxy.logs.find((item) => item.kind === "http" && item.decision === "allow")!;
    assert.equal(typeof line.error, "string");
  } finally {
    await proxy.close();
  }
});

test("客户端 RST 不能把代理带走（守护进程不能因为一个客户端退出）", async () => {
  const proxy = await startProxy("localhost\n");
  try {
    // 场景一：CONNECT 到上游不可达的端口，客户端不等响应就直接 RST。
    // 这正是手工验证时踩到的崩溃形状（npm 放弃一次 502 后 RST，代理进程直接退出）。
    for (let index = 0; index < 5; index += 1) {
      const socket = net.connect(proxy.port, "127.0.0.1");
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(`CONNECT localhost:1 HTTP/1.1\r\nHost: localhost:1\r\n\r\n`);
      socket.destroy();
    }
    // 场景二：建起隧道后粗鲁地 RST（让代理手里的 socket 还堆着未写出的数据）。
    const echo = await startEcho();
    try {
      const tunnel = await proxyConnect(proxy.port, `localhost:${echo.port}`);
      tunnel.socket?.end(Buffer.from("x".repeat(64 * 1024)));
      tunnel.socket?.destroy();
    } finally {
      await echo.close();
    }

    // 断言代理还活着：/healthz 必须正常答话。
    const health = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.port, method: "GET", path: "/healthz" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(health, 200);
  } finally {
    await proxy.close();
  }
});

test("入口：裸 `*` 的白名单 → 进程非 0 退出，且说清楚原因", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-egress-"));
  try {
    const allowlistPath = join(dir, "allowlist.txt");
    writeFileSync(allowlistPath, "*\n");
    const result = await runEntry(allowlistPath);
    assert.equal(result.code, 1, `应该拒绝启动：${result.stderr}`);
    assert.match(result.stderr, /裸 `\*`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("入口：缺白名单文件 → 拒绝启动（而不是当成空名单跑起来）", async () => {
  const result = await runEntry("/definitely/not/a/allowlist.txt");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /failed to start/);
});

test("入口：正常启动 + SIGTERM 优雅退出（exit 0）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-egress-"));
  const child = spawn(process.execPath, [PROXY_ENTRY], {
    env: {
      ...process.env,
      EGRESS_PROXY_ALLOWLIST: join(dir, "allowlist.txt"),
      EGRESS_PROXY_PORT: "0",
      EGRESS_PROXY_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(join(dir, "allowlist.txt"), "localhost\n");
  try {
    const listening = await waitForOutput(child, "[egress-proxy] v");
    assert.match(listening, /listening on 127\.0\.0\.1:\d+/);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, "SIGTERM 应该走 close() 然后 exit(0)");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 测试脚手架

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // 还有 keep-alive / 隧道 socket 挂着时不无限等：测试只关心资源被释放。
    setTimeout(resolve, 500).unref();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("条件在超时前没有成立");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 跑一次入口脚本（子进程），收集输出。 */
function runEntry(allowlistPath: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROXY_ENTRY], {
      env: {
        ...process.env,
        EGRESS_PROXY_ALLOWLIST: allowlistPath,
        EGRESS_PROXY_PORT: "0",
        EGRESS_PROXY_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

/** 等一行 stdout（入口启动日志）出现。 */
function waitForOutput(child: ReturnType<typeof spawn>, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`没等到输出 ${needle}`)), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        clearTimeout(timer);
        resolve(buffer);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出（${code}）`));
    });
  });
}
