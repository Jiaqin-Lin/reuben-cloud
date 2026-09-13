/**
 * `session/postgres.ts` —— `SessionStore` 的 Postgres 实现（Phase 2；spec P2 §2/§3）。
 *
 * 【`pg` 只出现在这里】spec §0.3 的硬约束：agent-runtime 是纯决策层，存储用接口注入。
 * 这个文件是那个接口的生产实现——SQL 全在这一层（看得见、可解释），agent-runtime
 * 一行都不知道表长什么样。
 *
 * 【两个事务边界，一个都不能省】
 *  ① `appendEntry` + `usage`：entry 与用量同生共死（pi 的规矩，spec 测试要点 2）。
 *     分成两次调用的话，"用量写失败"会留下一条模型能看到、账本却没有的对话。
 *  ② `settleToolInvocation`：结果 entry 与 intent → settled 的推进同一个事务。
 *     崩在中间时宁可停在 intent（M3 能认出来），也不要"有结果 entry、调用还是 intent"
 *     这种自相矛盾的状态。
 *
 * 【为什么 leaf 不在 appendEntry 里顺手更新】leaf 的语义是"这一轮停在哪"，由编排在
 * 结束时一次性写清（`updateSessionHead`）。写一半崩掉时，leaf 停在上一轮是**可解释**的
 * （下次从那里重来）；跟着每条 entry 走的话，崩溃会留下一个"半句话的 leaf"。
 *
 * 【为什么抢锁是一条 UPDATE 而不是"先查后写"】check-then-act 在并发下必然出错
 * （两个请求都查到 NULL）。`UPDATE … WHERE active_run_id IS NULL` 的 rowCount
 * 就是"抢到没抢到"的答案，不需要额外的事务或 advisory lock。
 */

import type { Db, Queryable } from "../db/client.ts";
import { many, maybeOne, one } from "../db/client.ts";
import { prefixedId } from "../ulid.ts";
import type { SessionLock, SessionLockResult } from "../agent/session-runtime.ts";
import type {
  EndRunPatch,
  InvocationSettlement,
  InvocationStatus,
  ListEntriesOptions,
  ListSessionsOptions,
  NewEntry,
  NewInvocation,
  NewRequest,
  NewRun,
  NewSession,
  ReplayPolicy,
  RunStatus,
  SessionHeadPatch,
  SessionRef,
  SessionSandboxPatch,
  SessionStore,
  StoredEntry,
  StoredInvocation,
  StoredRequest,
  StoredRun,
  StoredSession,
  UsageRow,
} from "@reuben-cloud/agent-runtime";

// ---------------------------------------------------------------- 行映射

/** 一行 sessions（snake_case 与 005 迁移一致）。 */
export interface SessionRow {
  id: string;
  task_id: string | null;
  repo_key: string;
  base_commit: string;
  head_ref: string | null;
  head_commit: string | null;
  cwd: string;
  title: string | null;
  leaf_entry_id: string | null;
  sandbox_id: string | null;
  sandbox_last_used_at: Date | null;
  sandbox_flush_failures: number;
  sandbox_flush_failed_at: Date | null;
  active_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EntryRow {
  id: string;
  session_id: string;
  run_id: string | null;
  parent_id: string | null;
  seq: number;
  type: StoredEntry["type"];
  payload: unknown;
  created_at: Date;
}

export interface RunRow {
  id: string;
  session_id: string;
  sandbox_id: string | null;
  start_entry_id: string | null;
  end_entry_id: string | null;
  provider: string;
  model: string;
  env_revision: string | null;
  status: RunStatus;
  stop_reason: string | null;
  started_at: Date;
  ended_at: Date | null;
}

export interface InvocationRow {
  id: string;
  session_id: string;
  run_id: string;
  turn: number;
  source_index: number;
  tool: string;
  args: unknown;
  replay: ReplayPolicy;
  status: InvocationStatus;
  result_entry_id: string | null;
  is_error: boolean | null;
  result_bytes: number | null;
  started_at: Date;
  ended_at: Date | null;
}

export interface RequestRow {
  id: string;
  session_id: string;
  run_id: string;
  turn: number;
  compiled_hash: string;
  sections: unknown;
  system: string;
  tools_hash: string;
  usage_id: string | null;
  inline_messages: unknown;
  object_key: string | null;
  bytes: number;
  at: Date;
}

function mapSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    taskId: row.task_id,
    repoKey: row.repo_key,
    baseCommit: row.base_commit,
    headRef: row.head_ref,
    headCommit: row.head_commit,
    cwd: row.cwd,
    title: row.title,
    leafEntryId: row.leaf_entry_id,
    sandboxId: row.sandbox_id,
    sandboxLastUsedAt: row.sandbox_last_used_at,
    sandboxFlushFailures: row.sandbox_flush_failures,
    sandboxFlushFailedAt: row.sandbox_flush_failed_at,
    activeRunId: row.active_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntry(row: EntryRow): StoredEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    parentId: row.parent_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

function mapRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    sandboxId: row.sandbox_id,
    startEntryId: row.start_entry_id,
    endEntryId: row.end_entry_id,
    provider: row.provider,
    model: row.model,
    envRevision: row.env_revision,
    status: row.status,
    stopReason: row.stop_reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapInvocation(row: InvocationRow): StoredInvocation {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    turn: row.turn,
    sourceIndex: row.source_index,
    tool: row.tool,
    args: row.args,
    replay: row.replay,
    status: row.status,
    resultEntryId: row.result_entry_id,
    isError: row.is_error,
    resultBytes: row.result_bytes,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapRequest(row: RequestRow): StoredRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    turn: row.turn,
    compiledHash: row.compiled_hash,
    sections: row.sections as StoredRequest["sections"],
    system: row.system,
    toolsHash: row.tools_hash,
    usageId: row.usage_id,
    inlineMessages: row.inline_messages,
    objectKey: row.object_key,
    bytes: row.bytes,
    at: row.at,
  };
}

// ---------------------------------------------------------------- 实现

/**
 * 会话存储的 PG 实现。
 *
 * 【为什么 id 由 CP 生成而不是数据库】与既有三张表一致（`sbx_` / `exe_` / `art_`）：
 * 前缀是业务含义，ULID 是时间有序。`gen_random_uuid()` 拿不到这两条。
 */
export class PostgresSessionStore implements SessionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // -------------------------------------------------------------- 会话

  async createSession(input: NewSession): Promise<SessionRef> {
    const id = prefixedId("ses");
    await one<SessionRow>(
      this.#db,
      `INSERT INTO sessions (id, task_id, repo_key, base_commit, head_ref, head_commit, cwd, title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.taskId ?? null,
        input.repoKey,
        input.baseCommit,
        input.headRef ?? null,
        input.headCommit ?? null,
        input.cwd,
        input.title ?? null,
      ],
    );
    return { id };
  }

  async getSession(sessionId: string): Promise<StoredSession | null> {
    const row = await maybeOne<SessionRow>(this.#db, "SELECT * FROM sessions WHERE id = $1", [sessionId]);
    return row === null ? null : mapSession(row);
  }

  /**
   * 更新会话的 head 字段。**只更新调用方显式给的键**——`undefined` 是"别动"，
   * `null` 是"清空"。合成一个 COALESCE 会把这两种意图混成一种。
   */
  async updateSessionHead(sessionId: string, patch: SessionHeadPatch): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [sessionId];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (patch.leafEntryId !== undefined) set("leaf_entry_id", patch.leafEntryId);
    if (patch.headRef !== undefined) set("head_ref", patch.headRef);
    if (patch.headCommit !== undefined) set("head_commit", patch.headCommit);
    if (patch.title !== undefined) set("title", patch.title);
    assignments.push("updated_at = now()");
    await this.#db.query(`UPDATE sessions SET ${assignments.join(", ")} WHERE id = $1`, values);
  }

  async listSessions(opts: ListSessionsOptions = {}): Promise<StoredSession[]> {
    const rows = await many<SessionRow>(
      this.#db,
      `SELECT * FROM sessions
        WHERE ($1::timestamptz IS NULL OR updated_at < $1)
        ORDER BY updated_at DESC, id
        LIMIT $2`,
      [opts.before ?? null, opts.limit ?? 100],
    );
    return rows.map(mapSession);
  }

  async setSessionSandbox(sessionId: string, patch: SessionSandboxPatch): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [sessionId];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if ("sandboxId" in patch) set("sandbox_id", patch.sandboxId ?? null);
    if ("at" in patch) {
      values.push(patch.at ?? null);
      assignments.push(`sandbox_last_used_at = COALESCE($${values.length}::timestamptz, now())`);
    }
    if (patch.flushFailures !== undefined) set("sandbox_flush_failures", patch.flushFailures);
    if ("flushFailedAt" in patch) set("sandbox_flush_failed_at", patch.flushFailedAt ?? null);
    if (assignments.length === 0) return;
    assignments.push("updated_at = now()");
    await this.#db.query(`UPDATE sessions SET ${assignments.join(", ")} WHERE id = $1`, values);
  }

  async touchSession(sessionId: string, at?: Date): Promise<void> {
    await this.#db.query(
      "UPDATE sessions SET sandbox_last_used_at = COALESCE($2::timestamptz, now()), updated_at = now() WHERE id = $1",
      [sessionId, at ?? null],
    );
  }

  async acquireSessionLock(sessionId: string, runId: string): Promise<boolean> {
    const rows = await many<{ id: string }>(
      this.#db,
      `UPDATE sessions SET active_run_id = $2, updated_at = now()
        WHERE id = $1 AND active_run_id IS NULL
        RETURNING id`,
      [sessionId, runId],
    );
    return rows.length === 1;
  }

  async releaseSessionLock(sessionId: string, runId: string): Promise<void> {
    await this.#db.query(
      "UPDATE sessions SET active_run_id = NULL, updated_at = now() WHERE id = $1 AND active_run_id = $2",
      [sessionId, runId],
    );
  }

  // -------------------------------------------------------------- 对话树

  async appendEntry(
    sessionId: string,
    runId: string | null,
    entry: NewEntry,
    opts: { usage?: UsageRow } = {},
  ): Promise<string> {
    const id = entry.id ?? prefixedId("ent");
    return this.#db.withTransaction(async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO session_entries (id, session_id, run_id, parent_id, type, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [id, sessionId, runId, entry.parentId ?? null, entry.type, JSON.stringify(entry.payload ?? null)],
      );
      // 用量与 entry 同生共死：这一句抛异常时整个事务回滚（entry 也不存在）。
      // `session_id` / `run_id` / `entry_id` 三个归属字段在没显式给时都从 appendEntry 的参数补——
      // 调用方（`EntryRecorder`）只关心 token 数与 kind，归属是这一层的事实。
      if (opts.usage !== undefined) {
        await insertUsage(tx, {
          ...opts.usage,
          sessionId: opts.usage.sessionId ?? sessionId,
          runId: opts.usage.runId ?? runId,
          entryId: opts.usage.entryId ?? id,
        });
      }
      return row.id;
    });
  }

  async listEntries(sessionId: string, opts: ListEntriesOptions = {}): Promise<StoredEntry[]> {
    // `LIMIT NULL` 在 Postgres 里就是"不限制"；外层再按 seq 升序排回来（内层取的是尾部 N 条）。
    const rows = await many<EntryRow>(
      this.#db,
      `SELECT * FROM (
         SELECT * FROM session_entries
          WHERE session_id = $1
            AND ($2::bigint IS NULL OR seq > $2)
            AND ($3::bigint IS NULL OR seq < $3)
          ORDER BY seq DESC
          LIMIT $4
       ) AS tail
       ORDER BY seq ASC`,
      [sessionId, opts.afterSeq ?? null, opts.beforeSeq ?? null, opts.limit ?? null],
    );
    return rows.map(mapEntry);
  }

  // -------------------------------------------------------------- Run

  async startRun(input: NewRun): Promise<string> {
    const id = input.id ?? prefixedId("run");
    await one<RunRow>(
      this.#db,
      `INSERT INTO runs (id, session_id, sandbox_id, start_entry_id, provider, model, env_revision, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')
       RETURNING *`,
      [
        id,
        input.sessionId,
        input.sandboxId ?? null,
        input.startEntryId,
        input.provider,
        input.model,
        input.envRevision ?? null,
      ],
    );
    return id;
  }

  async endRun(runId: string, patch: EndRunPatch): Promise<void> {
    const rows = await many<{ id: string }>(
      this.#db,
      `UPDATE runs
          SET status = $2, stop_reason = $3, end_entry_id = $4,
              sandbox_id = COALESCE($5, sandbox_id), ended_at = now()
        WHERE id = $1
        RETURNING id`,
      [runId, patch.status, patch.stopReason, patch.endEntryId, patch.sandboxId ?? null],
    );
    if (rows.length === 0) throw new Error(`执行不存在：${runId}`);
  }

  async listRuns(sessionId: string): Promise<StoredRun[]> {
    const rows = await many<RunRow>(
      this.#db,
      "SELECT * FROM runs WHERE session_id = $1 ORDER BY started_at ASC, id",
      [sessionId],
    );
    return rows.map(mapRun);
  }

  // -------------------------------------------------------------- 工具调用

  async beginToolInvocation(inv: NewInvocation): Promise<string> {
    const id = inv.id ?? prefixedId("inv");
    const resultEntryId = inv.resultEntryId ?? prefixedId("ent");
    await one<InvocationRow>(
      this.#db,
      `INSERT INTO tool_invocations
         (id, session_id, run_id, turn, source_index, tool, args, replay, status, result_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'intent', $9)
       RETURNING *`,
      [
        id,
        inv.sessionId,
        inv.runId,
        inv.turn,
        inv.sourceIndex,
        inv.tool,
        JSON.stringify(inv.args ?? null),
        inv.replay,
        resultEntryId,
      ],
    );
    return id;
  }

  async settleToolInvocation(id: string, result: InvocationSettlement): Promise<string> {
    return this.#db.withTransaction(async (tx) => {
      // FOR UPDATE：两个并发的结算只有一个能推进（另一个看到 settled 后抛错）。
      const row = await maybeOne<InvocationRow>(tx, "SELECT * FROM tool_invocations WHERE id = $1 FOR UPDATE", [id]);
      if (row === null) throw new Error(`工具调用不存在：${id}`);
      if (row.status !== "intent") throw new Error(`工具调用 ${id} 已经结算过（${row.status}）`);
      // 结果 entry 的 id **必须**是 intent 时预留的那个（设计文档 §G.3）。
      const entryId = result.entry.id ?? row.result_entry_id ?? prefixedId("ent");
      await one<{ id: string }>(
        tx,
        `INSERT INTO session_entries (id, session_id, run_id, parent_id, type, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [
          entryId,
          row.session_id,
          row.run_id,
          result.entry.parentId ?? null,
          result.entry.type,
          JSON.stringify(result.entry.payload ?? null),
        ],
      );
      await tx.query(
        `UPDATE tool_invocations
            SET status = 'settled', is_error = $2, result_bytes = $3, result_entry_id = $4, ended_at = now()
          WHERE id = $1`,
        [id, result.isError, result.bytes, entryId],
      );
      return entryId;
    });
  }

  async interruptInvocation(id: string): Promise<void> {
    await this.#db.query(
      "UPDATE tool_invocations SET status = 'interrupted', ended_at = now() WHERE id = $1 AND status = 'intent'",
      [id],
    );
  }

  async listInvocations(runId: string, status?: InvocationStatus): Promise<StoredInvocation[]> {
    const rows = await many<InvocationRow>(
      this.#db,
      `SELECT * FROM tool_invocations
        WHERE run_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY turn, source_index, id`,
      [runId, status ?? null],
    );
    return rows.map(mapInvocation);
  }

  // -------------------------------------------------------------- 用量与编译产物

  async recordUsage(row: UsageRow): Promise<void> {
    await insertUsage(this.#db, row);
  }

  async recordRequest(row: NewRequest): Promise<void> {
    await one<RequestRow>(
      this.#db,
      `INSERT INTO model_requests
         (id, session_id, run_id, turn, compiled_hash, sections, system, tools_hash, usage_id,
          inline_messages, object_key, bytes, at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12, COALESCE($13::timestamptz, now()))
       RETURNING *`,
      [
        row.id ?? prefixedId("req"),
        row.sessionId,
        row.runId,
        row.turn,
        row.compiledHash,
        JSON.stringify(row.sections ?? []),
        row.system,
        row.toolsHash,
        row.usageId ?? null,
        row.inlineMessages === undefined || row.inlineMessages === null
          ? null
          : JSON.stringify(row.inlineMessages),
        row.objectKey ?? null,
        row.bytes,
        row.at ?? null,
      ],
    );
  }

  async listRequests(runId: string): Promise<StoredRequest[]> {
    const rows = await many<RequestRow>(
      this.#db,
      "SELECT * FROM model_requests WHERE run_id = $1 ORDER BY turn, at",
      [runId],
    );
    return rows.map(mapRequest);
  }
}

// ---------------------------------------------------------------- 共用的插入

// ---------------------------------------------------------------- 会话锁

/**
 * `SessionLock` 的 PG 实现（Phase 2 §5 步①）：把"抢锁"落到一条条件更新上。
 *
 * 【为什么抢不到还要再查一次】锁的失败路径只在"同一会话并发第二次请求"时走，
 * 多一次 SELECT 换来的是日志与 409 正文里能写出"谁在跑"——排障时这个信息很值。
 */
export class PostgresSessionLock implements SessionLock {
  readonly #store: PostgresSessionStore;

  constructor(store: PostgresSessionStore) {
    this.#store = store;
  }

  async acquire(sessionId: string, runId: string): Promise<SessionLockResult> {
    if (await this.#store.acquireSessionLock(sessionId, runId)) return { ok: true };
    const session = await this.#store.getSession(sessionId);
    return { ok: false, activeRunId: session?.activeRunId ?? null };
  }

  async release(sessionId: string, runId: string): Promise<void> {
    await this.#store.releaseSessionLock(sessionId, runId);
  }
}

// ---------------------------------------------------------------- 共用的插入

/** 账本插入。`appendEntry` 的事务里也用它（`Queryable` 同时覆盖池与事务）。 */
export async function insertUsage(q: Queryable, row: UsageRow): Promise<void> {
  await q.query(
    `INSERT INTO usage_ledger
       (id, session_id, run_id, kind, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, entry_id, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12, COALESCE($13::timestamptz, now()))`,
    [
      row.id ?? prefixedId("usg"),
      row.sessionId ?? null,
      row.runId ?? null,
      row.kind,
      row.provider,
      row.model,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.cacheReadTokens ?? 0,
      row.cacheWriteTokens ?? 0,
      row.costUsd ?? null,
      row.entryId ?? null,
      row.at ?? null,
    ],
  );
}
