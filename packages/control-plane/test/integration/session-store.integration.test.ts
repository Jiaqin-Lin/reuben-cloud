/**
 * Phase 2 的持久层集成测试（`npm run test:integration`，**需要一个一次性 Postgres 容器**）。
 *
 * 【它覆盖什么】spec P2 测试要点里"只有真库能回答"的那几条：
 *  1. 内存实现与 PG 实现跑**同一份契约**（`session-store-contract.ts`）——这是"双实现"的关键；
 *  2. `appendEntry` + usage 同事务（用 CHECK 约束在数据库层制造失败，看 entry 是不是也没了）；
 *  3. `seq` 的并发唯一性（bigserial + 真并发连接）；
 *  4. kill -9：工具执行中途杀 CP → 重启后那条 invocation 是 `intent`，且 args 查得到；
 *  5. 迁移可重跑（005 的新表 + 既有的幂等测试）。
 *
 * 单测那一层（`npm test`）不依赖任何外部资源，跑的是同一份契约的内存实现。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { PostgresSessionLock, PostgresSessionStore } from "../../src/session/postgres.ts";
import { SessionRuntime } from "../../src/agent/session-runtime.ts";
import { emptyUsage, entryForMessage } from "@reuben-cloud/agent-runtime";
import { startPostgres } from "../support.ts";
import type { TestPostgres } from "../support.ts";
import { sessionStoreContract } from "../../../agent-runtime/test/session-store-contract.ts";

let pg: TestPostgres;
let db: Db;
let store: PostgresSessionStore;
let seq = 0;

/** 清掉会话相关的表，让每个契约用例从一个干净的库开始（这个文件独占一个容器）。 */
async function reset(): Promise<void> {
  await db.query(
    "TRUNCATE sessions, runs, session_entries, tool_invocations, usage_ledger, model_requests CASCADE",
  );
}

async function newSession(): Promise<string> {
  const { id } = await store.createSession({
    repoKey: "owner/name",
    baseCommit: "a".repeat(40),
    cwd: "/workspace/repo",
  });
  return id;
}

before(async () => {
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
  store = new PostgresSessionStore(db);
});

after(async () => {
  await db.close();
  await pg.stop();
});

// 同一份契约：内存实现跑一遍，PG 实现跑另一遍（spec P2 测试要点 1）。
sessionStoreContract("Postgres 实现", {
  async create() {
    await reset();
    return store;
  },
});

describe("Phase 2 · Postgres 会话存储", () => {
  test("2. appendEntry + usage 同事务：用量被数据库拒绝时 entry 也不存在", async () => {
    await reset();
    const sessionId = await newSession();
    // `kind` 有 CHECK 约束（005 迁移）——一个非法的 kind 会让整个事务回滚。
    await assert.rejects(
      store.appendEntry(sessionId, null, entryForMessage({ role: "user", content: "hi" }), {
        usage: { kind: "bogus" as never, provider: "anthropic", model: "m", inputTokens: 1 },
      }),
      /usage_ledger_kind_check|violates check constraint/,
    );
    assert.deepEqual(await store.listEntries(sessionId), []);
    const usage = await db.query("SELECT count(*)::int AS n FROM usage_ledger");
    assert.equal(usage.rows[0]!.n, 0);
  });

  test("3b. 并发 append（真连接）：seq 唯一且单调", async () => {
    await reset();
    const sessionId = await newSession();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendEntry(sessionId, null, entryForMessage({ role: "user", content: `并发 ${index}` })),
      ),
    );
    const entries = await store.listEntries(sessionId);
    assert.equal(entries.length, 20);
    const seqs = entries.map((entry) => entry.seq);
    assert.equal(new Set(seqs).size, 20);
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(seqs[index]! > seqs[index - 1]!);
    }
  });

  test("4. kill -9：工具执行中途杀 CP → 重启后 invocation 是 intent，且 args 能查到", async () => {
    await reset();
    const sessionId = await newSession();
    const fixture = fileURLToPath(new URL("./fixtures/hang-after-intent.ts", import.meta.url));
    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, DATABASE_URL: pg.url, RC_TEST_SESSION_ID: sessionId },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const line = await firstLine(child, 30_000);
    const started = JSON.parse(line) as { runId: string; invocationId: string };
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    // 重启视角：父进程（另一个连接）读到的就是"崩溃之后留下的状态"。
    const intents = await store.listInvocations(started.runId, "intent");
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.id, started.invocationId);
    assert.equal(intents[0]!.tool, "bash");
    assert.deepEqual(intents[0]!.args, { command: "sleep 600", cwd: "/workspace/repo" });
    assert.ok(intents[0]!.resultEntryId !== null, "intent 时预留的结果 entry id 要在");
    // Run 停在 running：M2 不做恢复（M3 的入口），但状态必须如实。
    const runs = await store.listRuns(sessionId);
    assert.equal(runs[0]!.status, "running");
    assert.equal(runs[0]!.endedAt, null);
  });

  test("11b. 账本的归属字段：appendEntry 的 session/run/entry 都会补进 usage_ledger", async () => {
    await reset();
    const sessionId = await newSession();
    const runId = await store.startRun({ sessionId, startEntryId: null, provider: "anthropic", model: "m" });
    const entryId = await store.appendEntry(sessionId, runId, entryForMessage({ role: "assistant", content: [] }), {
      usage: { kind: "main", provider: "anthropic", model: "m", inputTokens: 10, outputTokens: 5 },
    });
    const rows = await db.query<{ session_id: string; run_id: string | null; entry_id: string | null; kind: string }>(
      "SELECT session_id, run_id, entry_id, kind FROM usage_ledger",
    );
    assert.deepEqual(rows.rows, [{ session_id: sessionId, run_id: runId, entry_id: entryId, kind: "main" }]);
  });

  test("8. 迁移可重跑：第二次全是 skipped", async () => {
    const report = await runMigrations(db);
    assert.deepEqual(report.applied, []);
    assert.ok(report.skipped.includes("005_agent_runtime.sql"));
  });

  test("005 的新表都在（六张 + sandboxes.session_id）", async () => {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const table of ["sessions", "runs", "session_entries", "tool_invocations", "usage_ledger", "model_requests"]) {
      assert.ok(names.has(table), `缺表：${table}`);
    }
    const column = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sandboxes' AND column_name = 'session_id'`,
    );
    assert.equal(column.rows.length, 1);
  });

  test("14b. 会话锁（PG 条件更新）：并发只有一次能抢到，第二个请求明确被拒", async () => {
    await reset();
    const sessionId = await newSession();
    const lock = new PostgresSessionLock(store);
    const runtime = new SessionRuntime({
      lock,
      newRunId: () => `run_lock_${(seq += 1)}`,
      start: async () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                stopReason: "end_turn",
                detail: "",
                turns: 1,
                toolCalls: 0,
                usage: emptyUsage(),
              }),
            80,
          );
        }),
    });

    const first = await runtime.handleUserMessage(sessionId, "第一句");
    await assert.rejects(runtime.handleUserMessage(sessionId, "第二句"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "session_busy");
      return true;
    });
    await first.result;
    // 跑完之后锁在数据库里也放掉了（不是只清了内存）。
    assert.equal((await store.getSession(sessionId))?.activeRunId, null);

    // 另一条"连接"看到的也是同一把锁：直接抢，抢不到（证明锁是真的在库里）。
    assert.equal(await store.acquireSessionLock(sessionId, "run_other"), true);
    assert.equal((await lock.acquire(sessionId, "run_third")).ok, false);
    await store.releaseSessionLock(sessionId, "run_other");
  });
});

// ---------------------------------------------------------------- 小工具

/** 读子进程的第一行 stdout（带超时）。 */
function firstLine(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`夹具在 ${timeoutMs}ms 内没有输出第一行`));
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(buffer.slice(0, newline));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (buffer.includes("\n")) return;
      clearTimeout(timer);
      reject(new Error(`夹具在输出第一行之前就退出了（exit ${code}）`));
    });
  });
}
