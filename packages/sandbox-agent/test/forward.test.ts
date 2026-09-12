/**
 * `src/forward.ts`（macOS 的端口转发中继）的单测。
 *
 * 【为什么它值得被认真测】这个文件是"沙箱唯一没挂在 `--internal` 网络上的东西"那条
 * 通道的实现。它跑在一个双网卡容器里（内网 + 默认 bridge），所以任何"它能转发到别处"
 * 的 bug 都是一条现成的出网通道。测试要钉住三件事：
 *  1. 字节真的双向通了（不是"看着像通了"）
 *  2. 同时多条连接互不干扰（HTTP keep-alive 下 CP 会复用连接）
 *  3. 目标连不上时进程不倒（容器重启一次就丢掉了端口映射，代价很大）
 *
 * 另外 CLI 那一组测的是 provider 拼出来的命令行——参数解析错了，
 * 表现是"容器起来了但什么都没转发"，那是集成测试里最难定位的一类失败。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, startForwarder } from "../src/forward.ts";
import { runCommand, waitFor } from "./harness.ts";

const forwardPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/forward.ts");

/** 起一个回显 TCP 服务当转发目标：收到什么原样吐回去，并记下来。 */
function startEchoTarget(): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      seen.push(chunk.toString("utf8"));
      socket.write(chunk);
    });
    socket.setNoDelay(true);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        seen,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** 往一个端口发一段字节并等回音。 */
function echoOnce(port: number, payload: string, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let received = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`5s 内没收到回音，payload=${JSON.stringify(payload)}`));
    });
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.length >= payload.length) {
        socket.end();
        resolve(received);
      }
    });
    // 中继在上游连不上时会**直接 destroy 客户端 socket**（TCP 中继没有"半个连接还有救"
    // 的语义），这时客户端只会收到 'close'，没有 'error'。只监听 'error' 会让这个
    // Promise 永远不 settle —— 这个坑在本文件的第一版就踩到了（用例挂到 20s 超时）。
    socket.on("close", () => {
      reject(new Error(`连接被关闭：payload=${JSON.stringify(payload)}，已收到 ${JSON.stringify(received)}`));
    });
    socket.on("error", reject);
  });
}

test("parseArgs：正常参数、缺参数、非法端口", () => {
  const ok = parseArgs(["--listen", "8080", "--target", "reuben-cloud-sbx-x:8080"]);
  assert.deepEqual(ok, {
    ok: true,
    value: { listenPort: 8080, listenHost: undefined, targetHost: "reuben-cloud-sbx-x", targetPort: 8080 },
  });

  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(["--listen", "8080"]).ok, false);
  assert.equal(parseArgs(["--target", "h:1"]).ok, false);
  assert.equal(parseArgs(["--listen", "70000", "--target", "h:1"]).ok, false);
  assert.equal(parseArgs(["--listen", "0", "--target", "h:0"]).ok, false);
  assert.equal(parseArgs(["--listen", "0", "--target", "no-port"]).ok, false);
  assert.equal(parseArgs(["--listen", "0", "--target", "h:1", "stray"]).ok, false);
  assert.equal(parseArgs(["--listen", "0", "--target", "h:1", "--listen"]).ok, false);
});

test("转发：字节双向通过，多个连接互不干扰", async () => {
  const target = await startEchoTarget();
  const forwarder = await startForwarder({
    listenPort: 0,
    listenHost: "127.0.0.1",
    targetHost: "127.0.0.1",
    targetPort: target.port,
    log: () => {},
  });
  try {
    // 串行两条：验证"连接能复用端口"，而不是只对第一条生效。
    assert.equal(await echoOnce(forwarder.port, "第一个"), "第一个");
    assert.equal(await echoOnce(forwarder.port, "第二个"), "第二个");

    // 并行三条：中继必须是"每连接一对 socket"，共用一个 socket 在这里就会串味。
    const results = await Promise.all([
      echoOnce(forwarder.port, "AAA"),
      echoOnce(forwarder.port, "BBBB"),
      echoOnce(forwarder.port, "CC"),
    ]);
    assert.deepEqual(results, ["AAA", "BBBB", "CC"]);
    assert.deepEqual(target.seen, ["第一个", "第二个", "AAA", "BBBB", "CC"]);
  } finally {
    await forwarder.close();
    await target.close();
  }
});

test("目标连不上：连接被关掉，转发器继续服务下一条连接", async () => {
  // 先占一个端口再立刻关掉：拿到一个几乎肯定没人监听的端口号。
  const probe = await startEchoTarget();
  const deadPort = probe.port;
  await probe.close();

  const target = await startEchoTarget();
  const forwarder = await startForwarder({
    listenPort: 0,
    listenHost: "127.0.0.1",
    // target 写死成"连不上的地址"（这正是这个用例要测的）。
    targetHost: "127.0.0.1",
    targetPort: deadPort,
    log: () => {},
  });
  try {
    await assert.rejects(echoOnce(forwarder.port, "x"), (error: Error) =>
      // 具体抛哪一种取决于时机：ECONNREFUSED 是直接拿到的，"连接被关闭" 是中继先
      // 把上游的失败处理掉、再掐掉客户端这一侧。两种都算通过。
      /ECONNREFUSED|连接被关闭|回音/.test(error.message),
    );
    // 关键断言：服务还在听。上游出错只掐那一对 socket，不掐 server。
    assert.equal(forwarder.connections(), 0);
    const stillListening = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: forwarder.port });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    assert.equal(stillListening, true);
  } finally {
    await forwarder.close();
    await target.close();
  }
});

test("close()：端口释放、在转的连接被掐掉", async () => {
  const target = await startEchoTarget();
  const forwarder = await startForwarder({
    listenPort: 0,
    listenHost: "127.0.0.1",
    targetHost: "127.0.0.1",
    targetPort: target.port,
    log: () => {},
  });
  try {
    const idle = net.connect({ host: "127.0.0.1", port: forwarder.port });
    await new Promise<void>((resolve) => idle.on("connect", () => resolve()));
    // 客户端的 'connect' 是内核握手完成的时刻，转发器那个 JS 回调可能还没跑
    // （连接的 accept 在 backlog 里，回调排在事件循环下一轮）。所以不能立刻断言。
    await waitFor(() => forwarder.connections() === 1, {
      message: "转发器没有登记这条连接",
    });

    const closed = new Promise<void>((resolve) => idle.on("close", () => resolve()));
    await forwarder.close();
    await closed;
    assert.equal(forwarder.connections(), 0);

    // 端口应该已经不可连了。
    await assert.rejects(echoOnce(forwarder.port, "after close"), (error: Error) =>
      /ECONNREFUSED|连接被关闭|回音/.test(error.message),
    );
  } finally {
    // finally 是必须的：断言失败时如果不关，这个 server 会吊住整个测试进程
    // （表现是"全部用例都过了但进程不退出"）。
    await target.close();
  }
});

test("CLI：把 provider 拼的那条命令行真跑一遍（含 SIGTERM 退出）", async () => {
  const target = await startEchoTarget();
  const child = spawn(process.execPath, [forwardPath, "--listen", "0", "--target", `127.0.0.1:${target.port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 从 stdout 里读出实际端口。这行日志同时是"容器日志能看到什么"的样本。
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`5s 内没等到监听日志：${buffered}`)), 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = /\[forward\] listening on [\d.]+:(\d+) -> /.exec(buffered);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出（exit ${code}）：${buffered}`));
    });
  });

  try {
    assert.equal(await echoOnce(port, "through cli"), "through cli");
  } finally {
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    await target.close();
  }
});

test("CLI：参数不对时打用法并以非 0 退出", async () => {
  const result = await runCommand([process.execPath, forwardPath, "--listen", "8080"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /缺少 --target/);
  assert.match(result.stderr, /用法：node src\/forward\.ts/);
});
