/**
 * `DockerClient` 的单测：**不需要真的 Docker**。
 *
 * 做法是起一个真的 unix socket 上的 HTTP server 当假 daemon——比 mock `http.request`
 * 诚实得多：查询串怎么拼、跨 chunk 的行怎么切、错误消息从哪儿取，全都走真实代码路径。
 * 这些细节只有在真的字节流上才会出错，所以值得一个假 daemon。
 *
 * 重点是四件事：
 *  1. **路径与 query 的拼法**（`/v1.44/...` 与 `filters` 这种 JSON 参数的编码）
 *  2. **错误映射**（404 要能被 `isNotFound` 认出来、message 要能取到原文）
 *  3. **ndjson 的跨 chunk 行**（pull 的进度流靠它；这是 SSE 那类坑的同族）
 *  4. **daemon 不在时的错误类型**（必须是 `DockerUnavailableError`，不是 `DockerApiError`）
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";
import {
  DockerApiError,
  DockerClient,
  DockerUnavailableError,
  isDockerError,
  isNotFound,
  resolveDockerSocketPath,
  serializeQuery,
} from "../../src/provider/docker-api.ts";

interface FakeDaemon {
  socketPath: string;
  /** 收到的请求（method + 带 query 的完整路径），按顺序记下来。 */
  requests: string[];
  close: () => Promise<void>;
}

/**
 * 起一个假 daemon。
 *
 * socket 路径用 `/tmp/rc-docker-XXXX/docker.sock` 而不是 `os.tmpdir()`：
 * macOS 的 `os.tmpdir()` 是 `/var/folders/...`，unix socket 路径有 ~104 字节上限，
 * 长路径会以 "ENAMETOOLONG / EADDRINUSE" 这种看起来毫不相干的错误炸掉。
 */
async function startFakeDaemon(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<FakeDaemon> {
  const dir = await mkdtemp("/tmp/rc-docker-");
  const socketPath = path.join(dir, "docker.sock");
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("json()：路径带版本前缀，query 被正确编码", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ Id: "abc", State: "running" }]));
  });
  try {
    const client = new DockerClient({ socketPath: daemon.socketPath });
    const rows = await client.json<Array<{ Id: string }>>("GET", "/containers/json", {
      query: { all: 1, filters: JSON.stringify({ label: ["reuben-cloud.managed=true"] }) },
    });
    assert.equal(rows[0]?.Id, "abc");
    assert.equal(
      daemon.requests[0],
      // labels 里的 `=` 被编码成 %3D —— 这正是要用 URLSearchParams 而不是手拼字符串的原因。
      "GET /v1.44/containers/json?all=1&filters=%7B%22label%22%3A%5B%22reuben-cloud.managed%3Dtrue%22%5D%7D",
    );
  } finally {
    await daemon.close();
  }
});

test("json()：204 空响应体返回 undefined（start/stop 就是 204）", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  try {
    const client = new DockerClient({ socketPath: daemon.socketPath });
    assert.equal(await client.json("POST", "/containers/x/start"), undefined);
  } finally {
    await daemon.close();
  }
});

test("错误：404 能被 isNotFound 认出来，message 取的是 daemon 原文", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "No such container: reuben-cloud-sbx-x" }));
  });
  try {
    const client = new DockerClient({ socketPath: daemon.socketPath });
    await assert.rejects(
      client.json("GET", "/containers/reuben-cloud-sbx-x/json"),
      (error: unknown) => {
        assert.ok(error instanceof DockerApiError);
        assert.equal(error.status, 404);
        assert.equal(error.dockerMessage, "No such container: reuben-cloud-sbx-x");
        assert.equal(isNotFound(error), true);
        assert.equal(isDockerError(error, 409), false);
        return true;
      },
    );
  } finally {
    await daemon.close();
  }
});

test("错误：非 JSON 的错误响应体不会退化成 SyntaxError", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.statusCode = 500;
    res.end("<html>502 Bad Gateway</html>");
  });
  try {
    const client = new DockerClient({ socketPath: daemon.socketPath });
    await assert.rejects(client.json("GET", "/version"), (error: unknown) => {
      assert.ok(error instanceof DockerApiError);
      assert.equal(error.status, 500);
      assert.match(error.dockerMessage, /502 Bad Gateway/);
      return true;
    });
  } finally {
    await daemon.close();
  }
});

test("ndjson()：跨 chunk 的行、最后一行没有换行符、流里的错误会被抛出", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.setHeader("content-type", "application/json");
    // 故意把一条消息切成三块（模拟 TCP 的分包），并且最后一条不带换行符。
    res.write('{"status":"Pulling fs layer","id":"a"}');
    setTimeout(() => {
      res.write('\n{"status":"Downloading","progressDetail":{"cur');
      setTimeout(() => {
        res.write('rent":1,"total":2}}\n{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}');
        res.end();
      }, 5);
    }, 5);
  });
  try {
    const client = new DockerClient({ socketPath: daemon.socketPath });
    const seen: string[] = [];
    await assert.rejects(
      client.ndjson("POST", "/images/create", { query: { fromImage: "repo@sha256:x" } }, (message) => {
        if (message.status !== undefined) seen.push(message.status);
        if (message.error !== undefined) throw new Error(`pull 失败：${message.error}`);
      }),
      /manifest unknown/,
    );
    assert.deepEqual(seen, ["Pulling fs layer", "Downloading"]);
  } finally {
    await daemon.close();
  }
});

test("连不上 daemon：抛 DockerUnavailableError（不是 DockerApiError）", async () => {
  const daemon = await startFakeDaemon((_req, res) => res.end("{}"));
  const { socketPath } = daemon;
  await daemon.close(); // 关掉之后，那个 socket 文件也没了
  const client = new DockerClient({ socketPath });
  await assert.rejects(client.json("GET", "/version"), (error: unknown) => {
    assert.ok(error instanceof DockerUnavailableError, `得到 ${String(error)}`);
    assert.equal(error.socketPath, socketPath);
    assert.match(error.message, /连不上 docker daemon/);
    return true;
  });
});

test("超时：AbortSignal.timeout 的错误能被上层认出来是超时", async () => {
  const daemon = await startFakeDaemon(() => {
    // 永远不响应，等客户端自己超时。
  });
  try {
    const client = new DockerClient({ socketPath: daemon.socketPath });
    await assert.rejects(client.json("GET", "/version", { timeoutMs: 60 }), (error: unknown) => {
      // 超时的名字是 TimeoutError（DOMException）——但 http.request 拿到一个被 abort 的
      // signal 时会把错误包成 AbortError（实测 Node 26 走的是这条）。两者都是超时，
      // provider 靠 isTimeoutError 区分 "daemon 不在" / "daemon 太慢"，所以这里两者都接受。
      assert.match((error as Error).name, /^(TimeoutError|AbortError)$/);
      return true;
    });
  } finally {
    await daemon.close();
  }
});

test("resolveDockerSocketPath：本机 unix socket 放行，远程一律拒绝", () => {
  assert.equal(resolveDockerSocketPath({}), "/var/run/docker.sock");
  assert.equal(resolveDockerSocketPath({ DOCKER_HOST: "" }), "/var/run/docker.sock");
  assert.equal(resolveDockerSocketPath({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" }), "/run/user/1000/docker.sock");

  // 远程 daemon：静默连到别的机器比直接失败危险得多，所以这里必须抛。
  for (const host of ["tcp://10.0.0.5:2375", "http://10.0.0.5:2375", "ssh://user@host", "unix://"]) {
    assert.throws(
      () => resolveDockerSocketPath({ DOCKER_HOST: host }),
      (error: unknown) => error instanceof DockerUnavailableError,
      `${host} 应该被拒绝`,
    );
  }
});

test("serializeQuery：跳过 undefined，不做多余的编码", () => {
  assert.equal(serializeQuery(undefined), "");
  assert.equal(serializeQuery({ a: 1, b: "x", c: undefined, d: true }), "a=1&b=x&d=true");
});
