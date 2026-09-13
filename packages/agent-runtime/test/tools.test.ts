/**
 * Phase 1 · 内置工具（不需要 Docker、不需要网络）。
 *
 * 每个工具都对着一个**内存里的假执行后端**跑：被测的是"字节 ↔ 行""四种收尾形态"
 * "截断边界""锚点失效"这些**工具自己的性质**——它们与沙箱无关，换了后端也要成立。
 * 对应 spec 测试要点 7（truncate 边界）、12 的一部分（read 的续读）以及 P11 表里
 * 已经能在 P1 验的部分。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FileOperationError, ToolInputError, toolErrorMessage } from "../src/tools/errors.ts";
import { createReadAnchors } from "../src/tools/anchors.ts";
import type { BashExecOptions, BashExecResult, BashOperations } from "../src/tools/bash.ts";
import { createBashTool, DEFAULT_BASH_TIMEOUT_MS, runBash } from "../src/tools/bash.ts";
import type { LsOperations, LsResult } from "../src/tools/ls.ts";
import { createLsTool } from "../src/tools/ls.ts";
import type { ReadOperations } from "../src/tools/read.ts";
import { createReadTool } from "../src/tools/read.ts";
import { MAX_TOOL_BYTES, formatBytes, splitLines, truncateHead, truncateTail } from "../src/tools/truncate.ts";
import type { WriteOperations } from "../src/tools/write.ts";
import { createWriteTool, runWrite } from "../src/tools/write.ts";
import type { AgentToolResult } from "../src/types.ts";
import { runRead } from "../src/tools/read.ts";

const CWD = "/workspace/repo";

/** 内存文件系统：实现三个文件出口（结构上分别满足 Read/Write/LsOperations）。 */
class FakeFiles implements ReadOperations, WriteOperations, LsOperations {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(["/workspace", "/workspace/repo"]);
  /** 超过这个大小的文件走"分片"路径（模拟沙箱的内联上限）。 */
  inlineLimit = 64 * 1024;
  readBytesCalls: Array<{ path: string; offset: number; limit: number }> = [];
  writeCalls: Array<{ path: string; content: string }> = [];

  put(path: string, content: string | Buffer): void {
    this.files.set(path, typeof content === "string" ? Buffer.from(content, "utf8") : content);
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir !== "") this.dirs.add(dir);
  }

  async readFile(path: string): Promise<string> {
    const buffer = this.files.get(path);
    if (buffer === undefined) {
      if (this.dirs.has(path)) throw new FileOperationError("is_directory", `是一个目录：${path}`, { details: { path } });
      throw new FileOperationError("not_found", "文件不存在", { details: { path } });
    }
    if (buffer.length > this.inlineLimit) throw new FileOperationError("too_large", "文件太大", { details: { path } });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
      // 真实后端会把非法 UTF-8 报成结构化错误；假后端照做，工具才能走到那条翻译。
      throw new FileOperationError("invalid_utf8", "不是合法 UTF-8", { details: { path }, cause: error });
    }
  }

  async readBytes(path: string, offset: number, limit: number): Promise<Buffer> {
    this.readBytesCalls.push({ path, offset, limit });
    const buffer = this.files.get(path);
    if (buffer === undefined) throw new FileOperationError("not_found", "文件不存在", { details: { path } });
    return buffer.subarray(offset, offset + limit);
  }

  async writeFile(path: string, content: string): Promise<{ bytes: number; sha256: string; path: string }> {
    this.writeCalls.push({ path, content });
    this.put(path, content);
    const bytes = Buffer.byteLength(content, "utf8");
    return { bytes, sha256: "deadbeef", path };
  }

  async list(path: string, options: { depth: number }): Promise<LsResult> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries = new Map<string, { name: string; type: string; size: number }>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const parts = rest.split("/");
      const name = options.depth > 1 ? rest : parts[0]!;
      const isDir = parts.length > 1 && options.depth <= 1;
      if (isDir) entries.set(name, { name, type: "dir", size: 0 });
      else if (!entries.has(name)) entries.set(name, { name, type: "file", size: this.files.get(file)!.length });
    }
    if (entries.size === 0 && !this.dirs.has(path)) {
      throw new FileOperationError("not_found", "目录不存在", { details: { path } });
    }
    return { path, entries: [...entries.values()], truncated: false };
  }
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function callTool(tool: ReturnType<typeof createReadTool>, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("call_1", args as never);
  return textOf(result);
}

// ---------------------------------------------------------------- truncate

describe("Phase 1 · truncate 边界", () => {
  test("恰好 2000 行不截断；2001 行按 lines 截断", () => {
    const exactly = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join("\n");
    const ok = truncateHead(exactly);
    assert.equal(ok.truncated, false);
    assert.equal(ok.totalLines, 2000);

    const more = `${exactly}\nline 2001`;
    const cut = truncateHead(more);
    assert.equal(cut.truncated, true);
    assert.equal(cut.truncatedBy, "lines");
    assert.equal(cut.outputLines, 2000);
    assert.equal(cut.totalLines, 2001);
  });

  test("恰好 50KB 不截断；多一行按 bytes 截断", () => {
    const line = "x".repeat(99);
    const body = Array.from({ length: 511 }, () => line).join("\n"); // 511*100 - 1 = 51099
    const ok = truncateHead(body, { maxLines: 10_000 });
    assert.equal(ok.truncated, false);
    assert.ok(Buffer.byteLength(ok.content) <= MAX_TOOL_BYTES);

    const cut = truncateHead(`${body}\n${"y".repeat(200)}`, { maxLines: 10_000 });
    assert.equal(cut.truncated, true);
    assert.equal(cut.truncatedBy, "bytes");
    assert.ok(Buffer.byteLength(cut.content) <= MAX_TOOL_BYTES);
  });

  test("第一行本身超预算 → firstLineExceedsLimit（不返回半行）", () => {
    const result = truncateHead(`${"z".repeat(MAX_TOOL_BYTES + 10)}\nsecond`);
    assert.equal(result.firstLineExceedsLimit, true);
    assert.equal(result.content, "");
    assert.equal(result.outputLines, 0);
  });

  test("truncateTail 保结尾；最后一行超预算时才允许半行", () => {
    const body = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const tail = truncateTail(body, { maxLines: 3 });
    assert.equal(tail.content, "line 8\nline 9\nline 10");
    assert.equal(tail.skippedLines, 7);

    const partial = truncateTail("y".repeat(MAX_TOOL_BYTES + 100), { maxBytes: 100 });
    assert.equal(partial.lastLinePartial, true);
    assert.equal(Buffer.byteLength(partial.content), 100);
  });

  test("行号契约：空串 0 行、末尾换行不产生空行、\\r 不算分隔符", () => {
    assert.equal(splitLines("").length, 0);
    assert.equal(splitLines("a\nb\n").length, 2);
    assert.equal(splitLines("a\r\nb").length, 2);
    assert.equal(splitLines("\n").length, 1);
  });
});

// ---------------------------------------------------------------- read

describe("Phase 1 · read 工具", () => {
  test("小文件：全文返回（不带提示）", async () => {
    const files = new FakeFiles();
    files.put(`${CWD}/src/a.ts`, "const a = 1;\nconst b = 2;\n");
    const read = createReadTool({ cwd: CWD, operations: files });
    assert.equal(await callTool(read, { path: "src/a.ts" }), "const a = 1;\nconst b = 2;");
  });

  test("模型自己传的 limit 先到 → 形态 3（还有 N 行）", async () => {
    const files = new FakeFiles();
    files.put(`${CWD}/a.txt`, Array.from({ length: 30 }, (_, index) => `l${index + 1}`).join("\n"));
    const read = createReadTool({ cwd: CWD, operations: files });
    const output = await callTool(read, { path: "a.txt", offset: 1, limit: 10 });
    assert.match(output, /\[20 more lines in file\. Use offset=11 to continue\.\]/);
    assert.equal(output.split("\n\n")[0]!.split("\n").length, 10);
  });

  test("空文件 / offset 越界", async () => {
    const files = new FakeFiles();
    files.put(`${CWD}/empty.txt`, "");
    const read = createReadTool({ cwd: CWD, operations: files });
    assert.match(await callTool(read, { path: "empty.txt" }), /empty file/);
    await assert.rejects(() => callTool(read, { path: "empty.txt", offset: 5 }), ToolInputError);
  });

  test("大文件走分片路径，且第二次读用锚点跳过前缀", async () => {
    const files = new FakeFiles();
    files.inlineLimit = 200; // 让 3000 行的文件必须走分片
    files.put(`${CWD}/big.txt`, Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join("\n"));
    const anchors = createReadAnchors();
    const read = createReadTool({ cwd: CWD, operations: files, anchors });

    const first = await callTool(read, { path: "big.txt", limit: 10 });
    assert.match(first, /line-10/);
    assert.equal(anchors.get(`${CWD}/big.txt`)?.lineNumber, 10);

    const bytesBefore = files.readBytesCalls.length;
    const second = await callTool(read, { path: "big.txt", offset: 11, limit: 10 });
    assert.match(second, /line-11/);
    // 第二次的第一个窗口请求从锚点的字节偏移开始（不是从 0 重新扫）。
    const secondFirstCall = files.readBytesCalls[bytesBefore]!;
    assert.ok(secondFirstCall.offset > 0, `第二次读应从锚点继续，实际 offset=${secondFirstCall.offset}`);
  });

  test("二进制文件 → 明确的 invalid_utf8 提示（不是一片 U+FFFD）", async () => {
    const files = new FakeFiles();
    files.put(`${CWD}/bin.dat`, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const read = createReadTool({ cwd: CWD, operations: files });
    await assert.rejects(
      () => callTool(read, { path: "bin.dat" }),
      (error: unknown) => error instanceof FileOperationError && error.code === "invalid_utf8",
    );
  });

  test("读目录 → 提示用 ls", async () => {
    const files = new FakeFiles();
    files.put(`${CWD}/src/a.ts`, "x");
    const read = createReadTool({ cwd: CWD, operations: files });
    await assert.rejects(
      () => callTool(read, { path: "src" }),
      (error: unknown) => {
        assert.ok(error instanceof FileOperationError);
        assert.match(toolErrorMessage(error), /用 ls 工具列它/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------- write / ls

describe("Phase 1 · write 与 ls", () => {
  test("write 返回字节数与校验和，并让读锚点失效", async () => {
    const files = new FakeFiles();
    files.put(`${CWD}/a.txt`, "old\n");
    const anchors = createReadAnchors();
    const read = createReadTool({ cwd: CWD, operations: files, anchors });
    await callTool(read, { path: "a.txt" });
    anchors.set(`${CWD}/a.txt`, { lineNumber: 1, byteOffset: 0 });

    const write = createWriteTool({ cwd: CWD, operations: files, anchors });
    const output = textOf(await write.execute("call_1", { path: "a.txt", content: "new\ncontent\n" } as never));
    assert.match(output, /Wrote 12 bytes \(2 lines\)/);
    assert.match(output, /sha256: deadbeef/);
    assert.equal(anchors.get(`${CWD}/a.txt`), null, "写完之后旧锚点必须失效");
    assert.equal(await callTool(read, { path: "a.txt" }), "new\ncontent");
  });

  test("ls 一行一个条目、目录带尾斜杠；空目录有明确文案", async () => {
    const files = new FakeFiles();
    files.put(`${CWD}/src/a.ts`, "x");
    files.put(`${CWD}/README.md`, "readme");
    const ls = createLsTool({ cwd: CWD, operations: files });
    const output = textOf(await ls.execute("call_1", { path: ".", depth: 1 } as never));
    const lines = output.split("\n").sort();
    assert.deepEqual(lines, ["dir     src/", `file    README.md ${formatBytes(6)}`]);

    files.dirs.add(`${CWD}/empty`);
    const empty = textOf(await ls.execute("call_2", { path: "empty", depth: 1 } as never));
    assert.match(empty, /empty directory/);
  });
});

// ---------------------------------------------------------------- bash

describe("Phase 1 · bash 工具", () => {
  test("shell 字符串原样交给后端（适配器负责包成 bash -lc）", async () => {
    const seen: Array<{ command: string; cwd: string; timeoutMs: number | undefined }> = [];
    const operations: BashOperations = {
      async exec(command, cwd, options): Promise<BashExecResult> {
        seen.push({ command, cwd, timeoutMs: options.timeoutMs });
        options.onData(Buffer.from("hello\n"), "stdout");
        return {
          exitCode: 0,
          state: "completed",
          signal: null,
          durationMs: 1,
          stdoutBytes: 6,
          stderrBytes: 0,
          output: "hello\n",
          windowStart: 0,
          totalBytes: 6,
          totalLines: 1,
          logPath: "/tmp/reuben-cloud/exec/exe_1.log",
          logTruncated: false,
          truncated: false,
          logError: null,
        };
      },
    };
    const tool = createBashTool({ cwd: CWD, operations });
    const updates: string[] = [];
    const result = await tool.execute(
      "call_1",
      { command: "npm test 2>&1 | tail -5" } as never,
      undefined,
      (partial) => updates.push(textOf(partial)),
    );

    assert.equal(seen[0]!.command, "npm test 2>&1 | tail -5");
    assert.equal(seen[0]!.cwd, CWD);
    assert.equal(seen[0]!.timeoutMs, DEFAULT_BASH_TIMEOUT_MS);
    assert.equal(textOf(result), "hello");
    assert.deepEqual(updates, ["hello\n"]);
    assert.deepEqual(result.details, { exitCode: 0, state: "completed", logPath: "/tmp/reuben-cloud/exec/exe_1.log" });
  });

  test("非 0 退出不是 isError，只在结尾加 [exit N]", async () => {
    const output = await runBash(
      { command: "false" },
      {
        cwd: CWD,
        operations: fakeBash({ exitCode: 3, output: "boom\n", logPath: "/tmp/log.txt" }),
      },
    );
    assert.match(output.text, /^boom\n\n\[exit 3\]$/);
  });

  test("命令根本没起来（state=failed）→ 抛异常（调用方转成 isError）", async () => {
    await assert.rejects(
      () => runBash({ command: "nope" }, { cwd: CWD, operations: fakeBash({ state: "failed", output: "ENOENT" }) }),
      /没[能]?启动这条命令|沙箱没能启动这条命令/,
    );
  });

  test("输出被切 → 提示带绝对行号与完整日志路径；从窗口中间开始时只报相对行号", async () => {
    const body = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n");
    const fromStart = await runBash(
      { command: "cat big" },
      { cwd: CWD, operations: fakeBash({ exitCode: 0, output: body, totalLines: 3000, logPath: "/tmp/big.log" }) },
    );
    assert.match(fromStart.text, /\[Showing lines 1001-3000 of 3000\. Full output: \/tmp\/big\.log\]/);

    const fromMiddle = await runBash(
      { command: "cat big" },
      {
        cwd: CWD,
        operations: fakeBash({
          exitCode: 0,
          output: body,
          windowStart: 1024,
          totalLines: null,
          totalBytes: 400_000,
          logPath: "/tmp/big.log",
        }),
      },
    );
    assert.match(fromMiddle.text, /\[Showing the last 2000 lines of a 391KB log\. Full output: \/tmp\/big\.log\]/);
  });

  test("超时终态写进状态行", async () => {
    const output = await runBash(
      { command: "sleep 100", timeoutMs: 50 },
      { cwd: CWD, operations: fakeBash({ state: "timeout", exitCode: null, output: "" }) },
    );
    assert.match(output.text, /\[timeout after 50ms\]/);
  });

  test("cwd 相对仓库根解析", async () => {
    let seenCwd = "";
    const operations: BashOperations = {
      async exec(_command, cwd): Promise<BashExecResult> {
        seenCwd = cwd;
        return baseBashResult({});
      },
    };
    await runBash({ command: "ls", cwd: "packages/web" }, { cwd: CWD, operations });
    assert.equal(seenCwd, `${CWD}/packages/web`);
  });
});

function baseBashResult(overrides: Partial<BashExecResult>): BashExecResult {
  return {
    exitCode: 0,
    state: "completed",
    signal: null,
    durationMs: 1,
    stdoutBytes: 0,
    stderrBytes: 0,
    output: "",
    windowStart: 0,
    totalBytes: 0,
    totalLines: 0,
    logPath: null,
    logTruncated: false,
    truncated: false,
    logError: null,
    ...overrides,
  };
}

/** 一个按参数回结果的假后端（`exec` 只记录，不做别的事）。 */
function fakeBash(overrides: Partial<BashExecResult> & { onExec?: (options: BashExecOptions) => void }): BashOperations {
  return {
    async exec(_command, _cwd, options): Promise<BashExecResult> {
      overrides.onExec?.(options);
      return baseBashResult(overrides);
    },
  };
}
