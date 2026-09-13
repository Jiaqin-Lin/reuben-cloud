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
} from "@reuben-cloud/agent-runtime";
import type {
  AgentMessage,
  AssistantMessage,
  Content,
  ModelClient,
  ModelRequest,
} from "@reuben-cloud/agent-runtime";
import { SessionBusyError, SessionRuntime } from "../../src/agent/session-runtime.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import { createLazySandboxToolkit } from "../../src/agent/sandbox-operations.ts";
import type { ExecPort, SandboxFilesPort } from "../../src/agent/sandbox-operations.ts";
import type { FlushRequest, FlushResult, ProvisionedSandbox } from "../../src/session/sandbox-lease.ts";
import { SandboxLease } from "../../src/session/sandbox-lease.ts";
import { createSessionTurnRunner } from "../../src/session/session-run.ts";
import { REPO_DIR } from "@reuben-cloud/agent-runtime";

// ---------------------------------------------------------------- 脚本化模型

function textMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  const content: Content[] = [
    { type: "text", text: "先看一下" },
    { type: "toolCall", id, name, arguments: args },
  ];
  return { role: "assistant", content, stopReason: "toolUse", usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
}

/** 一个按脚本出牌的模型：每次 `stream()` 取下一步。脚本用完就一直重复最后一步。 */
function scriptedModel(steps: AssistantMessage[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let index = 0;
  const client = {
    provider: "scripted",
    model: "scripted-1",
    requests,
    stream(request: ModelRequest) {
      requests.push(request);
      const message = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
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

async function createHarness(steps: AssistantMessage[]) {
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
