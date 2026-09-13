/**
 * `session/memory.ts` —— `SessionStore` 的内存实现（Phase 2；spec P2 §2）。
 *
 * 【它为什么不是"测试玩具"】契约测试（`test/session-store.test.ts`）在它身上跑一遍，
 * 同一份测试体在 CP 的集成测试里对 Postgres 再跑一遍——两个实现的可观察行为必须一致。
 * 单测要的是"没有 PG 也能验证编排"，契约测试要的是"内存实现不糊弄"。
 *
 * 【id 为什么是计数器而不是 ULID】ULID 在 CP 侧（`ulid.ts`）。agent-runtime 是纯决策层，
 * 不该为了 id 生成引一个依赖，也不该把 CP 的实现复制一份。内存实现是**单进程测试用**的，
 * `ent_000001` 这种可读 id 反而让失败时的输出更好看。真要跑一个非 PG 的部署，id 生成器
 * 通过 `newId` 注入即可（接口是 `(prefix) => string`）。
 *
 * 【故障注入只有一个，而且明确标注】`failNextUsageWrite()` 用来验证"appendEntry 与 usage
 * 同事务"这条契约（spec 测试要点 2）。PG 那边不需要这个钩子——数据库的真事务就是保证。
 */

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
} from "./store.ts";

export interface MemorySessionStoreOptions {
  /** id 生成器（前缀 → id）。默认 `prefix_000001` 这样的计数器。 */
  newId?: (prefix: string) => string;
  /** 可注入时钟（测试断言 sandbox_last_used_at 时用）。 */
  now?: () => Date;
}

export class MemorySessionStore implements SessionStore {
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;

  readonly #sessions = new Map<string, StoredSession>();
  readonly #entries: StoredEntry[] = [];
  readonly #runs = new Map<string, StoredRun>();
  readonly #invocations = new Map<string, StoredInvocation>();
  readonly #usage: UsageRow[] = [];
  readonly #requests: StoredRequest[] = [];

  #seq = 0;
  #ids = 0;
  /** 下一次带 usage 的 appendEntry 到这个阶段抛错（模拟"用量写不进去"）。 */
  #usageWriteFailure: Error | null = null;

  constructor(options: MemorySessionStoreOptions = {}) {
    this.#newId = options.newId ?? ((prefix) => `${prefix}_${String((this.#ids += 1)).padStart(6, "0")}`);
    this.#now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------- 测试用故障注入

  /** 让**下一次**带 usage 的 `appendEntry` 在写用量时失败（entry 必须跟着回滚）。 */
  failNextUsageWrite(message = "注入的用量写入失败"): void {
    this.#usageWriteFailure = new Error(message);
  }

  // -------------------------------------------------------------- 会话

  async createSession(input: NewSession): Promise<SessionRef> {
    const id = this.#newId("ses");
    if (this.#sessions.has(id)) throw new Error(`会话 id 重复：${id}`);
    const at = this.#now();
    this.#sessions.set(id, {
      id,
      taskId: input.taskId ?? null,
      repoKey: input.repoKey,
      baseCommit: input.baseCommit,
      headRef: input.headRef ?? null,
      headCommit: input.headCommit ?? null,
      cwd: input.cwd,
      title: input.title ?? null,
      leafEntryId: null,
      sandboxId: null,
      sandboxLastUsedAt: null,
      sandboxFlushFailures: 0,
      sandboxFlushFailedAt: null,
      activeRunId: null,
      createdAt: at,
      updatedAt: at,
    });
    return { id };
  }

  async getSession(sessionId: string): Promise<StoredSession | null> {
    const session = this.#sessions.get(sessionId);
    return session === undefined ? null : clone(session);
  }

  async updateSessionHead(sessionId: string, patch: SessionHeadPatch): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    if ("leafEntryId" in patch) session.leafEntryId = patch.leafEntryId ?? null;
    if ("headRef" in patch) session.headRef = patch.headRef ?? null;
    if ("headCommit" in patch) session.headCommit = patch.headCommit ?? null;
    if ("title" in patch) session.title = patch.title ?? null;
    session.updatedAt = this.#now();
  }

  async listSessions(opts: ListSessionsOptions = {}): Promise<StoredSession[]> {
    const all = [...this.#sessions.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const before = opts.before === undefined ? null : new Date(opts.before);
    const filtered = before === null ? all : all.filter((session) => session.updatedAt < before);
    return filtered.slice(0, opts.limit ?? 100).map(clone);
  }

  async setSessionSandbox(sessionId: string, patch: SessionSandboxPatch): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    if ("sandboxId" in patch) session.sandboxId = patch.sandboxId ?? null;
    if ("at" in patch) session.sandboxLastUsedAt = patch.at ?? this.#now();
    if (patch.flushFailures !== undefined) session.sandboxFlushFailures = patch.flushFailures;
    if ("flushFailedAt" in patch) session.sandboxFlushFailedAt = patch.flushFailedAt ?? null;
    session.updatedAt = this.#now();
  }

  async touchSession(sessionId: string, at?: Date): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    session.sandboxLastUsedAt = at ?? this.#now();
    session.updatedAt = this.#now();
  }

  async acquireSessionLock(sessionId: string, runId: string): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return false;
    if (session.activeRunId !== null) return false;
    session.activeRunId = runId;
    session.updatedAt = this.#now();
    return true;
  }

  async releaseSessionLock(sessionId: string, runId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    if (session.activeRunId !== runId) return;
    session.activeRunId = null;
    session.updatedAt = this.#now();
  }

  // -------------------------------------------------------------- 对话树

  async appendEntry(
    sessionId: string,
    runId: string | null,
    entry: NewEntry,
    opts: { usage?: UsageRow } = {},
  ): Promise<string> {
    if (!this.#sessions.has(sessionId)) throw new Error(`会话不存在：${sessionId}`);
    const id = entry.id ?? this.#newId("ent");
    if (this.#entries.some((stored) => stored.id === id)) throw new Error(`entry id 重复：${id}`);
    // ① 先做所有会失败的事（"事务"的语义在内存里就是"先校验再一起改"）。
    if (opts.usage !== undefined && this.#usageWriteFailure !== null) {
      const failure = this.#usageWriteFailure;
      this.#usageWriteFailure = null;
      throw failure;
    }
    const stored: StoredEntry = {
      id,
      sessionId,
      runId,
      parentId: entry.parentId ?? null,
      seq: (this.#seq += 1),
      type: entry.type,
      payload: entry.payload,
      createdAt: this.#now(),
    };
    this.#entries.push(stored);
    // ② 用量与 entry 同生共死：上面的 throw 之后 entry 不会存在。
    // `session_id` / `run_id` / `entry_id` 三个归属字段在没显式给时都从 appendEntry 的参数补（与 PG 实现同一个语义）。
    if (opts.usage !== undefined) {
      this.#usage.push({
        ...opts.usage,
        sessionId: opts.usage.sessionId ?? sessionId,
        runId: opts.usage.runId ?? runId,
        entryId: opts.usage.entryId ?? id,
        at: opts.usage.at ?? this.#now(),
      });
    }
    return id;
  }

  /**
   * 会话的 entries。`limit` 取**最近的** N 条（会话很长时重建历史要的是尾部），
   * 但返回值永远按 seq 升序——调用方不需要为"尾部的顺序"写特例。
   */
  async listEntries(sessionId: string, opts: ListEntriesOptions = {}): Promise<StoredEntry[]> {
    let rows = this.#entries.filter((entry) => entry.sessionId === sessionId);
    if (opts.afterSeq !== undefined) rows = rows.filter((entry) => entry.seq > opts.afterSeq!);
    if (opts.beforeSeq !== undefined) rows = rows.filter((entry) => entry.seq < opts.beforeSeq!);
    rows = rows.sort((a, b) => a.seq - b.seq);
    if (opts.limit !== undefined && rows.length > opts.limit) rows = rows.slice(rows.length - opts.limit);
    return rows.map(clone);
  }

  // -------------------------------------------------------------- Run

  async startRun(input: NewRun): Promise<string> {
    if (!this.#sessions.has(input.sessionId)) throw new Error(`会话不存在：${input.sessionId}`);
    const id = input.id ?? this.#newId("run");
    const run: StoredRun = {
      id,
      sessionId: input.sessionId,
      sandboxId: input.sandboxId ?? null,
      startEntryId: input.startEntryId,
      endEntryId: null,
      provider: input.provider,
      model: input.model,
      envRevision: input.envRevision ?? null,
      status: "running",
      stopReason: null,
      startedAt: this.#now(),
      endedAt: null,
    };
    this.#runs.set(id, run);
    return id;
  }

  async endRun(runId: string, patch: EndRunPatch): Promise<void> {
    const run = this.#runs.get(runId);
    if (run === undefined) throw new Error(`执行不存在：${runId}`);
    run.status = patch.status;
    run.stopReason = patch.stopReason;
    run.endEntryId = patch.endEntryId;
    if (patch.sandboxId !== undefined) run.sandboxId = patch.sandboxId;
    run.endedAt = this.#now();
  }

  async listRuns(sessionId: string): Promise<StoredRun[]> {
    return [...this.#runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map(clone);
  }

  // -------------------------------------------------------------- 工具调用

  async beginToolInvocation(inv: NewInvocation): Promise<string> {
    const id = inv.id ?? this.#newId("inv");
    const resultEntryId = inv.resultEntryId ?? this.#newId("ent");
    this.#invocations.set(id, {
      id,
      sessionId: inv.sessionId,
      runId: inv.runId,
      turn: inv.turn,
      sourceIndex: inv.sourceIndex,
      tool: inv.tool,
      args: inv.args,
      replay: inv.replay,
      status: "intent",
      resultEntryId,
      isError: null,
      resultBytes: null,
      startedAt: this.#now(),
      endedAt: null,
    });
    return id;
  }

  async settleToolInvocation(id: string, result: InvocationSettlement): Promise<string> {
    const invocation = this.#invocations.get(id);
    if (invocation === undefined) throw new Error(`工具调用不存在：${id}`);
    if (invocation.status !== "intent") throw new Error(`工具调用 ${id} 已经结算过（${invocation.status}）`);
    // 结果 entry 的 id **必须**是 intent 时预留的那个（设计文档 §G.3）。
    const entryId = result.entry.id ?? invocation.resultEntryId ?? this.#newId("ent");
    await this.appendEntry(invocation.sessionId, invocation.runId, { ...result.entry, id: entryId });
    invocation.status = "settled";
    invocation.isError = result.isError;
    invocation.resultBytes = result.bytes;
    invocation.resultEntryId = entryId;
    invocation.endedAt = this.#now();
    return entryId;
  }

  async interruptInvocation(id: string): Promise<void> {
    const invocation = this.#invocations.get(id);
    if (invocation === undefined) return;
    if (invocation.status !== "intent") return;
    invocation.status = "interrupted";
    invocation.endedAt = this.#now();
  }

  async listInvocations(runId: string, status?: InvocationStatus): Promise<StoredInvocation[]> {
    return [...this.#invocations.values()]
      .filter((invocation) => invocation.runId === runId)
      .filter((invocation) => status === undefined || invocation.status === status)
      .sort((a, b) => a.turn - b.turn || a.sourceIndex - b.sourceIndex)
      .map(clone);
  }

  // -------------------------------------------------------------- 用量与编译产物

  async recordUsage(row: UsageRow): Promise<void> {
    this.#usage.push({ ...row, at: row.at ?? this.#now() });
  }

  async recordRequest(row: NewRequest): Promise<void> {
    this.#requests.push({ ...row, id: row.id ?? this.#newId("req"), at: row.at ?? this.#now() });
  }

  async listRequests(runId: string): Promise<StoredRequest[]> {
    return this.#requests
      .filter((request) => request.runId === runId)
      .sort((a, b) => a.turn - b.turn)
      .map(clone);
  }

  // -------------------------------------------------------------- 测试观察口

  /** 账本行（测试断言"摘要调用进了账本"这类事实）。 */
  usageRows(): UsageRow[] {
    return this.#usage.map((row) => ({ ...row }));
  }
}

/** 浅拷贝：内存实现给出的行不该被调用方改到（PG 实现天然有这个性质）。 */
function clone<T extends object>(value: T): T {
  return { ...value };
}
