/**
 * Phase 2 · 一次会话执行的编排（不需要 Docker、不需要 PG、不需要模型）。
 *
 * 对应 spec P2 测试要点 9、10、11（沙箱那一半在 `sandbox-lease.test.ts`）、14、17：
 * 续轮上下文接得上、纯讨论不建沙箱、并发第二个请求被拒、轮次边界不重叠。
 *
 * 【手法】真实的东西是：循环（agent-runtime）、`EntryRecorder`、`SandboxLease`、
 * `MemorySessionStore`、`SessionRuntime` 的锁与插话。脚本化的是模型（它只产出事件）。
 * 这样"历史 / 记账 / 锁"这三件事是被直接验证的，而不是被一条假的编排验证。
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  MemorySessionStore,
  buildContextEntries,
  createAssistantMessageEventStream,
  entryForMessage,
} from "@reuben-cloud/agent-runtime";
import type {
  AgentMessage,
  AssistantMessage,
  Content,
  ModelClient,
  ModelRequest,
} from "@reuben-cloud/agent-runtime";
import { SessionBusyError, SessionRuntime } from "../../src/agent/session-runtime.ts";
import type { HubEvent, HubEventSink } from "../../src/agent/events.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import { createLazySandboxToolkit } from "../../src/agent/sandbox-operations.ts";
import type { ExecPort, SandboxFilesPort } from "../../src/agent/sandbox-operations.ts";
import type { FlushRequest, FlushResult, ProvisionedSandbox } from "../../src/session/sandbox-lease.ts";
import { SandboxLease } from "../../src/session/sandbox-lease.ts";
import { createSessionTurnRunner } from "../../src/session/session-run.ts";
import { RunHub } from "../../src/web/hub.ts";
import { startWebServer } from "../../src/web/server.ts";
import { REPO_DIR } from "@reuben-cloud/agent-runtime";

// ---------------------------------------------------------------- 脚本化模型

function textMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
}

function toolCallMessage(
  id: string,
  name: string,
  args: Record<string, unknown>,
  usage: AssistantMessage["usage"] = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
): AssistantMessage {
  const content: Content[] = [
    { type: "text", text: "先看一下" },
    { type: "toolCall", id, name, arguments: args },
  ];
  return { role: "assistant", content, stopReason: "toolUse", usage };
}

/**
 * 一个按脚本出牌的模型：每次 `stream()` 取下一步。脚本用完就一直重复最后一步。
 *
 * 【摘要请求不消耗主脚本】P3 的压缩请求靠 `cache: "none"` 认出来（它是唯一不写缓存的调用），
 * 直接回一条固定摘要——否则"第几步答什么"会被中间插进来的摘要请求整体错位。
 */
function scriptedModel(steps: AssistantMessage[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let index = 0;
  const client = {
    provider: "scripted",
    model: "scripted-1",
    requests,
    stream(request: ModelRequest) {
      requests.push(request);
      const summary = request.cache === "none";
      const message = summary ? textMessage("（脚本化的摘要）") : steps[Math.min(index, steps.length - 1)]!;
      if (!summary) index += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end(message);
      });
      return stream;
    },
  };
  return client;
}

// ---------------------------------------------------------------- 脚手架

async function createHarness(steps: AssistantMessage[], options: { events?: HubEventSink } = {}) {
  const store = new MemorySessionStore();
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-session-"));
  const model = scriptedModel(steps);
  const acquireCalls: string[] = [];
  const provisioned: ProvisionedSandbox = { sandboxId: "sbx_fake", endpoint: "http://sbx", authToken: "tok" };

  let sessions = 0;
  const lease = new SandboxLease({
    store,
    sandboxes: {
      async get() {
        return null;
      },
      async destroy() {
        /* 假的：这个文件不验证销毁 */
      },
    },
    provision: async () => {
      sessions += 1;
      return provisioned;
    },
    flush: async (_request: FlushRequest): Promise<FlushResult> => ({ changed: false, headCommit: null, headRef: null }),
    image: () => "img",
  });

  const acquire = async (): Promise<ProvisionedSandbox> => {
    acquireCalls.push("acquire");
    return lease.acquire(await sessionIdOf(), { runId: "run_unknown" });
  };
  let sessionIdForAcquire: string | null = null;
  const sessionIdOf = async (): Promise<string> => sessionIdForAcquire!;

  const toolkit = createLazySandboxToolkit({
    acquire: () => acquire(),
    // 这两个后端在这个文件里永远不会被碰到（用的工具是下面那个假的）。
    exec: {} as ExecPort,
    api: {} as SandboxFilesPort,
    repoDir: REPO_DIR,
  });

  const runner = createSessionTurnRunner({
    store,
    lease,
    model,
    tools: () => toolkit.tools,
    transcript: (runId) => Transcript.create({ runId, path: path.join(dir, `${runId}.jsonl`) }),
    // P4：观察窗出口（会话路径也要能把事件交给 hub）。
    ...(options.events === undefined ? {} : { events: options.events }),
  });

  const runtime = new SessionRuntime({ start: runner, newRunId: (() => { let n = 0; return () => `run_${++n}`; })() });

  return {
    store,
    model,
    runtime,
    runner,
    acquireCalls,
    toolkit,
    setSessionId(id: string) {
      sessionIdForAcquire = id;
    },
    async newSession(baseCommit = "a".repeat(40)) {
      const { id } = await store.createSession({
        repoKey: "owner/name",
        baseCommit,
        cwd: REPO_DIR,
        taskId: "issue-abc",
        headRef: "reuben-cloud/issue-abc",
        headCommit: baseCommit,
      });
      this.setSessionId(id);
      return id;
    },
  };
}

// ---------------------------------------------------------------- 用例

describe("Phase 2 · 会话执行编排", () => {
  test("观察窗（P4）：run_start 带 sessionId，循环事件按原样到达", async () => {
    const events: HubEvent[] = [];
    const sink: HubEventSink = { emit: (event) => void events.push(event) };
    const harness = await createHarness([textMessage("好的")], { events: sink });
    const sessionId = await harness.newSession();
    const handle = await harness.runtime.handleUserMessage(sessionId, "你好");
    await handle.result;

    // 会话视图靠 `run_start.sessionId` 找到这个会话的 entries（因此它必须真的有值）。
    const start = events.find((event) => event.type === "run_start");
    assert.equal(start?.type === "run_start" ? start.sessionId : null, sessionId);
    assert.equal(start?.type === "run_start" ? start.runId : null, handle.runId);
    // 循环的原生事件真的到了同一个出口（P4 起不再需要翻译层）。
    assert.ok(events.some((event) => event.type === "agent_start"));
    assert.ok(events.some((event) => event.type === "turn_start"));
    assert.ok(events.some((event) => event.type === "message_end" && event.message.role === "assistant"));
    assert.ok(events.some((event) => event.type === "run_end"));
  });

  test("观察窗（P4）：会话跑完一轮之后，会话视图与本次执行切片都能从 HTTP 读到", async () => {
    // 这一条把"产品路径"（会话编排 → 事件 → hub）与"观察窗的两个读接口"接起来验：
    // 单测已经分别盖住了两段，但"会话视图真的能看到这一轮"只有连起来才算证到。
    const hub = new RunHub({ textCoalesceMs: 0 });
    // 会话运行时生成的第一个 run id 就是 `run_1`（harness 的计数器从 1 起）。
    const harness = await createHarness([textMessage("好的")], { events: hub.ensure("run_1") });
    const sessionId = await harness.newSession();
    const handle = await harness.runtime.handleUserMessage(sessionId, "你好");
    await handle.result;
    assert.equal(handle.runId, "run_1");

    const server = await startWebServer({ hub, store: harness.store, port: 0, log: () => undefined });
    try {
      // 页面靠 `/info.sessionId` 找到会话视图（没有它就只能显示实时流）。
      const info = (await (await fetch(`${server.url}/runs/${handle.runId}/info`)).json()) as {
        sessionId: string | null;
        status: string;
      };
      assert.equal(info.sessionId, sessionId);
      assert.equal(info.status, "ended");

      const view = (await (await fetch(`${server.url}/sessions/${sessionId}/entries`)).json()) as {
        runs: Array<{ id: string; startEntryId: string | null; endEntryId: string | null; stopReason: string | null }>;
        entries: Array<{ id: string; runId: string | null; seq: number; payload: { role?: string } }>;
      };
      assert.equal(view.runs.length, 1);
      assert.equal(view.runs[0]!.id, handle.runId);
      // 第一轮没有上一条 leaf，所以 startEntryId 是 null；结束时停在 assistant 那条上。
      assert.equal(view.runs[0]!.startEntryId, null);
      assert.equal(view.runs[0]!.endEntryId, view.entries.at(-1)!.id);
      assert.equal(view.runs[0]!.stopReason, "end_turn");
      assert.deepEqual(
        view.entries.map((entry) => entry.payload.role),
        ["user", "assistant"],
      );
      assert.ok(view.entries.every((entry) => entry.runId === handle.runId));

      const transcript = (await (await fetch(`${server.url}/runs/${handle.runId}/transcript`)).json()) as {
        run: { id: string; sessionId: string };
        entries: Array<{ id: string }>;
      };
      assert.equal(transcript.run.sessionId, sessionId);
      assert.deepEqual(
        transcript.entries.map((entry) => entry.id),
        view.entries.map((entry) => entry.id),
      );
    } finally {
      await server.close();
    }
  });

  test("9/首轮：用户这句话进 entries，回答与用量一起落库，leaf 接上", async () => {
    const harness = await createHarness([textMessage("这段代码在做鉴权")]);
    const sessionId = await harness.newSession();
    const handle = await harness.runtime.handleUserMessage(sessionId, "这段代码干嘛的？");
    const outcome = await handle.result;
    assert.equal(outcome.ok, true);

    const entries = await harness.store.listEntries(sessionId);
    // 第一条是**模型真看到的那条**（首轮的任务书），第二条是 assistant 的回答。
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.type, "message");
    const first = entries[0]!.payload as AgentMessage;
    assert.equal(first.role, "user");
    assert.match((first as { content: string }).content, /这段代码干嘛的？/);
    assert.equal((entries[1]!.payload as { role?: string }).role, "assistant");
    // 用量与 assistant 的 entry 同事务落库（store 的契约），归属字段也由 store 补齐。
    const usage = harness.store.usageRows();
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.kind, "main");
    assert.equal(usage[0]!.entryId, entries[1]!.id);
    assert.equal(usage[0]!.sessionId, sessionId);

    const runs = await harness.store.listRuns(sessionId);
    assert.equal(runs.length, 1);
    // 账本的归属字段必须是 run 级的（P7 的成本看板按 run 汇总）。
    assert.equal(harness.store.usageRows()[0]!.runId, runs[0]!.id);
    assert.equal(runs[0]!.status, "stopped");
    assert.equal(runs[0]!.stopReason, "end_turn");
    assert.equal(runs[0]!.startEntryId, null);
    assert.equal(runs[0]!.endEntryId, entries[1]!.id);
    assert.equal((await harness.store.getSession(sessionId))?.leafEntryId, entries[1]!.id);
    assert.equal((await harness.store.getSession(sessionId))?.activeRunId, null);
    // 只有文字：一个沙箱都没建（spec 测试要点 10 的最小版本）。
    assert.deepEqual(harness.acquireCalls, []);
  });

  test("10. 20 句纯讨论 → 0 个容器", async () => {
    const harness = await createHarness([textMessage("好的，我明白你的意思了")]);
    const sessionId = await harness.newSession();
    for (let index = 0; index < 20; index += 1) {
      const handle = await harness.runtime.handleUserMessage(sessionId, `第 ${index + 1} 句讨论`);
      await handle.result;
    }
    assert.equal(harness.acquireCalls.length, 0);
    // 40 条 entry：20 条用户 + 20 条回答。
    assert.equal((await harness.store.listEntries(sessionId)).length, 40);
    assert.equal((await harness.store.listRuns(sessionId)).length, 20);
  });

  test("17. 续轮：第 2 句能看到第 1 句；两轮的 entry 区间不重叠", async () => {
    const harness = await createHarness([textMessage("第一句的回答"), textMessage("第二句的回答")]);
    const sessionId = await harness.newSession();

    const first = await harness.runtime.handleUserMessage(sessionId, "第一句");
    await first.result;
    const second = await harness.runtime.handleUserMessage(sessionId, "第二句");
    await second.result;

    const runs = await harness.store.listRuns(sessionId);
    assert.equal(runs.length, 2);
    // 第二轮的起点 = 第一轮的终点（leaf 接得上）。
    assert.equal(runs[1]!.startEntryId, runs[0]!.endEntryId);
    assert.equal(runs[0]!.startEntryId, null);

    // 第二轮请求里的 messages 含第一轮的两条 entry（结构化断言，不靠文本匹配）。
    const secondRequest = harness.model.requests[1]!;
    const contents = secondRequest.messages.map((message) => JSON.stringify(message));
    assert.ok(contents.some((text) => text.includes("第一句")));
    assert.ok(contents.some((text) => text.includes("第一句的回答")));
    assert.ok(contents.some((text) => text.includes("第二句")));

    // 投影出来 = 第一轮两条 + 第二轮两条。
    const projected = buildContextEntries(await harness.store.listEntries(sessionId));
    assert.equal(projected.length, 4);
    assert.deepEqual(
      projected.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
  });

  test("工具调用：先 intent，再结算成同一个 entry id；结果进历史", async () => {
    const harness = await createHarness([
      toolCallMessage("call_1", "bash", { command: "echo hi" }),
      textMessage("命令跑完了"),
    ]);
    const sessionId = await harness.newSession();
    // 换一个真的会跑的假工具（`bash` 执行 `echo`）。
    const tool = {
      name: "bash",
      label: "bash",
      description: "跑命令",
      parameters: { type: "object", properties: {}, additionalProperties: true } as never,
      executionMode: "sequential" as const,
      async execute() {
        return { content: [{ type: "text" as const, text: "hi\n" }], details: { exitCode: 0 } };
      },
    };
    const runner = createSessionTurnRunner({
      store: harness.store,
      lease: new SandboxLease({
        store: harness.store,
        sandboxes: { async get() { return null; }, async destroy() {} },
        provision: async () => ({ sandboxId: "sbx_1", endpoint: "http://x", authToken: "t" }),
        flush: async () => ({ changed: false, headCommit: null, headRef: null }),
        image: () => "img",
      }),
      model: harness.model,
      tools: () => [tool],
      transcript: (runId) => Transcript.create({ runId, path: path.join(os.tmpdir(), `rc-${runId}.jsonl`) }),
    });
    const handle = await runner({ runId: "run_x", sessionId, text: "跑一下 echo", steering: { push() {}, drain: () => [], get size() { return 0; } }, signal: new AbortController().signal });
    await handle;

    const runs = await harness.store.listRuns(sessionId);
    const invocations = await harness.store.listInvocations(runs[0]!.id);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]!.status, "settled");
    assert.equal(invocations[0]!.tool, "bash");
    assert.equal(invocations[0]!.turn, 1);
    assert.equal(invocations[0]!.sourceIndex, 0);
    assert.equal(invocations[0]!.isError, false);
    assert.ok((invocations[0]!.resultBytes ?? 0) > 0);

    const entries = await harness.store.listEntries(sessionId);
    const toolResult = entries.find(
      (entry) => (entry.payload as { role?: string }).role === "toolResult",
    );
    assert.ok(toolResult !== undefined);
    // 结算用的就是 intent 时预留的那个 entry id。
    assert.equal(toolResult!.id, invocations[0]!.resultEntryId);
  });

  test("14. 同一会话并发第二句：明确被拒（session_busy），且不是静默串行", async () => {
    const store = new MemorySessionStore();
    const { id: sessionId } = await store.createSession({
      repoKey: "owner/name",
      baseCommit: "a".repeat(40),
      cwd: REPO_DIR,
    });
    let release: (() => void) | null = null;
    const runtime = new SessionRuntime({
      start: async () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, stopReason: "end_turn", detail: "", turns: 1, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
        }),
      newRunId: (() => { let n = 0; return () => `run_${++n}`; })(),
    });
    const first = await runtime.handleUserMessage(sessionId, "第一句");
    await assert.rejects(runtime.handleUserMessage(sessionId, "第二句"), (error: unknown) => {
      assert.ok(error instanceof SessionBusyError);
      assert.equal(error.code, "session_busy");
      assert.equal(error.activeRunId, first.runId);
      return true;
    });
    release!();
    await first.result;
    // 第一句跑完，锁放开了，下一句能进。
    const third = await runtime.handleUserMessage(sessionId, "第三句");
    release!();
    await third.result;
  });

  test("19（P3）. 压缩在会话路径上生效：摘要条目落库、账本有 compaction 行、Run 正常收工", async () => {
    // usage 报"上下文 127.5k"（超过保守窗口 128k - 预留 1k），且历史真的有体积（有东西可压）。
    const harness = await createHarness([
      toolCallMessage("call_1", "bash", { command: "echo hi" }, {
        inputTokens: 127_500,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
      textMessage("收工"),
    ]);
    const sessionId = await harness.newSession();
    for (let index = 0; index < 6; index += 1) {
      await harness.store.appendEntry(sessionId, "run_seed", entryForMessage({ role: "user", content: `第 ${index} 轮：${"问".repeat(4000)}` }));
      await harness.store.appendEntry(
        sessionId,
        "run_seed",
        entryForMessage({ role: "assistant", content: [{ type: "text", text: `答：${"答".repeat(4000)}` }], stopReason: "stop" }),
      );
    }

    const tool = {
      name: "bash",
      label: "bash",
      description: "跑命令",
      parameters: { type: "object", properties: {}, additionalProperties: true } as never,
      executionMode: "sequential" as const,
      async execute() {
        return { content: [{ type: "text" as const, text: "hi\n" }], details: { exitCode: 0 } };
      },
    };
    const runner = createSessionTurnRunner({
      store: harness.store,
      lease: new SandboxLease({
        store: harness.store,
        sandboxes: { async get() { return null; }, async destroy() {} },
        provision: async () => ({ sandboxId: "sbx_1", endpoint: "http://x", authToken: "t" }),
        flush: async () => ({ changed: false, headCommit: null, headRef: null }),
        image: () => "img",
      }),
      model: harness.model,
      tools: () => [tool],
      transcript: (runId) => Transcript.create({ runId, path: path.join(os.tmpdir(), `rc-${runId}.jsonl`) }),
      compaction: { settings: { reserveTokens: 1000, keepRecentTokens: 100 } },
    });
    const outcome = await runner({
      runId: "run_p3",
      sessionId,
      text: "跑一下 echo",
      steering: { push() {}, drain: () => [], get size() { return 0; } },
      signal: new AbortController().signal,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.stopReason, "end_turn");
    const entries = await harness.store.listEntries(sessionId);
    const compactionEntries = entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactionEntries.length, 1);
    const payload = compactionEntries[0]!.payload as { firstKeptEntryId: string; tokensBefore: number };
    assert.ok(payload.tokensBefore > 127_000, `tokensBefore=${payload.tokensBefore}`);
    assert.ok(entries.some((entry) => entry.id === payload.firstKeptEntryId), "firstKeptEntryId 指向真实 entry");
    // 账本里有 compaction 行，且挂在这一次 Run 上。
    const ledger = harness.store.usageRows().filter((row) => row.kind === "compaction");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.runId, "run_p3");
    // 摘要请求不写 prompt cache。
    const summaryRequest = harness.model.requests.find((request) => request.cache === "none");
    assert.ok(summaryRequest !== undefined);
  });

  test("停止原因是模型失败时 run 记 failed（不是 stopped）", async () => {
    const harness = await createHarness([textMessage("", "error")]);
    const sessionId = await harness.newSession();
    const handle = await harness.runtime.handleUserMessage(sessionId, "会失败的一句");
    const outcome = await handle.result;
    assert.equal(outcome.ok, false);
    const runs = await harness.store.listRuns(sessionId);
    assert.equal(runs[0]!.status, "failed");
    assert.equal(runs[0]!.stopReason, "model_error");
  });
});
