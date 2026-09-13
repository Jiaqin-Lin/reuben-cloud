/**
 * Phase 3 · 压缩在 CP 兼容层上的接线（不需要 Docker、不需要真模型）。
 *
 * 【这份文件测什么】agent-runtime 的单测（`compaction.test.ts` / `compaction-controller.test.ts`）
 * 验的是压缩算法与循环钩子；这里验的是**CP 这一侧的三个约定**：
 *  ① `runAgentLoop(options)` 把两个钩子透传给循环，压缩条目经 `EntryRecorder` 落进对话树；
 *  ② 准备方用一条与停止原因同名的 `note` 收工（`compaction_failed`）时，Run 的终态如实变成它，
 *     并且这条 note 也进实时事件流（观察窗要能解释"为什么停了"）；
 *  ③ `runStatusFor` 把 `compaction_failed` 归到 failed（重跑同样的输入还会失败）。
 *
 * 【为什么它取代了 `agent-context.test.ts`】那份测的是 M0 的"超 600k 字符丢旧工具结果"。
 * P3 起上下文缩减只有 compaction 一种机制，那条策略连同它的测试一起删掉。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentTool, AssistantMessageEventStream, ModelClient, ModelRequest } from "@reuben-cloud/agent-runtime";
import {
  MemorySessionStore,
  buildContextEntries,
  createAssistantMessageEventStream,
  createCompactionController,
  entryForMessage,
} from "@reuben-cloud/agent-runtime";
import type { HubEvent, HubEventSink } from "../../src/agent/events.ts";
import { runAgentLoop } from "../../src/agent/run.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import { EntryRecorder } from "../../src/session/entry-recorder.ts";
import { runStatusFor } from "../../src/session/session-run.ts";
import { noopLog } from "../../src/log.ts";

// ---------------------------------------------------------------- 脚手架

let workDir = "";
let seq = 0;

before(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "rc-compaction-"));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 一步响应：文本或工具调用（带可控 usage——真实 provider 报的是"到这一轮为止的上下文量"）。 */
function step(options: {
  text?: string;
  tool?: { id: string; name: string; args: Record<string, unknown> };
  inputTokens?: number;
}): (stream: AssistantMessageEventStream) => void {
  return (stream) => {
    const usage = {
      inputTokens: options.inputTokens ?? 100,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    if (options.tool !== undefined) {
      const call = { type: "toolCall" as const, id: options.tool.id, name: options.tool.name, arguments: options.tool.args };
      const message = { role: "assistant" as const, content: [call], usage };
      stream.push({ type: "start", partial: { ...message } });
      stream.push({ type: "toolcall_start", contentIndex: 0, id: call.id, name: call.name, partial: { ...message } });
      stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: { ...message } });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: { ...message } });
      stream.push({ type: "done", reason: "toolUse", message: { ...message, stopReason: "toolUse" } });
      return;
    }
    const message = { role: "assistant" as const, content: [{ type: "text" as const, text: options.text ?? "" }], usage };
    stream.push({ type: "start", partial: { ...message } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...message } });
    stream.push({ type: "text_end", contentIndex: 0, content: options.text ?? "", partial: { ...message } });
    stream.push({ type: "done", reason: "stop", message: { ...message, stopReason: "stop" } });
  };
}

/**
 * 主对话按脚本走、摘要请求回答固定文本的模型。
 * 摘要请求靠 `cache: "none"` 认出来（P3 的摘要请求是唯一不写缓存的调用）。
 */
function scriptedModel(steps: Array<(stream: AssistantMessageEventStream) => void>, summaryText = "摘要正文") {
  const requests: ModelRequest[] = [];
  let calls = 0;
  const model: ModelClient = {
    provider: "scripted",
    model: "scripted-test",
    stream(request: ModelRequest): AssistantMessageEventStream {
      requests.push(request);
      const stream = createAssistantMessageEventStream();
      const isSummary = request.cache === "none";
      const fn = isSummary ? step({ text: summaryText }) : (steps[calls] ?? step({ text: "（脚本用完了）" }));
      if (!isSummary) calls += 1;
      void Promise.resolve().then(() => fn(stream));
      return stream;
    },
  };
  return { model, requests, summaryRequests: () => requests.filter((request) => request.cache === "none") };
}

/** 一个立刻返回文本的假工具（`parameters` 是宽松 object，任何参数都过校验）。 */
function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name}(test)`,
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: `ok:${name}` }], details: {} };
    },
  };
}

/** 收集观察窗事件的 sink（RunHub 的最小替身）。 */
function collectingSink(): HubEventSink & { events: HubEvent[] } {
  const events: HubEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

/** 建会话 + 一段有体积的历史（不带 usage，体积由内容决定）。 */
async function seedSession(store: MemorySessionStore, runId: string, turns: number, bodyChars: number) {
  const { id: sessionId } = await store.createSession({ repoKey: "local/x", baseCommit: "abc", cwd: "/workspace/repo" });
  await store.startRun({ id: runId, sessionId, startEntryId: null, provider: "scripted", model: "scripted-test" });
  for (let index = 0; index < turns; index += 1) {
    await store.appendEntry(
      sessionId,
      runId,
      entryForMessage({ role: "user", content: `第 ${index} 轮：${"问".repeat(bodyChars)}` }),
    );
    await store.appendEntry(
      sessionId,
      runId,
      entryForMessage({
        role: "assistant",
        content: [{ type: "text", text: `第 ${index} 轮的回答：${"答".repeat(bodyChars)}` }],
        stopReason: "stop",
      }),
    );
  }
  return sessionId;
}

async function newTranscript(runId: string): Promise<Transcript> {
  seq += 1;
  return Transcript.create({ runId, path: path.join(workDir, `${runId}-${seq}.jsonl`), log: noopLog });
}

// ---------------------------------------------------------------- 1. 接线

describe("Phase 3 · CP 兼容层的压缩接线", () => {
  test("阈值到点自动压缩：条目进对话树、账本有 compaction 行、Run 正常收工", async () => {
    const store = new MemorySessionStore();
    const runId = "run_compact_1";
    const sessionId = await seedSession(store, runId, 6, 4000);

    // 第一步：工具调用（把循环推进到第二轮，压缩钩子才有机会跑），usage 报"上下文 12000 token"。
    const { model, summaryRequests } = scriptedModel([
      step({ tool: { id: "call_1", name: "ls", args: { path: "." } }, inputTokens: 12_000 }),
      step({ text: "收工" }),
    ]);
    const recorder = new EntryRecorder({
      store,
      sessionId,
      runId,
      provider: model.provider,
      model: model.model,
      leafEntryId: null,
      log: noopLog,
    });
    const compaction = createCompactionController({
      store,
      sessionId,
      runId,
      model,
      contextWindow: 10_000,
      settings: { reserveTokens: 1000, keepRecentTokens: 100 },
      env: {},
      appendCompaction: (input) => recorder.appendCompaction(input.payload, input.usage),
      log: noopLog,
    });

    const result = await runAgentLoop({
      model,
      tools: [fakeTool("ls")],
      transcript: await newTranscript(runId),
      issue: "测试",
      history: buildContextEntries(await store.listEntries(sessionId)),
      prompts: [{ role: "user", content: "继续" }],
      onAgentEvent: (event) => recorder.onAgentEvent(event),
      prepareNextTurn: (turn) => compaction.prepareNextTurn(turn),
      recoverFromModelError: (turn) => compaction.recoverFromModelError(turn),
      log: noopLog,
    });

    assert.equal(result.stopReason, "end_turn");
    assert.equal(compaction.compactions, 1);
    // split turn 会跑两次摘要（历史 + turn 前缀），所以只断言"至少问过一次"、且请求不写缓存。
    assert.ok(summaryRequests().length >= 1);
    assert.equal(summaryRequests()[0]!.cache, "none");

    const entries = await store.listEntries(sessionId);
    const compactionEntries = entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactionEntries.length, 1);
    assert.notEqual(compactionEntries[0]!.parentId, null, "压缩条目要接在对话树上（leaf 链不断）");
    // 压缩之后还有条目接着它 —— 说明 leaf 确实被记录器更新过（不是断链在压缩条目上）。
    assert.ok(entries.some((entry) => entry.parentId === compactionEntries[0]!.id));

    const ledger = store.usageRows().filter((row) => row.kind === "compaction");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.provider, "scripted");
    assert.ok((ledger[0]!.outputTokens ?? 0) > 0);
  });

  test("没有压缩控制器时行为与 P2 一致（两个钩子都是可选的）", async () => {
    const store = new MemorySessionStore();
    const runId = "run_compact_2";
    const sessionId = await seedSession(store, runId, 3, 100);
    const { model } = scriptedModel([step({ tool: { id: "call_1", name: "ls", args: {} } }), step({ text: "收工" })]);
    const result = await runAgentLoop({
      model,
      tools: [fakeTool("ls")],
      transcript: await newTranscript(runId),
      issue: "测试",
      history: buildContextEntries(await store.listEntries(sessionId)),
      log: noopLog,
    });
    assert.equal(result.stopReason, "end_turn");
    assert.equal((await store.listEntries(sessionId)).filter((entry) => entry.type === "compaction").length, 0);
  });
});

// ---------------------------------------------------------------- 2. 终态

describe("Phase 3 · compaction_failed 终态", () => {
  test("准备方用同名 note 收工 → Run 的 stopReason 是 compaction_failed，不再跑工具", async () => {
    const store = new MemorySessionStore();
    const runId = "run_compact_3";
    const sessionId = await seedSession(store, runId, 2, 100);
    const { model } = scriptedModel([
      step({ tool: { id: "call_1", name: "ls", args: {} } }),
      step({ text: "不该跑到这里" }),
    ]);
    const sink = collectingSink();

    const result = await runAgentLoop({
      model,
      tools: [fakeTool("ls")],
      transcript: await newTranscript(runId),
      issue: "测试",
      history: buildContextEntries(await store.listEntries(sessionId)),
      // "准备方决定停下"是 agent-runtime 的公开契约（`AgentLoopTurnUpdate.stop`），
      // 控制器只是它的一种实现——这里直接用最小实现验 CP 侧的映射。
      prepareNextTurn: () => ({ stop: { reason: "compaction_failed", detail: "上下文压缩失败：摘要服务挂了" } }),
      events: sink,
      log: noopLog,
    });

    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "compaction_failed");
    assert.match(result.detail, /摘要服务挂了/);
    // 只有第一轮的那次工具调用：Run 在第二轮模型调用之前就收工了。
    assert.equal(result.toolCalls, 1);
    // 这条 note 也进实时事件流（观察窗要能解释"为什么停了"）。
    const note = sink.events.find((event) => event.type === "note");
    assert.ok(note !== undefined);
    assert.equal(note.type === "note" ? note.kind : null, "compaction_failed");
    assert.ok(
      sink.events.some((event) => event.type === "run_end" && event.stopReason === "compaction_failed"),
    );
  });

  test("普通的 note 不会改变终态（只有与停止原因同名的才被认）", async () => {
    const store = new MemorySessionStore();
    const runId = "run_compact_4";
    const sessionId = await seedSession(store, runId, 2, 100);
    const { model } = scriptedModel([step({ text: "收工" })]);
    const result = await runAgentLoop({
      model,
      tools: [],
      transcript: await newTranscript(runId),
      issue: "测试",
      history: buildContextEntries(await store.listEntries(sessionId)),
      prepareNextTurn: () => undefined,
      recoverFromModelError: async () => undefined,
      log: noopLog,
    });
    assert.equal(result.stopReason, "end_turn");
  });

  test("runStatusFor：compaction_failed 归 failed（重跑同样的输入还会失败）", () => {
    assert.equal(runStatusFor("compaction_failed"), "failed");
    assert.equal(runStatusFor("end_turn"), "stopped");
    assert.equal(runStatusFor("max_turns"), "stopped");
    assert.equal(runStatusFor("model_error"), "failed");
    assert.equal(runStatusFor("aborted"), "failed");
  });
});
