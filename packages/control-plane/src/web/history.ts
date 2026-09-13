/**
 * `history.ts` —— 观察窗的**会话视图**：从 `session_entries` 读出"这一段对话"
 * （Phase 4 的具体化）。
 *
 * 【为什么要有它，而不是继续用内存里的 JSONL】P2 起，对话的唯一持久形态是
 * `session_entries`（只追加）+ `model_requests`（每轮真的发出去的东西）。
 * 观察窗原来的做法是"把这次 Run 的事件在内存里记一份"——它只覆盖**这一次执行**，
 * 刷新页面看不见上一轮说过什么，进程重启更是全没了。会话视图改成读表：
 *  · `GET /sessions/{id}/entries` —— 整个会话（跨 Run），页面默认显示的就是它；
 *  · `GET /runs/{id}/transcript` —— 本次执行的切片（按 `runId` 过滤）。
 *
 * 【两个端点都不碰内存】读的是存储，所以"某个 run 还在不在 hub 的环形缓冲里"与
 * "能不能看见它的过程"解耦了。SSE 仍然只走过内存缓冲——实时归实时，取证归存储。
 *
 * 【为什么返回 runs 一起给】前端要用 `runs[].startEntryId` 把 entries 切成"第几次执行"。
 * 让前端自己再发一次请求只会多一个竞态（两次读之间又有一轮结束了），所以一次给全。
 *
 * 【不做的】不做分页 UI、不做 diff、不做重建上下文。M0 的边界是"只读观察"。
 */

import type { EntryType, SessionStore, StoredEntry, StoredRun } from "@reuben-cloud/agent-runtime";

// ---------------------------------------------------------------- 传输形状

/**
 * 一次执行的摘要。字段名与 `StoredRun` 一致（Date 序列化成 ISO 串）——
 * 前端与排查脚本看到的是同一套词，不在这里发明第二套命名。
 */
export interface RunSummary {
  id: string;
  sessionId: string;
  sandboxId: string | null;
  startEntryId: string | null;
  endEntryId: string | null;
  provider: string;
  model: string;
  envRevision: string | null;
  status: string;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * 一条 entry 的传输形状。`payload` **原样透传**：它就是一条 `AgentMessage`
 * （或压缩 / 自定义条目的载荷），前端的渲染分支与实时事件共用同一套。
 */
export interface EntrySummary {
  id: string;
  runId: string | null;
  parentId: string | null;
  seq: number;
  type: EntryType;
  payload: unknown;
  createdAt: string;
}

export interface SessionViewPayload {
  sessionId: string;
  /** 按开始时间升序。前端用 `startEntryId` 标每一轮的边界。 */
  runs: RunSummary[];
  /** 按 seq 升序（存储保证）。 */
  entries: EntrySummary[];
}

export interface RunViewPayload {
  run: RunSummary;
  entries: EntrySummary[];
}

export interface ReadViewOptions {
  /** 只看 seq 大于它的（增量拉取）。 */
  afterSeq?: number;
  /** 最多返回多少条（服务端会再夹一道上限）。 */
  limit?: number;
}

/** 一次响应最多带多少条 entry（会话可以很长，别让一条 HTTP 响应变成几百 MB）。 */
export const MAX_VIEW_ENTRIES = 5_000;

// ---------------------------------------------------------------- 读

/** 整个会话：runs + entries。会话不存在时返回 null（调用方回 404）。 */
export async function readSessionView(
  store: SessionStore,
  sessionId: string,
  options: ReadViewOptions = {},
): Promise<SessionViewPayload | null> {
  const session = await store.getSession(sessionId);
  if (session === null) return null;
  const [runs, entries] = await Promise.all([
    store.listRuns(sessionId),
    store.listEntries(sessionId, listOptions(options)),
  ]);
  return { sessionId, runs: runs.map(serializeRun), entries: entries.map(serializeEntry) };
}

/**
 * 一次执行：run 的边界 + 它写下的 entries（`listEntries` 的 `runId` 是记录器落库时
 * 标上的，所以"这一次执行说了什么"是一次过滤，不需要另立一张表）。
 */
export async function readRunView(
  store: SessionStore,
  runId: string,
  options: ReadViewOptions = {},
): Promise<RunViewPayload | null> {
  const run = await store.getRun(runId);
  if (run === null) return null;
  const all = await store.listEntries(run.sessionId, listOptions(options));
  return { run: serializeRun(run), entries: all.filter((entry) => entry.runId === runId).map(serializeEntry) };
}

/** 把 `afterSeq` / `limit` 夹到安全范围（负数、NaN、超大值都不该穿透到 SQL）。 */
function listOptions(options: ReadViewOptions): { afterSeq?: number; limit: number } {
  const limit = Math.min(MAX_VIEW_ENTRIES, Math.max(1, Math.floor(options.limit ?? MAX_VIEW_ENTRIES)));
  if (options.afterSeq === undefined || !Number.isFinite(options.afterSeq)) return { limit };
  return { afterSeq: Math.max(0, Math.floor(options.afterSeq)), limit };
}

// ---------------------------------------------------------------- 序列化

export function serializeRun(run: StoredRun): RunSummary {
  return {
    id: run.id,
    sessionId: run.sessionId,
    sandboxId: run.sandboxId,
    startEntryId: run.startEntryId,
    endEntryId: run.endEntryId,
    provider: run.provider,
    model: run.model,
    envRevision: run.envRevision,
    status: run.status,
    stopReason: run.stopReason,
    startedAt: toIso(run.startedAt),
    endedAt: run.endedAt === null ? null : toIso(run.endedAt),
  };
}

export function serializeEntry(entry: StoredEntry): EntrySummary {
  return {
    id: entry.id,
    runId: entry.runId,
    parentId: entry.parentId,
    seq: entry.seq,
    type: entry.type,
    payload: entry.payload,
    createdAt: toIso(entry.createdAt),
  };
}

/** 两个实现（内存 / PG）都该给 Date；真给了别的形状时不假装它是日期。 */
function toIso(value: Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
