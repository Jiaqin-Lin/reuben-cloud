/**
 * Phase 11 · 截断与行号契约（不需要 Docker、不需要网络）。
 *
 * 这一份守的是 §3.5 的**全局性质**："任何 tool_result 都不会超过 2000 行 / 50 KiB"。
 * 它是四个工具共用的那一份实现，所以在这里把边界全钉死：
 *  - 行号契约：`"a\nb"` 与 `"a\nb\n"` 都是 2 行；`\r\n` 里的 `\r` 不算一行；空串 0 行
 *  - 保头 / 保尾两条方向的"先到先算"
 *  - "不返回半行"的唯一例外（保尾时最后一行本身超预算）
 *  - 保头时第一行超预算 → 由调用方给出 `sed -n` 那条可执行提示
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_TOOL_BYTES,
  MAX_TOOL_LINES,
  countLines,
  formatBytes,
  splitLines,
  tailBytes,
  truncateHead,
  truncateTail,
} from "../../src/agent/tools/truncate.ts";

/** 造 n 行、每行 `width` 个字符的文本（行尾带换行）。 */
function linesOf(n: number, width = 10): string {
  const lines = new Array<string>(n);
  for (let index = 0; index < n; index += 1) {
    lines[index] = `line-${String(index + 1).padStart(6, "0")}`.padEnd(width, "x");
  }
  return `${lines.join("\n")}\n`;
}

describe("Phase 11 · 行号契约", () => {
  test("末尾换行不额外算一行；空串是 0 行", () => {
    assert.equal(countLines("a\nb"), 2);
    assert.equal(countLines("a\nb\n"), 2);
    assert.equal(countLines(""), 0);
    assert.equal(countLines("\n"), 1);
    assert.equal(countLines("a"), 1);
    assert.deepEqual(splitLines("a\nb\n\n"), ["a", "b", ""]);
  });

  test("CRLF 里的 \\r 不算新的一行，内容原样保留", () => {
    assert.equal(countLines("a\r\nb\r\n"), 2);
    assert.deepEqual(splitLines("a\r\nb"), ["a\r", "b"]);
  });
});

describe("Phase 11 · truncateHead（read / list 用）", () => {
  test("行数先到：5000 行 → 恰好 2000 行", () => {
    const result = truncateHead(linesOf(5000));
    assert.equal(result.outputLines, MAX_TOOL_LINES);
    assert.equal(result.totalLines, 5000);
    assert.equal(result.truncated, true);
    assert.equal(result.truncatedBy, "lines");
    assert.equal(result.content.split("\n").length, MAX_TOOL_LINES);
  });

  test("字节先到：2000 行 × 100 字节 → 返回内容 ≤ 50 KiB", () => {
    const result = truncateHead(linesOf(2000, 99));
    assert.equal(result.truncatedBy, "bytes");
    assert.ok(Buffer.byteLength(result.content) <= MAX_TOOL_BYTES, `${Buffer.byteLength(result.content)}`);
    assert.ok(result.outputLines < MAX_TOOL_LINES, `字节预算没有先生效：${result.outputLines} 行`);
  });

  test("内容里不含提示行——提示由调用方拼（它不占 50 KiB 预算）", () => {
    const result = truncateHead(linesOf(5000));
    assert.equal(result.content.includes("Use offset="), false);
  });

  test("第一行本身超预算：不返回半行，标出 firstLineExceedsLimit", () => {
    const huge = "x".repeat(MAX_TOOL_BYTES + 1);
    const result = truncateHead(`${huge}\nsecond\n`);
    assert.equal(result.firstLineExceedsLimit, true);
    assert.equal(result.outputLines, 0);
    assert.equal(result.content, "");
    assert.equal(result.totalLines, 2);
  });

  test("空文本 / 刚好放得下：不标截断", () => {
    assert.equal(truncateHead("").truncated, false);
    assert.equal(truncateHead("").totalLines, 0);
    const exact = truncateHead(linesOf(10));
    assert.equal(exact.truncated, false);
    assert.equal(exact.outputLines, 10);
  });
});

describe("Phase 11 · truncateTail（bash 用）", () => {
  test("保结尾：3000 行 → 最后 2000 行，前面 1000 行被丢掉", () => {
    const result = truncateTail(linesOf(3000));
    assert.equal(result.outputLines, MAX_TOOL_LINES);
    assert.equal(result.skippedLines, 1000);
    assert.equal(result.truncatedBy, "lines");
    assert.equal(result.content.startsWith("line-001001"), true, result.content.slice(0, 40));
    assert.equal(result.content.endsWith("line-003000"), true, result.content.slice(-20));
  });

  test("字节先到：返回内容 ≤ 50 KiB 且保住结尾", () => {
    const result = truncateTail(linesOf(2000, 99));
    assert.equal(result.truncatedBy, "bytes");
    assert.ok(Buffer.byteLength(result.content) <= MAX_TOOL_BYTES);
    // 最后一行是完整的第 2000 行（不是半行）——保尾的语义就是"保住结尾"。
    assert.equal(result.content.split("\n").at(-1)?.startsWith("line-002000"), true);
    assert.ok(result.skippedLines > 0);
  });

  test("最后一行本身超预算：从行尾截，标 lastLinePartial（唯一允许半行的分支）", () => {
    const single = "y".repeat(MAX_TOOL_BYTES * 2);
    const result = truncateTail(`${single}\n`);
    assert.equal(result.lastLinePartial, true);
    assert.equal(Buffer.byteLength(result.content), MAX_TOOL_BYTES);
    assert.equal(result.content, single.slice(single.length - MAX_TOOL_BYTES));
  });

  test("tailBytes 不切开一个码点", () => {
    const text = "中".repeat(10); // 每个 3 字节
    const cut = tailBytes(text, 4);
    assert.equal(Buffer.byteLength(cut), 3);
    assert.equal(cut, "中");
  });

  test("短文本不标截断", () => {
    const result = truncateTail("a\nb\nc\n");
    assert.equal(result.truncated, false);
    assert.equal(result.skippedLines, 0);
    assert.equal(result.content, "a\nb\nc");
  });
});

describe("Phase 11 · formatBytes", () => {
  test("人对得上的单位", () => {
    assert.equal(formatBytes(0), "0B");
    assert.equal(formatBytes(512), "512B");
    assert.equal(formatBytes(50 * 1024), "50KB");
    assert.equal(formatBytes(2 * 1024 * 1024), "2.0MB");
  });
});
