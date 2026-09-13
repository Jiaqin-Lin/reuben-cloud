/**
 * Phase 2 · 导出的 JSONL 与 `model_requests` 的内联/外置分界（spec P2 测试要点 5、6、7）。
 *
 * 【"逐字段兼容"怎么测】把导出结果解析成记录，按 M0 transcript 的**字段名**逐条断言
 * （`run_start` / `request` / `response` / `tool_call` / `note` / `run_end`），
 * 并额外断言字段**没有改名**（少字段可以——那是如实为 null 的那些；改名不行——
 * 那会让现有的排查脚本悄悄读到 undefined）。
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { MemorySessionStore, entryForMessage, entryForNote, exportSession } from "@reuben-cloud/agent-runtime";
import type { AssistantMessage, SessionStore, ToolResultMessage } from "@reuben-cloud/agent-runtime";
import type { ArtifactStore, StoredObject } from "../../src/artifacts/store.ts";
import { RequestRecorder } from "../../src/session/requests.ts";

// ---------------------------------------------------------------- 假的对象存储

function memoryStore(): ArtifactStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(objectKey: string, body: Readable): Promise<StoredObject> {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);
      objects.set(objectKey, buffer);
      return { objectKey, sizeBytes: buffer.length, sha256: "fake" };
    },
    async get(objectKey: string): Promise<Readable> {
      const buffer = objects.get(objectKey);
      if (buffer === undefined) throw new Error(`没有这个对象：${objectKey}`);
      return Readable.from([buffer]);
    },
    async head(objectKey: string) {
      const buffer = objects.get(objectKey);
      return buffer === undefined ? null : { sizeBytes: buffer.length };
    },
    close() {
      /* 假的 */
    },
  };
}

// ---------------------------------------------------------------- 数据

const usage = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 1 };

async function seedSession(store: SessionStore): Promise<string> {
  const { id: sessionId } = await store.createSession({
    repoKey: "owner/name",
    baseCommit: "a".repeat(40),
    cwd: "/workspace/repo",
    taskId: "issue-abc",
    headRef: "reuben-cloud/issue-abc",
  });
  const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "claude-opus-4-8" });

  const userEntryId = await store.appendEntry(
    sessionId,
    runId,
    entryForMessage({ role: "user", content: "把登录的 bug 修掉" }),
  );
  await store.recordRequest({
    sessionId,
    runId,
    turn: 1,
    compiledHash: "hash-1",
    sections: [{ name: "system", tokens: 12, hash: "s" }],
    system: "你是助手",
    toolsHash: "tools",
    inlineMessages: [{ role: "user", content: "把登录的 bug 修掉" }],
    objectKey: null,
    bytes: 40,
  });
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "先读一下文件" }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "login.ts" } }],
    stopReason: "toolUse",
    usage,
  };
  const assistantEntryId = await store.appendEntry(sessionId, runId, entryForMessage(assistant), {
    usage: { kind: "main", provider: "anthropic", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 20 },
  });
  const invocationId = await store.beginToolInvocation({
    sessionId,
    runId,
    turn: 1,
    sourceIndex: 0,
    tool: "read",
    args: { path: "login.ts" },
    replay: "safe",
  });
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "1  export function login() {}" }],
    isError: false,
    timestamp: 0,
  };
  const resultEntryId = await store.settleToolInvocation(invocationId, {
    entry: entryForMessage(toolResult),
    isError: false,
    bytes: 30,
  });
  await store.endRun(runId, { status: "stopped", stopReason: "max_turns", endEntryId: resultEntryId });
  await store.updateSessionHead(sessionId, { leafEntryId: resultEntryId });
  return sessionId;
}

// ---------------------------------------------------------------- M0 的字段名

const M0_FIELDS: Record<string, string[]> = {
  run_start: ["ts", "runId", "model", "issue", "system", "tools", "limits"],
  request: ["ts", "turn", "model", "system", "tools", "maxTokens", "messages"],
  response: ["ts", "turn", "durationMs", "content", "stopReason", "usage", "refusalReason", "errorMessage"],
  tool_call: ["ts", "turn", "id", "name", "input", "isError", "resultBytes"],
  note: ["ts", "turn", "kind", "message"],
  run_end: ["ts", "stopReason", "detail", "turns", "toolCalls", "usage", "transcriptFailure"],
};

function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Phase 2 · 导出与编译产物", () => {
  test("6. 导出的 JSONL 与 M0 的记录类型/字段名逐条兼容，且带轮次分隔", async () => {
    const store = new MemorySessionStore();
    const sessionId = await seedSession(store);
    const jsonl = await exportSession(store, sessionId);
    const records = parseJsonl(jsonl);

    assert.deepEqual(records[0], { type: "run", runId: records[0]!["runId"] });
    const types = records.map((record) => record["type"]);
    for (const expected of ["run", "run_start", "request", "response", "tool_call", "run_end"]) {
      assert.ok(types.includes(expected), `导出里少了 ${expected}`);
    }

    for (const record of records) {
      const fields = M0_FIELDS[record["type"] as string];
      if (fields === undefined) continue;
      for (const field of fields) {
        assert.ok(field in record, `${record["type"]}.${field} 应该在导出里（可以是 null，但不能改名）`);
      }
    }

    const runStart = records.find((record) => record["type"] === "run_start")!;
    assert.equal(runStart["runId"], records[0]!["runId"]);
    assert.equal(runStart["model"], "claude-opus-4-8");
    assert.match(String(runStart["issue"]), /把登录的 bug 修掉/);
    assert.equal(runStart["system"], "你是助手");

    const response = records.find((record) => record["type"] === "response")!;
    assert.equal(response["turn"], 1);
    assert.equal(response["stopReason"], "toolUse");

    const toolCall = records.find((record) => record["type"] === "tool_call")!;
    assert.equal(toolCall["id"], "call_1");
    assert.deepEqual(toolCall["input"], { path: "login.ts" });
    assert.equal(toolCall["isError"], false);
    assert.equal(toolCall["resultBytes"], 30);

    const runEnd = records.find((record) => record["type"] === "run_end")!;
    assert.equal(runEnd["stopReason"], "max_turns");
    assert.equal(runEnd["turns"], 1);
    assert.equal(runEnd["toolCalls"], 1);
  });

  test("7. 压缩条目与 note：进导出（kind=note），但不进模型的投影", async () => {
    const store = new MemorySessionStore();
    const sessionId = await seedSession(store);
    const runs = await store.listRuns(sessionId);
    await store.appendEntry(sessionId, runs[0]!.id, entryForNote("context_trim", "丢掉了 6 条旧工具结果", { turn: 1 }));
    await store.endRun(runs[0]!.id, { status: "stopped", stopReason: "max_turns", endEntryId: null });

    const records = parseJsonl(await exportSession(store, sessionId));
    const note = records.find((record) => record["type"] === "note")!;
    assert.equal(note["kind"], "note");
    assert.equal(note["message"], "丢掉了 6 条旧工具结果");
  });

  test("5. 257 KiB 的 messages → 落对象存储；bytes 与实际一致；读得回来", async () => {
    const store = new MemorySessionStore();
    const artifactStore = memoryStore();
    const recorder = new RequestRecorder({ store, artifactStore });
    const { id: sessionId } = await store.createSession({ repoKey: "o/n", baseCommit: "a".repeat(40), cwd: "/w" });
    const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m" });
    const big = "x".repeat(257 * 1024);
    await recorder.record({
      sessionId,
      runId,
      turn: 1,
      system: "s",
      messages: [{ role: "user", content: big }],
      tools: [],
    });
    const [request] = await store.listRequests(runId);
    assert.ok(request !== undefined);
    assert.equal(request.inlineMessages, null);
    assert.ok(request.objectKey?.startsWith("requests/"));
    assert.equal(request.bytes, Buffer.byteLength(JSON.stringify([{ role: "user", content: big }]), "utf8"));
    const read = await recorder.readSpilled(request.objectKey!);
    assert.deepEqual(read, [{ role: "user", content: big }]);
  });

  test("5b. 没配对象存储时退化成内联（回放完整，记一条 warn）", async () => {
    const store = new MemorySessionStore();
    const warnings: string[] = [];
    const recorder = new RequestRecorder({
      store,
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });
    const { id: sessionId } = await store.createSession({ repoKey: "o/n", baseCommit: "a".repeat(40), cwd: "/w" });
    const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m" });
    const big = "x".repeat(300 * 1024);
    await recorder.record({ sessionId, runId, turn: 1, system: "s", messages: [{ role: "user", content: big }], tools: [] });
    const [request] = await store.listRequests(runId);
    assert.equal(request!.objectKey, null);
    assert.ok(request!.inlineMessages !== null);
    assert.equal(warnings.length, 1);
  });

  test("compiled_hash：相同输入相同、不同输入不同（P10 回放的前提）", async () => {
    const store = new MemorySessionStore();
    const recorder = new RequestRecorder({ store });
    const { id: sessionId } = await store.createSession({ repoKey: "o/n", baseCommit: "a".repeat(40), cwd: "/w" });
    const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m" });
    const input = { sessionId, runId, system: "同一个 system", messages: [{ role: "user" as const, content: "同一句话" }], tools: [] };
    await recorder.record({ ...input, turn: 1 });
    await recorder.record({ ...input, turn: 2 });
    await recorder.record({ ...input, turn: 3, system: "换了个 system" });
    const requests = await store.listRequests(runId);
    assert.equal(requests[0]!.compiledHash, requests[1]!.compiledHash);
    assert.notEqual(requests[0]!.compiledHash, requests[2]!.compiledHash);
  });
});
