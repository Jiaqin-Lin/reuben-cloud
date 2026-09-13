/**
 * `session-store-contract.ts` —— `SessionStore` 的**契约测试体**（spec P2 测试要点 1）。
 *
 * 【为什么是一个函数而不是一个 .test.ts】两个实现（`MemorySessionStore` 与 CP 的
 * `PostgresSessionStore`）必须跑**同一份断言**——M0 对状态机双实现就是这么做的。
 * 这个文件不匹配 `test/*.test.ts` 的 glob，所以不会被单独跑；两个 .test.ts 各自
 * import 它、塞自己的实现进去。
 *
 * 【它断言什么】只断言**可观察行为**：id 的形状、顺序、事务边界、报错。不 assert
 * SQL、不 assert 内部字段——那正是"两个实现可以不同"的地方。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildContextEntries, entryForMessage } from "../src/session/entries.ts";
import type { SessionStore, StoredEntry } from "../src/session/store.ts";

export interface StoreFactory {
  /** 每个用例一个干净的库（PG 侧用独立的 schema/truncate；内存侧直接 new）。 */
  create(): Promise<SessionStore>;
  /** 这个实现自己知道怎么让"带 usage 的 appendEntry"失败（见测试 2）。 */
  breakUsageWrite?(store: SessionStore): Promise<void>;
}

export function sessionStoreContract(name: string, factory: StoreFactory): void {
  describe(`${name} · SessionStore 契约`, () => {
    async function newStore(): Promise<SessionStore> {
      return factory.create();
    }

    async function newSession(store: SessionStore): Promise<string> {
      const { id } = await store.createSession({
        repoKey: "owner/name",
        baseCommit: "a".repeat(40),
        cwd: "/workspace/repo",
        taskId: "issue-abc",
        headRef: "reuben-cloud/issue-abc",
        headCommit: null,
        title: "修一个 bug",
      });
      return id;
    }

    test("1. 建/读会话：字段与缺省值", async () => {
      const store = await newStore();
      const id = await newSession(store);
      const session = await store.getSession(id);
      assert.ok(session !== null);
      assert.equal(session.repoKey, "owner/name");
      assert.equal(session.baseCommit, "a".repeat(40));
      assert.equal(session.cwd, "/workspace/repo");
      assert.equal(session.taskId, "issue-abc");
      assert.equal(session.leafEntryId, null);
      assert.equal(session.sandboxId, null);
      assert.equal(session.sandboxLastUsedAt, null);
      assert.equal(session.sandboxFlushFailures, 0);
      assert.equal(session.activeRunId, null);
      assert.equal(await store.getSession("ses_不存在"), null);
    });

    test("2. appendEntry + usage 同事务：用量写不进去时 entry 也不存在（内存实现的故障注入）", async () => {
      if (factory.breakUsageWrite === undefined) return; // PG 侧在它自己的用例里注入（非法 kind）
      const store = await newStore();
      const sessionId = await newSession(store);
      await factory.breakUsageWrite(store);
      await assert.rejects(
        store.appendEntry(sessionId, null, entryForMessage({ role: "user", content: "hi" }), {
          usage: { kind: "main", provider: "anthropic", model: "claude-opus-4-8", inputTokens: 1 },
        }),
      );
      assert.deepEqual(await store.listEntries(sessionId), []);
    });

    test("3. 并发 append：seq 唯一且单调", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          store.appendEntry(sessionId, "run_1", entryForMessage({ role: "user", content: `第 ${index} 句` })),
        ),
      );
      const entries = await store.listEntries(sessionId);
      assert.equal(entries.length, 10);
      const seqs = entries.map((entry) => entry.seq);
      assert.equal(new Set(seqs).size, 10);
      for (let index = 1; index < seqs.length; index += 1) {
        assert.ok(seqs[index]! > seqs[index - 1]!);
      }
    });

    test("4. listEntries：afterSeq / beforeSeq / limit（limit 取尾部）", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        ids.push(await store.appendEntry(sessionId, "run_1", entryForMessage({ role: "user", content: `${index}` })));
      }
      const all = await store.listEntries(sessionId);
      assert.deepEqual(all.map((entry) => entry.id), ids);
      const tail = await store.listEntries(sessionId, { limit: 2 });
      assert.deepEqual(tail.map((entry) => entry.id), ids.slice(3));
      const after = await store.listEntries(sessionId, { afterSeq: all[1]!.seq });
      assert.deepEqual(after.map((entry) => entry.id), ids.slice(2));
      const before = await store.listEntries(sessionId, { beforeSeq: all[3]!.seq });
      assert.deepEqual(before.map((entry) => entry.id), ids.slice(0, 3));
    });

    test("5. 会话锁：条件更新（抢不到要给持有者）", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      assert.equal(await store.acquireSessionLock(sessionId, "run_1"), true);
      assert.equal(await store.acquireSessionLock(sessionId, "run_2"), false);
      assert.equal((await store.getSession(sessionId))?.activeRunId, "run_1");
      await store.releaseSessionLock(sessionId, "run_2"); // 不是持有者：什么都不该发生
      assert.equal((await store.getSession(sessionId))?.activeRunId, "run_1");
      await store.releaseSessionLock(sessionId, "run_1");
      assert.equal((await store.getSession(sessionId))?.activeRunId, null);
      assert.equal(await store.acquireSessionLock(sessionId, "run_2"), true);
    });

    test("6. 沙箱引用：attach / touch / 落地失败计数", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      const at = new Date("2026-09-13T10:00:00.000Z");
      await store.setSessionSandbox(sessionId, { sandboxId: "sbx_1", at });
      let session = await store.getSession(sessionId);
      assert.equal(session?.sandboxId, "sbx_1");
      assert.equal(session?.sandboxLastUsedAt?.toISOString(), at.toISOString());

      await store.touchSession(sessionId, new Date("2026-09-13T10:25:00.000Z"));
      session = await store.getSession(sessionId);
      assert.equal(session?.sandboxLastUsedAt?.toISOString(), "2026-09-13T10:25:00.000Z");

      await store.setSessionSandbox(sessionId, { flushFailures: 2, flushFailedAt: at });
      session = await store.getSession(sessionId);
      assert.equal(session?.sandboxFlushFailures, 2);
      assert.equal(session?.sandboxFlushFailedAt?.toISOString(), at.toISOString());

      await store.setSessionSandbox(sessionId, { sandboxId: null, flushFailures: 0, flushFailedAt: null });
      session = await store.getSession(sessionId);
      assert.equal(session?.sandboxId, null);
      assert.equal(session?.sandboxFlushFailures, 0);
      assert.equal(session?.sandboxFlushFailedAt, null);
    });

    test("7. updateSessionHead：只改显式给的键", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      await store.updateSessionHead(sessionId, { title: "新的标题" });
      let session = await store.getSession(sessionId);
      assert.equal(session?.title, "新的标题");
      assert.equal(session?.headRef, "reuben-cloud/issue-abc"); // 没动
      await store.updateSessionHead(sessionId, { leafEntryId: "ent_1", headCommit: "b".repeat(40) });
      session = await store.getSession(sessionId);
      assert.equal(session?.leafEntryId, "ent_1");
      assert.equal(session?.headCommit, "b".repeat(40));
      assert.equal(session?.title, "新的标题");
    });

    test("8. Run：start / end / list（按开始时间升序）", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      const first = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m1" });
      const second = await store.startRun({
        sessionId,
        startEntryId: "ent_1",
        provider: "deepseek",
        model: "m2",
        envRevision: "3",
      });
      let runs = await store.listRuns(sessionId);
      assert.deepEqual(runs.map((run) => run.id), [first, second]);
      assert.equal(runs[0]!.status, "running");
      await store.endRun(first, { status: "stopped", stopReason: "end_turn", endEntryId: "ent_2", sandboxId: "sbx_1" });
      runs = await store.listRuns(sessionId);
      assert.equal(runs[0]!.status, "stopped");
      assert.equal(runs[0]!.stopReason, "end_turn");
      assert.equal(runs[0]!.endEntryId, "ent_2");
      assert.equal(runs[0]!.sandboxId, "sbx_1");
      assert.ok(runs[0]!.endedAt !== null);
      assert.equal(runs[1]!.envRevision, "3");
    });

    test("9. 工具调用：intent → 结算用同一个 entry id；重复结算报错", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m" });
      const invocationId = await store.beginToolInvocation({
        sessionId,
        runId,
        turn: 1,
        sourceIndex: 0,
        tool: "read",
        args: { path: "a.ts" },
        replay: "safe",
      });
      let invocations = await store.listInvocations(runId);
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0]!.status, "intent");
      assert.equal(invocations[0]!.tool, "read");
      assert.equal(invocations[0]!.sourceIndex, 0);
      const reserved = invocations[0]!.resultEntryId;
      assert.ok(reserved !== null);

      const entryId = await store.settleToolInvocation(invocationId, {
        entry: entryForMessage({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false, timestamp: 0 }),
        isError: false,
        bytes: 12,
      });
      assert.equal(entryId, reserved);
      const entries = await store.listEntries(sessionId);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.id, reserved);
      invocations = await store.listInvocations(runId, "settled");
      assert.equal(invocations[0]!.isError, false);
      assert.equal(invocations[0]!.resultBytes, 12);

      await assert.rejects(
        store.settleToolInvocation(invocationId, {
          entry: entryForMessage({ role: "user", content: "again" }),
          isError: false,
          bytes: 0,
        }),
      );
    });

    test("10. 停在 intent 的调用可以被标记 interrupted（kill -9 之后可见）", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m" });
      const id = await store.beginToolInvocation({
        sessionId,
        runId,
        turn: 2,
        sourceIndex: 1,
        tool: "bash",
        args: { command: "sleep 100" },
        replay: "never",
      });
      await store.interruptInvocation(id);
      const intents = await store.listInvocations(runId, "intent");
      assert.equal(intents.length, 0);
      const all = await store.listInvocations(runId);
      assert.equal(all[0]!.status, "interrupted");
      assert.equal(all[0]!.turn, 2);
      assert.deepEqual(all[0]!.args, { command: "sleep 100" });
    });

    test("11. 编译产物：内联与按轮次取回", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m" });
      await store.recordRequest({
        sessionId,
        runId,
        turn: 2,
        compiledHash: "hash-2",
        sections: [{ name: "system", tokens: 10, hash: "s" }],
        system: "你是助手",
        toolsHash: "tools",
        inlineMessages: [{ role: "user", content: "hi" }],
        objectKey: null,
        bytes: 20,
      });
      await store.recordRequest({
        sessionId,
        runId,
        turn: 1,
        compiledHash: "hash-1",
        sections: [],
        system: "你是助手",
        toolsHash: "tools",
        inlineMessages: null,
        objectKey: "requests/x/1.json.gz",
        bytes: 300_000,
      });
      const requests = await store.listRequests(runId);
      assert.deepEqual(requests.map((request) => request.turn), [1, 2]);
      assert.equal(requests[0]!.objectKey, "requests/x/1.json.gz");
      assert.equal(requests[0]!.inlineMessages, null);
      assert.deepEqual(requests[1]!.inlineMessages, [{ role: "user", content: "hi" }]);
      assert.equal(requests[1]!.compiledHash, "hash-2");
    });

    test("12. 投影：压缩条目之后只留 firstKeptEntryId 起的那一段", async () => {
      const store = await newStore();
      const sessionId = await newSession(store);
      const kept: StoredEntry[] = [];
      for (let index = 0; index < 3; index += 1) {
        const id = await store.appendEntry(sessionId, "run_1", entryForMessage({ role: "user", content: `第 ${index} 句` }));
        kept.push((await store.listEntries(sessionId)).find((entry) => entry.id === id)!);
      }
      await store.appendEntry(sessionId, "run_1", {
        type: "compaction",
        payload: { summary: "前两句的摘要", firstKeptEntryId: kept[2]!.id, tokensBefore: 1234 },
        parentId: kept[2]!.id,
      });
      const projected = buildContextEntries(await store.listEntries(sessionId));
      assert.equal(projected.length, 2);
      assert.equal(projected[0]!.role, "compactionSummary");
      assert.deepEqual(projected[1], { role: "user", content: "第 2 句" });
    });

    test("13. 会话列表：按最近更新倒序", async () => {
      const store = await newStore();
      const first = await newSession(store);
      const second = await newSession(store);
      await store.updateSessionHead(first, { title: "动过了" });
      const sessions = await store.listSessions();
      assert.ok(sessions.length >= 2);
      assert.equal(sessions[0]!.id, first);
      assert.ok(sessions.some((session) => session.id === second));
    });
  });
}
