import test from "node:test";
import assert from "node:assert/strict";
import { OutputMerger, type OutputMergerOptions } from "../src/exec/output.ts";

interface Chunk {
  text: string;
  bytes: number;
}

function collector(options: Omit<OutputMergerOptions, "onChunk">) {
  const chunks: Chunk[] = [];
  const merger = new OutputMerger({ ...options, onChunk: (text, bytes) => chunks.push({ text, bytes }) });
  return { chunks, merger };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("output: 单次 flush 不超过 chunkBytes，内容与顺序不变", () => {
  const { chunks, merger } = collector({ chunkBytes: 64, flushIntervalMs: 10_000 });
  merger.push(Buffer.alloc(40, "a"));
  assert.equal(chunks.length, 0, "不到 64KiB 且未到时间窗，不应该发");
  merger.push(Buffer.alloc(40, "b"));
  merger.push(Buffer.alloc(40, "c"));
  merger.end();

  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) assert.ok(chunk.bytes <= 64, `chunk ${chunk.bytes} > 64`);
  assert.equal(
    chunks.map((c) => c.text).join(""),
    "a".repeat(40) + "b".repeat(40) + "c".repeat(40),
  );
  assert.equal(
    chunks.reduce((sum, c) => sum + c.bytes, 0),
    120,
  );
});

test("output: 100ms 窗口到点就 flush", async () => {
  const { chunks, merger } = collector({ chunkBytes: 4096, flushIntervalMs: 20 });
  merger.push(Buffer.from("hi"));
  assert.equal(chunks.length, 0);
  await delay(80);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, "hi");
});

test("output: 跨 chunk 的多字节字符不被切坏", () => {
  const text = "中文測試🙂日本語";
  const bytes = Buffer.from(text, "utf8");
  const { chunks, merger } = collector({ chunkBytes: 4096, flushIntervalMs: 10_000 });

  for (const byte of bytes) merger.push(Buffer.from([byte]));
  merger.end();

  assert.equal(chunks.map((c) => c.text).join(""), text);
  assert.ok(!chunks.some((c) => c.text.includes("\uFFFD")), "不应该出现替换字符");
  assert.equal(
    chunks.reduce((sum, c) => sum + c.bytes, 0),
    bytes.length,
  );
  assert.ok(chunks.every((c) => c.bytes <= 4096));
});

test("output: 字节计数是原始字节数（非法 UTF-8 会变成替换字符，但计数不膨胀）", () => {
  const { chunks, merger } = collector({ chunkBytes: 4096, flushIntervalMs: 10_000 });
  merger.push(Buffer.from([0x00, 0x01, 0xff]));
  merger.end();

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, "\u0000\u0001\uFFFD");
  assert.equal(chunks[0]!.bytes, 3);
});

test("output: 只有半个多字节字符时 flush 不丢字节计数", () => {
  const { chunks, merger } = collector({ chunkBytes: 4096, flushIntervalMs: 10_000 });
  const bytes = Buffer.from("中", "utf8");
  merger.push(bytes.subarray(0, 2));
  merger.flush(); // parts 为空，字节计数要留着
  assert.equal(chunks.length, 0);
  merger.push(bytes.subarray(2));
  merger.end();

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, "中");
  assert.equal(chunks[0]!.bytes, 3);
});

test("output: end() 吐出残留尾巴", () => {
  const { chunks, merger } = collector({ chunkBytes: 4096, flushIntervalMs: 10_000 });
  merger.push(Buffer.from("tail"));
  assert.equal(chunks.length, 0);
  merger.end();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, "tail");
});
