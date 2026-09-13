/**
 * Phase 9 · `SandboxApiClient` 新增的流式方法（不需要 Docker）。
 *
 * 用一个真的 `node:http` 假 agent：它按字节收发，所以"流式"这件事是真的被跑到的
 * （而不是 mock 掉 fetch）。这里守四件事：
 *  - `putFile` 的 sha256 对账（灌进去的字节与 tar 不一致时要当场失败）
 *  - `readRaw` / `readArchive` 的状态校验发生在"返回流之前"
 *  - `/diff` 的 snake_case → camelCase 映射（CP 只认自己那一侧的字段名）
 *  - `execAndWait` 的终态解析与输出收集
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { SandboxApiClient, SandboxApiError } from "../../src/client/sandbox-api.ts";

interface FakeState {
  files: Map<string, Buffer>;
  archive: Buffer;
  diffStatus: number;
  diffPayload: Record<string, unknown>;
  /** PUT /files 的响应覆盖（测 sha 对不上）。 */
  putOverride: ((body: Buffer) => { status: number; body: Record<string, unknown> }) | null;
  /** 每次 POST /exec 之后要发的 SSE 帧（按调用顺序取）。 */
  sseScripts: string[][];
  /** execution id 的自增段。 */
  execSeq: number;
  requests: Array<{ method: string; url: string; authorization: string | null }>;
}

const state: FakeState = {
  files: new Map(),
  archive: Buffer.alloc(0),
  diffStatus: 200,
  diffPayload: {},
  putOverride: null,
  sseScripts: [],
  execSeq: 0,
  requests: [],
};

let base = "";
let server: http.Server;

const client = new SandboxApiClient({ reconnectDelayMs: 10, requestTimeoutMs: 5_000 });
const TARGET = { endpoint: "http://placeholder", authToken: "tok_test", sandboxId: "sbx_test" };

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

before(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      state.requests.push({
        method: req.method ?? "GET",
        url: `${url.pathname}${url.search}`,
        authorization: req.headers.authorization ?? null,
      });

      if (req.method === "PUT" && url.pathname === "/files") {
        const body = await readAll(req);
        const requested = url.searchParams.get("path") ?? "";
        state.files.set(requested, body);
        const override = state.putOverride?.(body);
        if (override !== null && override !== undefined) return sendJson(res, override.status, override.body);
        return sendJson(res, 200, {
          path: requested,
          size: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
      }
      if (req.method === "GET" && url.pathname === "/files") {
        const content = state.files.get(url.searchParams.get("path") ?? "");
        if (content === undefined) return sendJson(res, 404, { error: "not_found", message: "no such file" });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": content.length });
        return res.end(content);
      }
      if (req.method === "GET" && url.pathname === "/diff") {
        return sendJson(res, state.diffStatus, state.diffPayload);
      }
      if (req.method === "GET" && url.pathname === "/archive") {
        res.writeHead(200, { "content-type": "application/gzip", "content-length": state.archive.length });
        return res.end(state.archive);
      }
      if (req.method === "POST" && url.pathname === "/exec") {
        const body = JSON.parse((await readAll(req)).toString("utf8")) as Record<string, unknown>;
        const id = `exe_fake_${++state.execSeq}`;
        sendJson(res, 202, { execution_id: id, log_path: `/tmp/reuben-cloud/exec/${id}.log` });
        return;
      }
      const events = /^\/exec\/([^/]+)\/events$/.exec(url.pathname);
      if (req.method === "GET" && events !== null) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const frame of state.sseScripts.shift() ?? []) res.write(frame);
        return res.end();
      }
      sendJson(res, 404, { error: "not_found", message: `${req.method} ${url.pathname}` });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  TARGET.endpoint = base;
});

after(async () => {
  // keep-alive 的连接会让进程不退出：先断连接再关服务器（不关的话测试文件永远不结束）。
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Phase 9 · 客户端流式方法", () => {
  test("putFile：流式往返，sha256 相符，鉴权头正确", async () => {
    const payload = randomBytes(2 * 1024 * 1024);
    const result = await client.putFile(TARGET.endpoint, TARGET.authToken, "/workspace/repo.tar.gz", Readable.from(payload));
    assert.equal(result.size, payload.length);
    assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
    assert.deepEqual(state.files.get("/workspace/repo.tar.gz"), payload, "服务器收到的字节与发出的不一致");

    const request = state.requests.at(-1)!;
    assert.equal(request.method, "PUT");
    assert.equal(request.authorization, `Bearer ${TARGET.authToken}`);
  });

  test("putFile：沙箱报的 sha256 不一致时当场抛（不把半个 tar 交给调用方）", async () => {
    state.putOverride = () => ({ status: 200, body: { path: "/workspace/x", size: 3, sha256: "0".repeat(64) } });
    try {
      await assert.rejects(
        client.putFile(TARGET.endpoint, TARGET.authToken, "/workspace/x", Readable.from(Buffer.from("abc"))),
        (error: unknown) => {
          const apiError = error as SandboxApiError;
          assert.equal(apiError.reason, "invalid_response");
          assert.ok(apiError.message.includes("sha256"), apiError.message);
          return true;
        },
      );
    } finally {
      state.putOverride = null;
    }
  });

  test("readRaw / readArchive：状态不对在返回流之前就抛；成功时字节一致", async () => {
    const content = randomBytes(4096);
    state.files.set("/workspace/big.patch", content);
    const stream = await client.readRaw(TARGET.endpoint, TARGET.authToken, "/workspace/big.patch");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), content);
    assert.equal(state.requests.at(-1)!.url, "/files?path=%2Fworkspace%2Fbig.patch&raw=1");

    state.archive = Buffer.from("fake-tar-gz");
    const archive = await client.readArchive(TARGET.endpoint, TARGET.authToken, { exclude: [".git", "dist"] });
    const archiveChunks: Buffer[] = [];
    for await (const chunk of archive) archiveChunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(archiveChunks), state.archive);
    assert.equal(state.requests.at(-1)!.url, "/archive?exclude=.git%2Cdist");

    await assert.rejects(
      client.readRaw(TARGET.endpoint, TARGET.authToken, "/workspace/missing"),
      (error: unknown) => {
        const apiError = error as SandboxApiError;
        assert.equal(apiError.reason, "http_error");
        assert.equal(apiError.status, 404);
        assert.equal(apiError.agentError, "not_found");
        return true;
      },
    );
  });

  test("diff：字段映射（patch_bytes / old_path / patch_log_path）与缺省值", async () => {
    state.diffStatus = 200;
    state.diffPayload = {
      base: "a".repeat(40),
      head: "b".repeat(40),
      files: [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
        { path: "src/b.ts", old_path: "src/old.ts", status: "renamed", additions: 0, deletions: 0, binary: false },
        { path: "assets/x.bin", status: "modified", additions: 0, deletions: 0, binary: true },
      ],
      patch: "diff --git …",
      patch_bytes: 1234,
      truncated: false,
      patch_log_path: null,
    };
    const diff = await client.diff(TARGET.endpoint, TARGET.authToken, { base: "HEAD~1", path: "/workspace" });
    assert.equal(diff.base, "a".repeat(40));
    assert.equal(diff.patchBytes, 1234);
    assert.equal(diff.truncated, false);
    assert.equal(diff.patchLogPath, null);
    assert.equal(diff.files.length, 3);
    assert.equal(diff.files[1]!.oldPath, "src/old.ts");
    assert.equal(diff.files[2]!.binary, true);
    assert.equal(state.requests.at(-1)!.url, "/diff?base=HEAD%7E1&path=%2Fworkspace");

    // 缺字段时给安全缺省（协议漂了也不该把 undefined 交给上层）。
    state.diffPayload = { base: "c".repeat(40), patch_bytes: 0 };
    const minimal = await client.diff(TARGET.endpoint, TARGET.authToken);
    assert.deepEqual(minimal.files, []);
    assert.equal(minimal.patch, null);
    assert.equal(minimal.head, "c".repeat(40));

    // 缺 base/patch_bytes 的响应是 invalid_response（不是静默的 undefined）。
    state.diffPayload = { patch: "x" };
    await assert.rejects(
      client.diff(TARGET.endpoint, TARGET.authToken),
      (error: unknown) => (error as SandboxApiError).reason === "invalid_response",
    );
  });

  test("execAndWait：收全 stdout/stderr、解出终态、带上 log_path", async () => {
    state.sseScripts.push([
      'id: 1\nevent: started\ndata: {"execution_id":"exe_1","ts":"2026-01-01T00:00:00.000Z"}\n\n',
      'id: 2\nevent: stdout\ndata: {"chunk":"hello "}\n\n',
      'id: 3\nevent: stderr\ndata: {"chunk":"warn\\n"}\n\n',
      'id: 4\nevent: stdout\ndata: {"chunk":"world\\n"}\n\n',
      'id: 5\nevent: completed\ndata: {"exit_code":0,"duration_ms":12,"stdout_bytes":12,"stderr_bytes":5,"truncated":false,"log_path":"/tmp/reuben-cloud/exec/exe_1.log"}\n\n',
    ]);
    const outcome = await client.execAndWait(TARGET.endpoint, TARGET.authToken, {
      cmd: ["tar", "xzf", "/workspace/repo.tar.gz", "-C", "/workspace"],
      timeoutMs: 1_000,
    });
    assert.equal(outcome.state, "completed");
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.stdout, "hello world\n");
    assert.equal(outcome.stderr, "warn\n");
    assert.equal(outcome.durationMs, 12);
    assert.equal(outcome.truncated, false);
    assert.equal(outcome.logPath, "/tmp/reuben-cloud/exec/exe_1.log");

    // 非 0 也是 completed（退出码的语义在调用方），failed 只表示沙箱没能起进程。
    state.sseScripts.push([
      'id: 1\nevent: failed\ndata: {"error":"spawn_failed"}\n\n',
    ]);
    const failed = await client.execAndWait(TARGET.endpoint, TARGET.authToken, { cmd: ["nope"] });
    assert.equal(failed.state, "failed");
    assert.equal(failed.exitCode, null);
  });
});
