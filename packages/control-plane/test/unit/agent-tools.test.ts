/**
 * Phase 11 · 四个工具（不需要 Docker、不需要模型）。
 *
 * 用一个真的 `node:http` 假 agent：它按字节收发、按沙箱的语义判断错（越界 / 不存在 /
 * 目录 / 非 UTF-8 / 413），所以"分片读大文件""bash 从日志尾部续读"这些路径是真的被
 * 跑到的，而不是 mock 掉 fetch 之后自说自话。
 *
 * 这里对应 spec「测试要点」的 3、4、5、12、13、14、15、16：
 *  - read 的四条收尾形态各一条用例
 *  - bash 的 tail 截断 + `Full output:` 续读
 *  - 参数校验失败是 is_error 而不是异常
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { noopLog } from "../../src/log.ts";
import { bashTool, runBash } from "../../src/agent/tools/bash.ts";
import { createToolkit } from "../../src/agent/tools/index.ts";
import { listTool, runList } from "../../src/agent/tools/list.ts";
import { readTool, runRead } from "../../src/agent/tools/read.ts";
import { writeTool, runWrite } from "../../src/agent/tools/write.ts";
import type { ExecPort, ToolContext, ToolExecResult } from "../../src/agent/tools/types.ts";
import { createReadAnchors } from "../../src/agent/tools/types.ts";

// ---------------------------------------------------------------- 假 agent

/** 允许读的根（与沙箱缺省一致：workspace + /tmp/reuben-cloud）。 */
const READ_ROOTS = ["/workspace", "/tmp/reuben-cloud"];
/** 允许写的根（写单根）。 */
const WRITE_ROOT = "/workspace";

interface RecordedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
}

interface FakeState {
  files: Map<string, Buffer>;
  requests: RecordedRequest[];
}

const state: FakeState = { files: new Map(), requests: [] };
let base = "";
let server: http.Server;

const api = new SandboxApiClient({ requestTimeoutMs: 5_000 });
const TARGET = { endpoint: "http://placeholder", authToken: "tok_test", sandboxId: "sbx_test" };

function isUnder(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function error(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { error: code, message, ...extra });
}

/** 严格 UTF-8 解码（沙箱的 `decodeUtf8` 就是严格的：非法字节 → 400 `invalid_utf8`）。 */
function strictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
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
      state.requests.push({ method: req.method ?? "GET", pathname: url.pathname, query: url.searchParams });

      if (req.method === "PUT" && url.pathname === "/files") {
        const target = url.searchParams.get("path") ?? "";
        if (!isUnder(target, WRITE_ROOT)) {
          return error(res, 400, "path_out_of_bounds", `${target} 不在写根之下`);
        }
        const body = await readAll(req);
        state.files.set(target, body);
        return sendJson(res, 200, {
          path: target,
          size: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
      }

      if (req.method === "GET" && url.pathname === "/files") {
        return readFileRoute(url, res);
      }
      if (req.method === "GET" && url.pathname === "/files/list") {
        return listRoute(url, res);
      }
      return error(res, 404, "not_found", `${req.method} ${url.pathname}`);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  TARGET.endpoint = base;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function readFileRoute(url: URL, res: ServerResponse): void {
  const target = url.searchParams.get("path") ?? "";
  if (!READ_ROOTS.some((root) => isUnder(target, root))) {
    return error(res, 400, "path_out_of_bounds", `${target} 不在读根之下`);
  }
  const content = state.files.get(target);
  if (content === undefined) {
    // 目录：内容里有一个以它开头的键，且没有同名文件。
    const isDir = [...state.files.keys()].some((key) => key.startsWith(`${target}/`));
    if (isDir) return error(res, 400, "is_directory", "是一个目录");
    return error(res, 404, "not_found", `没有这个文件：${target}`);
  }

  const offset = Number(url.searchParams.get("offset") ?? "0");
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? null : Number(rawLimit);
  const available = Math.max(0, content.length - offset);

  if (url.searchParams.get("raw") === "1") {
    const slice = content.subarray(offset, limit === null ? undefined : offset + limit);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": slice.length });
    res.end(slice);
    return;
  }

  // 与沙箱同一套语义：没传 limit 且剩余部分超过内联上限 → 413（附上 size）。
  if (limit === null && available > 1024 * 1024) {
    return error(res, 413, "too_large", "文件太大", { limit: 1024 * 1024, size: content.length });
  }
  const bytesToRead = limit === null ? Math.min(available, 1024 * 1024) : Math.min(limit, available);
  const slice = content.subarray(offset, offset + bytesToRead);
  const encoding = url.searchParams.get("encoding") ?? "utf8";
  if (encoding === "base64") {
    return sendJson(res, 200, {
      path: target,
      size: content.length,
      sha256: createHash("sha256").update(slice).digest("hex"),
      encoding,
      offset,
      bytes: slice.length,
      content: slice.toString("base64"),
    });
  }
  const text = strictUtf8(slice);
  if (text === null) return error(res, 400, "invalid_utf8", "不是合法 UTF-8");
  return sendJson(res, 200, {
    path: target,
    size: content.length,
    sha256: createHash("sha256").update(slice).digest("hex"),
    encoding: "utf8",
    offset,
    bytes: slice.length,
    content: text,
  });
}

function listRoute(url: URL, res: ServerResponse): void {
  const target = (url.searchParams.get("path") ?? "/workspace").replace(/\/$/, "") || "/";
  if (!READ_ROOTS.some((root) => isUnder(target, root))) {
    return error(res, 400, "path_out_of_bounds", `${target} 不在读根之下`);
  }
  const depth = Number(url.searchParams.get("depth") ?? "1");
  const prefix = target === "/" ? "/" : `${target}/`;
  const entries: Array<{ name: string; type: string; size: number; mtime: number }> = [];

  for (const [key, value] of [...state.files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest === "") continue;
    const parts = rest.split("/");
    if (parts.length > depth) {
      // 更深的东西只体现在目录条目里。
      const dirName = parts.slice(0, depth).join("/");
      if (!entries.some((entry) => entry.name === dirName)) {
        entries.push({ name: dirName, type: "dir", size: 0, mtime: 1_700_000_000_000 });
      }
      continue;
    }
    entries.push({ name: rest, type: "file", size: value.length, mtime: 1_700_000_000_000 });
  }
  if (entries.length === 0 && ![...state.files.keys()].some((key) => key.startsWith(prefix) || isUnder(prefix, key))) {
    return error(res, 404, "not_found", "没有这个目录");
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sendJson(res, 200, { path: target, entries, truncated: false });
}

// ---------------------------------------------------------------- 脚手架

/** 事件流帧（`failed` 的说明走 stdout/stderr）。 */
function sse(event: string, data: Record<string, unknown>, id = 1): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface FakeExecOptions {
  result: Partial<ToolExecResult>;
  events?: Array<{ event: string; data: string }>;
}

function fakeExec(options: FakeExecOptions): ExecPort & { calls: Array<{ cmd: string[]; cwd?: string; timeoutMs?: number }> } {
  const calls: Array<{ cmd: string[]; cwd?: string; timeoutMs?: number }> = [];
  return {
    calls,
    async execInSandbox(_sandboxId, request) {
      calls.push({ cmd: request.cmd, ...(request.cwd === undefined ? {} : { cwd: request.cwd }), ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) });
      return {
        executionId: "exe_test",
        state: "completed",
        exitCode: 0,
        signal: null,
        durationMs: 12,
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        logPath: null,
        events: (options.events ?? []).map((event) => ({ id: "1", event: event.event, data: event.data })),
        ...options.result,
      };
    },
  };
}

function makeContext(exec: ExecPort, anchors = createReadAnchors()): ToolContext {
  return {
    sandboxId: "sbx_test",
    exec,
    api,
    target: TARGET,
    repoDir: "/workspace/repo",
    anchors,
    log: noopLog,
  };
}

/** 造 n 行文本，每行 `line-<6 位序号>-<填充>`。 */
function numberedLines(count: number, width = 0): string {
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const base = `line-${String(index).padStart(6, "0")}`;
    lines.push(width > base.length ? base.padEnd(width, ".") : base);
  }
  return `${lines.join("\n")}\n`;
}

const READ_ONLY_EXEC = fakeExec({ result: { logPath: null } });

before(() => {
  state.files.set("/workspace/repo/src/small.ts", Buffer.from("export const a = 1;\nexport const b = 2;\n"));
  state.files.set("/workspace/repo/src/binary.bin", Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x0a]));
});

// ---------------------------------------------------------------- 用例

describe("Phase 11 · read 的四种收尾形态", () => {
  test("形态 1：行数先到（5000 行 → 恰好 2000 行 + offset=2001）", async () => {
    state.files.set("/workspace/repo/big.txt", Buffer.from(numberedLines(5000)));
    const result = await runRead({ path: "big.txt" }, makeContext(READ_ONLY_EXEC));
    assert.equal(result.isError, false);
    const body = result.content;
    const shown = body.slice(0, body.indexOf("\n\n["));
    assert.equal(shown.split("\n").length, 2000);
    assert.equal(shown.startsWith("line-000001"), true);
    assert.equal(shown.endsWith("line-002000"), true);
    assert.equal(body.endsWith("[Showing lines 1-2000. Use offset=2001 to continue.]"), true, body.slice(-80));
  });

  test("形态 1b：带 offset 也照样截断（1000 → 2999 行，不多一行）", async () => {
    state.files.set("/workspace/repo/huge.txt", Buffer.from(numberedLines(10_000)));
    const result = await runRead({ path: "huge.txt", offset: 1000 }, makeContext(READ_ONLY_EXEC));
    const body = result.content;
    const shown = body.slice(0, body.indexOf("\n\n["));
    const lines = shown.split("\n");
    assert.equal(lines.length, 2000);
    assert.equal(lines[0], "line-001000");
    assert.equal(lines.at(-1), "line-002999");
    assert.equal(body.endsWith("[Showing lines 1000-2999. Use offset=3000 to continue.]"), true, body.slice(-80));
  });

  test("形态 2：字节先到（每行 100 字节）", async () => {
    state.files.set("/workspace/repo/wide.txt", Buffer.from(numberedLines(2000, 100)));
    const result = await runRead({ path: "wide.txt" }, makeContext(READ_ONLY_EXEC));
    const body = result.content;
    const notice = body.slice(body.indexOf("\n\n[") + 2);
    assert.match(notice, /^\[Showing lines 1-\d+ \(50KB limit\)\. Use offset=\d+ to continue\.\]$/, notice);
    const shown = body.slice(0, body.indexOf("\n\n["));
    assert.ok(Buffer.byteLength(shown) <= 50 * 1024, `${Buffer.byteLength(shown)}`);
    // 提示里的 offset 与实际返回行数自洽（下一行就是接着的那一行）。
    const match = /Use offset=(\d+) to continue/.exec(notice)!;
    assert.equal(Number(match[1]), shown.split("\n").length + 1);
  });

  test("形态 3：模型自己传的 limit 先到、后面还有（总行数已知）", async () => {
    state.files.set("/workspace/repo/mid.txt", Buffer.from(numberedLines(500)));
    const result = await runRead({ path: "mid.txt", offset: 321, limit: 20 }, makeContext(READ_ONLY_EXEC));
    assert.equal(result.content.endsWith("[160 more lines in file. Use offset=341 to continue.]"), true, result.content.slice(-80));
    const shown = result.content.slice(0, result.content.indexOf("\n\n["));
    assert.equal(shown.split("\n").length, 20);
    assert.equal(shown.startsWith("line-000321"), true);
  });

  test("形态 4：第一行本身就超 50 KiB → 给一条能直接跑的命令，不给半行", async () => {
    const huge = "z".repeat(100 * 1024);
    state.files.set("/workspace/repo/oneline.txt", Buffer.from(`${huge}\nsecond\n`));
    const result = await runRead({ path: "oneline.txt" }, makeContext(READ_ONLY_EXEC));
    assert.equal(result.isError, false);
    assert.match(result.content, /^\[Line 1 is 100KB, exceeds 50KB limit\. Use bash: sed -n '1p' '\/workspace\/repo\/oneline\.txt' \| head -c 51200\]$/);
    assert.equal(result.content.includes("z".repeat(100)), false, "不能把那一行塞回来");
  });

  test("分片路径上的超长行：内存有界（不把 4 MB 的单行攒进内存）", async () => {
    // 一个 > 1 MiB 的文件，其中第 1500 行是一行 4 MB 的 minified 风格内容。
    const head = numberedLines(1499);
    const monster = "m".repeat(4 * 1024 * 1024);
    const tail = numberedLines(20);
    const source = `${head}${monster}\n${tail}`;
    state.files.set("/workspace/repo/minified.js", Buffer.from(source));
    assert.ok(Buffer.byteLength(source) > 1024 * 1024);

    // 从第 1 行读到超长行前：扫描器在攒到 1 MiB 时就停下，把这一行当成"放不下"，
    // 于是提示里的 offset 正好指向它。
    const before = await runRead({ path: "minified.js" }, makeContext(READ_ONLY_EXEC));
    assert.equal(before.isError, false, before.content);
    assert.match(before.content, /\[Showing lines 1-1499\. Use offset=1500 to continue\.\]$/);
    assert.equal(before.content.split("\n").length > 1400, true);
    assert.equal(before.content.includes("mmmm"), false, "不能把超长行的内容带出来");

    // 再读那一行：走的是形态 4（措辞是 over，因为真实长度没被完整扫过）。
    const monsterLine = await runRead({ path: "minified.js", offset: 1500 }, makeContext(READ_ONLY_EXEC));
    assert.equal(monsterLine.isError, false);
    // 上限是 MAX_LINE_BYTES + 一个窗口（检查在每个窗口之后做一次），所以措辞是"over"。
    assert.match(monsterLine.content, /^\[Line 1500 is over \d+\.\dMB, exceeds 50KB limit\. Use bash: sed -n '1500p'/);
  });

  test("offset 超过总行数 → is_error，消息里带总行数", async () => {
    state.files.set("/workspace/repo/short.txt", Buffer.from(numberedLines(42)));
    const result = await runRead({ path: "short.txt", offset: 9000 }, makeContext(READ_ONLY_EXEC));
    assert.equal(result.isError, true);
    assert.equal(result.content, "Offset 9000 is beyond end of file (42 lines total)");
  });

  test("续读不重不漏：5000 行分 3 次拼起来与源文件逐行相等", async () => {
    const source = numberedLines(5000);
    state.files.set("/workspace/repo/parts.txt", Buffer.from(source));
    const context = makeContext(READ_ONLY_EXEC);
    const collected: string[] = [];
    let offset = 1;
    for (let round = 0; round < 3; round += 1) {
      const result = await runRead({ path: "parts.txt", offset }, context);
      assert.equal(result.isError, false);
      const body = result.content;
      const noticeAt = body.indexOf("\n\n[");
      const shown = noticeAt < 0 ? body : body.slice(0, noticeAt);
      collected.push(...shown.split("\n"));
      if (noticeAt < 0) break;
      const match = /Use offset=(\d+) to continue/.exec(body)!;
      offset = Number(match[1]);
    }
    assert.deepEqual(collected, source.split("\n").slice(0, -1));
  });

  test("行号契约：\"a\\nb\" 与 \"a\\nb\\n\" 都是 2 行，CRLF 不算两行", async () => {
    state.files.set("/workspace/repo/two-a.txt", Buffer.from("a\nb"));
    state.files.set("/workspace/repo/two-b.txt", Buffer.from("a\nb\n"));
    state.files.set("/workspace/repo/crlf.txt", Buffer.from("a\r\nb\r\n"));
    const context = makeContext(READ_ONLY_EXEC);
    for (const name of ["two-a.txt", "two-b.txt", "crlf.txt"]) {
      const exact = await runRead({ path: name, offset: 3 }, context);
      assert.equal(exact.isError, true, name);
      assert.match(exact.content, /\(2 lines total\)$/, `${name}: ${exact.content}`);
    }
  });
});

describe("Phase 11 · read 的分片路径（大文件 + 锚点）", () => {
  test("> 1 MiB 走 raw 窗口；第二次读命中锚点，不从头扫", async () => {
    const lines: string[] = [];
    for (let index = 1; index <= 60_000; index += 1) {
      // 掺中文：验证窗口边界上的多字节字符不会被切坏。
      lines.push(`line-${String(index).padStart(6, "0")}-资料`);
    }
    const source = `${lines.join("\n")}\n`;
    state.files.set("/workspace/repo/giant.txt", Buffer.from(source));
    assert.ok(Buffer.byteLength(source) > 1024 * 1024, "样本必须超过内联上限才会走分片路径");

    const context = makeContext(READ_ONLY_EXEC);
    const first = await runRead({ path: "giant.txt" }, context);
    assert.equal(first.isError, false);
    const firstShown = first.content.slice(0, first.content.indexOf("\n\n["));
    // 每行 ~19 字节，50 KiB 装得下 2000 行——所以是行数先生效。
    assert.deepEqual(firstShown.split("\n"), lines.slice(0, 2000));

    const readsBefore = state.requests.filter((request) => request.query.get("raw") === "1").length;
    const second = await runRead({ path: "giant.txt", offset: 2001, limit: 10 }, context);
    assert.equal(second.isError, false);
    const secondShown = second.content.slice(0, second.content.indexOf("\n\n["));
    assert.deepEqual(secondShown.split("\n"), lines.slice(2000, 2010));

    // 第二次的 raw 请求直接跳到锚点行（第 2000 行，上一次返回的最后一行）的字节偏移——
    // 这就是"没有 O(n²)"的证据：只多扫那一行，而不是把前面 2000 行全部重读。
    const rawReads = state.requests.filter((request) => request.query.get("raw") === "1");
    assert.equal(rawReads.length, readsBefore + 1);
    const anchorLine = lines[1999]!;
    const expectedOffset = Buffer.byteLength(source.slice(0, source.indexOf(anchorLine)));
    assert.equal(Number(rawReads.at(-1)!.query.get("offset") ?? "0"), expectedOffset);
  });

  test("二进制文件（没走内联路径时）报 is_error，不给一片替换字符", async () => {
    const binary = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < binary.length; index += 1) binary[index] = (index * 7) % 256;
    state.files.set("/workspace/repo/blob.bin", binary);
    const result = await runRead({ path: "blob.bin" }, makeContext(READ_ONLY_EXEC));
    assert.equal(result.isError, true);
    assert.match(result.content, /不是合法 UTF-8/);
  });
});

describe("Phase 11 · read / list / write 的边界", () => {
  test("小文件往返 + 目录提示 + 越界拒绝", async () => {
    const context = makeContext(READ_ONLY_EXEC);
    const small = await runRead({ path: "src/small.ts" }, context);
    assert.equal(small.content, "export const a = 1;\nexport const b = 2;");

    const dir = await runRead({ path: "src" }, context);
    assert.equal(dir.isError, true);
    assert.match(dir.content, /目录/);

    const outside = await runRead({ path: "../../etc/passwd" }, context);
    assert.equal(outside.isError, true);
    assert.match(outside.content, /越界/);

    const binary = await runRead({ path: "src/binary.bin" }, context);
    assert.equal(binary.isError, true);
    assert.match(binary.content, /UTF-8/);
  });

  test("write：写到沙箱、返回 sha256、失效该路径的读锚点", async () => {
    const context = makeContext(READ_ONLY_EXEC);
    context.anchors.set("/workspace/repo/src/answer.ts", { lineNumber: 2, byteOffset: 12345 });
    const content = "const answer = 42;\n";
    const result = await runWrite({ path: "src/answer.ts", content }, context);
    assert.equal(result.isError, false);
    assert.match(result.content, /Wrote 19 bytes \(1 line\) to \/workspace\/repo\/src\/answer\.ts/);
    assert.match(result.content, new RegExp(createHash("sha256").update(content).digest("hex")));
    assert.deepEqual(state.files.get("/workspace/repo/src/answer.ts"), Buffer.from(content));
    assert.equal(context.anchors.get("/workspace/repo/src/answer.ts"), null);
  });

  test("list：类型、排序、目录尾斜杠", async () => {
    state.files.set("/workspace/repo/src/a.ts", Buffer.from("a"));
    state.files.set("/workspace/repo/src/deep/b.ts", Buffer.from("b"));
    const result = await runList({ path: "src" }, makeContext(READ_ONLY_EXEC));
    assert.equal(result.isError, false);
    const lines = result.content.split("\n");
    assert.equal(lines[0]!.startsWith("file"), true, lines[0]);
    assert.equal(lines[0]!.includes("/workspace") === false, true);
    assert.equal(lines.some((line) => line.includes("deep/")), true, result.content);
    // 排序：同一层按 name 升序（a.ts 在 deep 之前）。
    assert.ok(lines.findIndex((line) => line.includes("a.ts")) < lines.findIndex((line) => line.includes("deep/")));
  });

  test("参数校验失败是 is_error，不是异常（用例 3）", async () => {
    const context = makeContext(READ_ONLY_EXEC);
    const asString = await runBash({ cmd: "npm test" }, context);
    assert.equal(asString.isError, true);
    assert.match(asString.content, /argv 数组/);
    assert.match(asString.content, /\["bash","-lc","npm test"\]/);

    const noPath = await runRead({}, context);
    assert.equal(noPath.isError, true);
    assert.match(noPath.content, /path 必填/);

    const badDepth = await runList({ path: "src", depth: 99 }, context);
    assert.equal(badDepth.isError, true);
    assert.match(badDepth.content, /depth 必须在 1\.\.8/);

    const envStyle = await runBash({ cmd: ["FOO=1", "node", "-e", "print()"] }, context);
    assert.equal(envStyle.isError, true);
    assert.match(envStyle.content, /VAR=value/);

    const unknown = await createToolkit({
      sandboxId: "sbx_test",
      exec: READ_ONLY_EXEC,
      api,
      target: TARGET,
    }).run("nope", {});
    assert.equal(unknown.isError, true);
    assert.match(unknown.content, /没有这个工具/);
  });
});

describe("Phase 11 · bash", () => {
  test("输出 3000 行 → 只有最后 2000 行 + Full output 指向日志（用例 5）", async () => {
    const log = numberedLines(3000);
    const logPath = "/tmp/reuben-cloud/exec/exe_test.log";
    state.files.set(logPath, Buffer.from(log));

    const exec = fakeExec({ result: { exitCode: 1, logPath, stdoutBytes: Buffer.byteLength(log) } });
    const context = makeContext(exec);
    const result = await runBash({ cmd: ["bash", "-lc", "make test"] }, context);

    assert.equal(result.isError, false, result.content);
    const body = result.content;
    const shown = body.slice(0, body.indexOf("\n\n["));
    assert.equal(shown.split("\n").length, 2000);
    assert.equal(shown.startsWith("line-001001"), true, shown.slice(0, 40));
    assert.equal(shown.endsWith("line-003000"), true, shown.slice(-20));
    assert.equal(body.includes("[exit 1]"), true);
    assert.equal(
      body.endsWith(`[Showing lines 1001-3000 of 3000. Full output: ${logPath}]`),
      true,
      body.slice(-120),
    );

    // 模型可以按 offset 从日志里读回开头——这正是"续读"存在的理由。
    const head = await runRead({ path: logPath, offset: 1, limit: 5 }, context);
    assert.equal(head.isError, false);
    const headShown = head.content.slice(0, head.content.indexOf("\n\n[") < 0 ? undefined : head.content.indexOf("\n\n["));
    assert.equal(headShown, numberedLines(5).split("\n").slice(0, 5).join("\n"));
    assert.match(head.content, /\[2995 more lines in file\. Use offset=6 to continue\.\]$/);

    // 命令确实发出去了，而且 cwd 显式给了仓库根（沙箱的默认 cwd 是 /workspace，
    // 模型心里的 cwd 是 /workspace/repo——不显式给就会在错的目录里跑）。
    assert.deepEqual(exec.calls, [{ cmd: ["bash", "-lc", "make test"], cwd: "/workspace/repo" }]);
  });

  test("日志读不回来时退回事件流内容，并如实说明（不把成功的命令报成失败）", async () => {
    const exec = fakeExec({
      result: { exitCode: 0, logPath: "/tmp/reuben-cloud/exec/gone.log" },
      events: [
        { event: "stdout", data: JSON.stringify({ chunk: "hello " }) },
        { event: "stderr", data: JSON.stringify({ chunk: "from events\n" }) },
      ],
    });
    const result = await runBash({ cmd: ["echo", "hi"] }, makeContext(exec));
    assert.equal(result.isError, false);
    assert.equal(result.content.includes("hello from events"), true, result.content);
    assert.equal(result.content.includes("Full output unavailable"), true, result.content);
  });

  test("failed 状态（命令没起来）→ is_error", async () => {
    const exec = fakeExec({
      result: { state: "failed", exitCode: null, logPath: null },
      events: [{ event: "stderr", data: JSON.stringify({ chunk: "spawn ENOENT\n" }) }],
    });
    const result = await runBash({ cmd: ["definitely-not-a-binary"] }, makeContext(exec));
    assert.equal(result.isError, true);
    assert.match(result.content, /没能启动这条命令/);
    assert.match(result.content, /ENOENT/);
  });

  test("timeout / killed 的状态行", async () => {
    const timeout = fakeExec({ result: { state: "timeout", exitCode: null, signal: "SIGTERM", logPath: null } });
    const timeoutResult = await runBash({ cmd: ["sleep", "300"], timeoutMs: 1000 }, makeContext(timeout));
    assert.equal(timeoutResult.content.includes("[timeout after 1000ms]"), true, timeoutResult.content);

    const killed = fakeExec({ result: { state: "killed", exitCode: null, signal: "SIGKILL", logPath: null } });
    const killedResult = await runBash({ cmd: ["sleep", "300"] }, makeContext(killed));
    assert.equal(killedResult.content.includes("[killed (SIGKILL)]"), true, killedResult.content);
    assert.equal(killedResult.content.includes("(no output)"), true);
  });

  test("相对 cwd 按仓库根解析", async () => {
    const exec = fakeExec({ result: { logPath: null } });
    await runBash({ cmd: ["pwd"], cwd: "packages/app" }, makeContext(exec));
    assert.equal(exec.calls[0]?.cwd, "/workspace/repo/packages/app");
  });
});

describe("Phase 11 · 工具箱", () => {
  test("definitions 按名字排序且带 input_schema；dispatch 认识四个工具", () => {
    const toolkit = createToolkit({ sandboxId: "sbx_test", exec: READ_ONLY_EXEC, api, target: TARGET });
    assert.deepEqual(
      toolkit.definitions.map((tool) => tool.name),
      ["bash", "list", "read", "write"],
    );
    for (const tool of toolkit.definitions) {
      assert.equal(typeof tool.description, "string");
      assert.equal(typeof tool.input_schema, "object");
      assert.ok(tool.description.length > 40, `${tool.name} 的描述太短`);
    }
    assert.equal(bashTool.name, "bash");
    assert.equal(readTool.name, "read");
    assert.equal(writeTool.name, "write");
    assert.equal(listTool.name, "list");
    assert.equal(sse("stdout", {}).startsWith("id:"), true);
    assert.equal(typeof Readable.from, "function");
  });
});
