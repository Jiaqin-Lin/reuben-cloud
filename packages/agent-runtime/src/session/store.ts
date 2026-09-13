/**
 * `session/store.ts` —— 会话存储的**接口**（Phase 2；设计文档 §G / spec P2 §2）。
 *
 * 【为什么接口在 agent-runtime、实现在 CP】硬约束是"agent-runtime 是纯决策层"
 * （spec §0.3：不许 import pg / octokit / @aws-sdk）。"对话历史怎么存"是决策的一部分
 * （下一轮的上下文从哪来、用量记在哪），"用哪个驱动存"不是。所以接口与两个实现分开：
 *  · 内存实现（`memory.ts`）——单测用，也是契约测试的第一份实现；
 *  · Postgres 实现（CP 的 `session/postgres.ts`）——生产用，`pg` 只在那里。
 *
 * 【为什么是"大接口"而不是拆成五个小接口】这两个实现的**契约**必须一起被验证：
 * "appendEntry 与 usage 同事务"这条只有在同一个接口里才能表达。拆成 SessionStore /
 * RunStore / LedgerStore 之后，跨表的事务边界就没有地方写了。
 *
 * 【与 pi 的关系】取的是 pi `session-manager.ts` 的 entries + 用量 + 意图/结算三件事，
 * 不取 values / lists / 分支（设计文档 §B.7 的"明确不搬"）。
 *
 * 【三条容易写错的语义，逐条写在这里，两个实现都必须守】
 *  ① `appendEntry` 带 `usage` 时**必须一个事务**（pi 的规矩：entry 与用量同生共死）。
 *     用量写不进去时，那条 entry 也不存在——否则账本缺一行，而对话看起来是完整的。
 *  ② `seq` 由存储分配（全局单调）。调用方不指定、也不假设它连续。
 *  ③ `appendEntry` **不改** `sessions.leaf_entry_id`：leaf 是"这一轮结束时停在哪"，
 *     由编排在最后用 `updateSessionHead` 一次写清（中途崩了宁可 leaf 停在上一轮，
 *     也不要留下一个"半句话的 leaf"）。
 */

import type { SectionStat } from "../types.ts";

// ---------------------------------------------------------------- 枚举

/** 一次执行的状态。只有三个取值：跑到一半崩了就停在 `running`（M2 不做恢复）。 */
export type RunStatus = "running" | "stopped" | "failed";

/**
 * 工具调用的状态。`intent` 是**崩溃恢复的入口**：一行 intent 意味着"我们打算调它，
 * 但没看到结算"——M2 只保证这些行可见（`listInvocations(runId, "intent")`），
 * 不做重放（M3 的事，设计文档 §G.3）。
 */
export type InvocationStatus = "intent" | "settled" | "interrupted";

/** 对话树里条目的三种类型（与 005 迁移的 CHECK 一致）。 */
export type EntryType = "message" | "compaction" | "custom";

/** 账本的口径。环境自愈（P6）与向量（不在 M2）各占一个值，现在就把它们列全。 */
export type UsageKind = "main" | "compaction" | "env_build" | "embedding";

/** 工具的重放策略。写在 AgentTool 上，落库是为了 M3 恢复时有据可查。 */
export type ReplayPolicy = "never" | "safe";

// ---------------------------------------------------------------- 会话

export interface NewSession {
  /** `owner/name`，不含凭据。 */
  repoKey: string;
  /** 会话开始时的 commit（冷启动重建沙箱的兜底起点）。 */
  baseCommit: string;
  /** 沙箱内的仓库根（工具层相对路径的基准）。 */
  cwd: string;
  taskId?: string | null;
  headRef?: string | null;
  headCommit?: string | null;
  title?: string | null;
}

export interface SessionRef {
  id: string;
}

/**
 * 一行会话。**带沙箱租约与并发锁的字段**——它们不是"顺手带上"的：
 * `sandbox_id` / `sandbox_last_used_at` 是空闲回收的依据，`active_run_id` 是并发保护的依据
 * （spec P2 §6 的三条硬规则都在这些字段上）。
 */
export interface StoredSession {
  id: string;
  taskId: string | null;
  repoKey: string;
  baseCommit: string;
  headRef: string | null;
  headCommit: string | null;
  cwd: string;
  title: string | null;
  /** 当前 leaf；下一句从这里往后接。**没有 entry 的会话是 null**。 */
  leafEntryId: string | null;
  sandboxId: string | null;
  sandboxLastUsedAt: Date | null;
  /** 连续失败次数（回收前落地失败）。到阈值就退到 M0 Phase 10 的 archive 兜底。 */
  sandboxFlushFailures: number;
  sandboxFlushFailedAt: Date | null;
  activeRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionHeadPatch {
  leafEntryId?: string | null;
  headRef?: string | null;
  headCommit?: string | null;
  title?: string | null;
}

/** 沙箱租约的写入口（attach / detach / 记一次落地失败或成功）。 */
export interface SessionSandboxPatch {
  sandboxId?: string | null;
  /** 缺省 `now()`：attach 与 touch 都该刷新它。 */
  at?: Date | null;
  flushFailures?: number;
  flushFailedAt?: Date | null;
}

// ---------------------------------------------------------------- 对话树

/**
 * 要追加的一条 entry。
 *
 * `parentId` 由调用方给（P2 是一条直线，M3 的分叉靠它）：next-leaf 的追踪是编排的事，
 * 存储层不该猜"这条该挂在谁后面"。
 *
 * `id` 一般不给（存储生成 `ent_<ulid>`）；**唯一的例外是工具结算**：`beginToolInvocation`
 * 会预留一个结果 entry id，结算时用同一个（设计文档 §G.3 的"结算时用同一个"）。
 */
export interface NewEntry {
  type: EntryType;
  payload: unknown;
  parentId?: string | null;
  id?: string;
}

export interface StoredEntry {
  id: string;
  sessionId: string;
  /** 哪一次执行写的。压缩条目 / 系统条目可以是 null。 */
  runId: string | null;
  parentId: string | null;
  /** 存储分配，全局单调。 */
  seq: number;
  type: EntryType;
  payload: unknown;
  createdAt: Date;
}

export interface ListEntriesOptions {
  limit?: number;
  /** 只看 seq 大于它的（增量拉取）。 */
  afterSeq?: number;
  /** 只看 seq 小于它的（回放某个时点）。 */
  beforeSeq?: number;
}

// ---------------------------------------------------------------- Run

export interface NewRun {
  id?: string;
  sessionId: string;
  sandboxId?: string | null;
  /** 这一轮从哪条 entry 之后开始（第一轮是 null）。 */
  startEntryId: string | null;
  provider: string;
  model: string;
  envRevision?: string | null;
}

export interface StoredRun {
  id: string;
  sessionId: string;
  sandboxId: string | null;
  startEntryId: string | null;
  endEntryId: string | null;
  provider: string;
  model: string;
  envRevision: string | null;
  status: RunStatus;
  stopReason: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface EndRunPatch {
  status: RunStatus;
  /** 与 `AgentStopReason` 同一套取值（`end_turn` / `max_turns` / `session_busy`…）。 */
  stopReason: string;
  /** 结束时 leaf 在哪（下一轮的起点）。 */
  endEntryId: string | null;
  sandboxId?: string | null;
}

// ---------------------------------------------------------------- 工具调用

export interface NewInvocation {
  id?: string;
  sessionId: string;
  runId: string;
  /** 本次执行内的模型往返序号（从 1 起）。 */
  turn: number;
  /** 在 assistant 消息里的位置（同一轮里按源码顺序）。 */
  sourceIndex: number;
  tool: string;
  args: unknown;
  replay: ReplayPolicy;
  /** 预留的结果 entry id；不给就由存储生成（结算时用同一个）。 */
  resultEntryId?: string;
}

export interface StoredInvocation {
  id: string;
  sessionId: string;
  runId: string;
  turn: number;
  sourceIndex: number;
  tool: string;
  args: unknown;
  replay: ReplayPolicy;
  status: InvocationStatus;
  resultEntryId: string | null;
  isError: boolean | null;
  resultBytes: number | null;
  startedAt: Date;
  endedAt: Date | null;
}

/** 结算：把结果 entry 落库 + 把 intent 推到 settled，**一个事务**。 */
export interface InvocationSettlement {
  /** 结果 entry（`id` 缺省用 intent 时预留的那个）。 */
  entry: NewEntry;
  isError: boolean;
  /** 结果正文的字节数（`result_bytes`；不是 entry payload 的大小）。 */
  bytes: number;
}

// ---------------------------------------------------------------- 用量

export interface UsageRow {
  id?: string;
  sessionId?: string | null;
  runId?: string | null;
  kind: UsageKind;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 未知模型可以不给（账本允许为空）。 */
  costUsd?: number | null;
  /** 对应的 entry（主调用就是那条 assistant entry）。 */
  entryId?: string | null;
  at?: Date;
}

// ---------------------------------------------------------------- 编译产物

export interface NewRequest {
  id?: string;
  sessionId: string;
  runId: string;
  turn: number;
  /** 确定性哈希（P10 的编译产物指纹）。 */
  compiledHash: string;
  sections: SectionStat[];
  system: string;
  toolsHash: string;
  usageId?: string | null;
  /** ≤ 256 KiB 内联；超出走 `objectKey`。两个字段只有一个非空。 */
  inlineMessages?: unknown;
  objectKey?: string | null;
  /** 序列化后的真实字节数（决定内联还是外置的同一个量）。 */
  bytes: number;
  at?: Date;
}

export interface StoredRequest extends Omit<NewRequest, "id" | "at"> {
  id: string;
  at: Date;
}

// ---------------------------------------------------------------- 接口

export interface ListSessionsOptions {
  limit?: number;
  /** 分页游标：只看 `updated_at` 早于它的（`updated_at` 的 ISO 串）。 */
  before?: string;
}

/**
 * 会话存储。**两个实现跑同一套契约测试**（`agent-runtime/test/session-store.test.ts`
 * 导出测试体，CP 的集成测试拿同一份跑 PG）——这是 M0 对"双实现"的做法，
 * 也是"内存实现不是玩具"的保证。
 */
export interface SessionStore {
  // ---- 会话（长期）
  createSession(input: NewSession): Promise<SessionRef>;
  getSession(sessionId: string): Promise<StoredSession | null>;
  updateSessionHead(sessionId: string, patch: SessionHeadPatch): Promise<void>;
  listSessions(opts?: ListSessionsOptions): Promise<StoredSession[]>;

  /** attach / detach 当前沙箱；顺带刷新 `sandbox_last_used_at`（租约的唯一写入口）。 */
  setSessionSandbox(sessionId: string, patch: SessionSandboxPatch): Promise<void>;
  /** 续时：把 `sandbox_last_used_at` 推到 `at`（缺省 now）。用户发言 / 模型调用 / 工具调用都调它。 */
  touchSession(sessionId: string, at?: Date): Promise<void>;

  /**
   * 抢会话锁（spec P2 §5 步①）：`UPDATE sessions SET active_run_id = $runId
   * WHERE id = $id AND active_run_id IS NULL`。**抢不到返回 false**（调用方转
   * `session_busy`，不排队——排队是 M3）。
   */
  acquireSessionLock(sessionId: string, runId: string): Promise<boolean>;
  /** 释放：只有 `active_run_id = runId` 时才清（避免把别人的锁清掉）。 */
  releaseSessionLock(sessionId: string, runId: string): Promise<void>;

  // ---- 对话树（挂在会话上，只追加）
  /** 追加一条 entry；带 `usage` 时与它同事务。返回 entry id。 */
  appendEntry(
    sessionId: string,
    runId: string | null,
    entry: NewEntry,
    opts?: { usage?: UsageRow },
  ): Promise<string>;
  listEntries(sessionId: string, opts?: ListEntriesOptions): Promise<StoredEntry[]>;

  // ---- Run（一次执行）
  startRun(input: NewRun): Promise<string>;
  endRun(runId: string, patch: EndRunPatch): Promise<void>;
  listRuns(sessionId: string): Promise<StoredRun[]>;

  // ---- 工具调用 / 用量 / 编译产物
  /** 记一条 intent（一个事务）。返回 invocation id。 */
  beginToolInvocation(inv: NewInvocation): Promise<string>;
  /**
   * 结算：落结果 entry + 推 status，**一个事务**。返回结果 entry 的 id——
   * 编排要靠它把 leaf 接下去（spec 的签名是 void，这里是附录 A-5 的偏差）。
   */
  settleToolInvocation(id: string, result: InvocationSettlement): Promise<string>;
  /** 把一条 intent 标成 `interrupted`（Run 结束时仍停在 intent 的调用）。 */
  interruptInvocation(id: string): Promise<void>;
  listInvocations(runId: string, status?: InvocationStatus): Promise<StoredInvocation[]>;

  recordUsage(row: UsageRow): Promise<void>;
  recordRequest(row: NewRequest): Promise<void>;
  /** 本次执行的每一轮编译产物（导出与回放用）。 */
  listRequests(runId: string): Promise<StoredRequest[]>;
}
