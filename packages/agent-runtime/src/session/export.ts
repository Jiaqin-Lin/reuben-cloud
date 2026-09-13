/**
 * `session/export.ts` —— 整个会话的 JSONL 导出（Phase 2；spec P2 §7）。
 *
 * 【为什么要有它】M0 的 `transcript.jsonl` 是观察窗与人工排查读的东西。P2 之后
 * "一次 Run 的完整轨迹"落进了 `session_entries` + `model_requests`，JSONL 降级为
 * **导出格式**——不是第二套真相，而是同一批数据的一个视图。把视图做成一次性导出，
 * 就不用维护"文件与表谁是权威"这个问题。
 *
 * 【与 M0 的兼容口径】记录类型与字段名逐条对齐（`run_start` / `request` / `response` /
 * `tool_call` / `note` / `run_end`），且每条前面有一行 `{"type":"run","runId":…}`
 * 作为轮次分隔（M0 的一次 Run 一个文件，所以没有这一行；这里是跨 Run 的会话）。
 *
 * 【导不出来的字段如实变 null，不编】M0 的 `run_start.limits` / `request.tools` /
 * `run_end.detail` 在 P2 的表里没有对应列（`tools` 只有 hash，`detail` 只有实时
 * transcript 才有）。这里保留字段名并给 null，而不是拿一个相近的值蒙混——排查时
 * "这个字段没有"比"这个字段看起来有但是错的"便宜得多。
 *
 * 【tool_call 与 intent 行怎么对上】靠 `(turn, source_index)`：工具结果在**同一轮**里的
 * 出现顺序就是它在 assistant 消息里的源码顺序（`tool_invocations.source_index` 的语义）。
 * 不靠 id 前缀比对，也不给表加列——这是那张表设计时就在回答的问题。
 */

import { accumulateUsage, emptyUsage } from "../types.ts";
import type { AssistantMessage } from "../types.ts";
import type { CustomEntryPayload } from "./entries.ts";
import { NOTE_CUSTOM_TYPE } from "./entries.ts";
import type { SessionStore, StoredEntry, StoredInvocation, StoredRequest, StoredRun } from "./store.ts";

/** 对象存储里那份 messages 的读取器（调用方给；不给就跳过外置的 request）。 */
export type SpilledMessagesReader = (objectKey: string) => Promise<unknown | null>;

export interface ExportSessionOptions {
  /** 外置 messages 的读取器（`requests/…json.gz` 解压后的 JSON）。 */
  readSpilled?: SpilledMessagesReader;
  /** 读不回来时记一条（导出继续，不抛）。 */
  log?: (level: "warn", message: string, details?: Record<string, unknown>) => void;
}

/**
 * 导出整个会话（跨 Run）为 JSONL 文本。**只读**：不改任何状态。
 *
 * @returns 一行一个 JSON 对象的文本（没有 Run 的空会话是空串）
 */
export async function exportSession(
  store: SessionStore,
  sessionId: string,
  options: ExportSessionOptions = {},
): Promise<string> {
  const lines: string[] = [];
  const allEntries = await store.listEntries(sessionId);
  const runs = await store.listRuns(sessionId);
  for (const run of runs) {
    lines.push(JSON.stringify({ type: "run", runId: run.id }));
    const entries = entriesOfRun(allEntries, run);
    const requests = await store.listRequests(run.id);
    const invocations = await store.listInvocations(run.id);
    for (const record of await buildRunRecords({ run, entries, requests, invocations, options })) {
      lines.push(JSON.stringify(record));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * 归属这次 Run 的条目：显式标了 `run_id` 的，加上"没有 run_id、但落在这次执行的时间窗里"
 * 的（压缩条目、系统条目在写入时不带 run_id——它们是会话级的）。
 */
function entriesOfRun(entries: readonly StoredEntry[], run: StoredRun): StoredEntry[] {
  const endedAt = run.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return entries
    .filter((entry) => {
      if (entry.runId === run.id) return true;
      if (entry.runId !== null) return false;
      const at = entry.createdAt.getTime();
      return at >= run.startedAt.getTime() && at <= endedAt;
    })
    .sort((a, b) => a.seq - b.seq);
}

interface RunRecordsInput {
  run: StoredRun;
  entries: StoredEntry[];
  requests: StoredRequest[];
  invocations: StoredInvocation[];
  options: ExportSessionOptions;
}

/**
 * 一次 Run 的记录序列。**顺序照 M0 的实时顺序**（run_start → 每轮的
 * request/response/tool_call/note → run_end），导出出来的文件与手工看 transcript
 * 是同一个阅读顺序。
 */
async function buildRunRecords(input: RunRecordsInput): Promise<Array<Record<string, unknown>>> {
  const { run, entries, requests, invocations, options } = input;
  const firstRequest = requests[0] ?? null;
  const firstUser = entries.find((entry) => isUserMessage(entry));
  const records: Array<Record<string, unknown>> = [];

  records.push({
    type: "run_start",
    ts: run.startedAt.toISOString(),
    runId: run.id,
    model: run.model,
    provider: run.provider,
    issue: firstUser === undefined ? null : userText(firstUser),
    system: firstRequest?.system ?? null,
    // 表里只有 tools 的 hash（正文在 P10 的编译产物里），字段保留、值如实为 null。
    tools: null,
    limits: null,
    startEntryId: run.startEntryId,
    sandboxId: run.sandboxId,
  });

  const requestByTurn = new Map(requests.map((request) => [request.turn, request]));
  const usage = emptyUsage();
  let turn = 0;
  let toolIndex = 0;

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.payload as { role?: string };
      if (message.role === "assistant") {
        turn += 1;
        toolIndex = 0;
        const assistant = entry.payload as AssistantMessage;
        const request = requestByTurn.get(turn);
        if (request !== undefined) records.push(await requestRecord(request, run, options));
        records.push({
          type: "response",
          ts: entry.createdAt.toISOString(),
          turn,
          // 时长不是 entry 的属性（M0 的 transcript 记的是实时值）；字段保留、值为 null。
          durationMs: null,
          content: assistant.content,
          stopReason: assistant.stopReason ?? null,
          usage: assistant.usage ?? null,
          refusalReason: assistant.refusalReason ?? null,
          errorMessage: assistant.errorMessage ?? null,
          entryId: entry.id,
        });
        if (assistant.usage !== undefined) accumulateUsage(usage, assistant.usage);
        continue;
      }
      if (message.role === "toolResult") {
        const result = entry.payload as {
          toolCallId: string;
          toolName: string;
          content: unknown[];
          isError: boolean;
        };
        const invocation = invocations.find((item) => item.turn === turn && item.sourceIndex === toolIndex) ?? null;
        toolIndex += 1;
        records.push({
          type: "tool_call",
          ts: entry.createdAt.toISOString(),
          turn,
          id: result.toolCallId,
          name: result.toolName,
          input: invocation?.args ?? null,
          isError: result.isError,
          resultBytes: invocation?.resultBytes ?? 0,
          entryId: entry.id,
          invocationId: invocation?.id ?? null,
          invocationStatus: invocation?.status ?? null,
        });
        continue;
      }
    }
    const note = noteRecord(entry, turn);
    if (note !== null) records.push(note);
  }

  // ---- run_end。`detail` 在表里没有列（实时 transcript 才有），如实为 null。
  records.push({
    type: "run_end",
    ts: (run.endedAt ?? run.startedAt).toISOString(),
    stopReason: run.stopReason ?? run.status,
    detail: null,
    status: run.status,
    turns: turn,
    toolCalls: invocations.length,
    usage,
    endEntryId: run.endEntryId,
    transcriptFailure: null,
  });

  return records;
}

/** `model_requests` 一行 → M0 的 `request` 记录（外置 messages 现读现解）。 */
async function requestRecord(
  request: StoredRequest,
  run: StoredRun,
  options: ExportSessionOptions,
): Promise<Record<string, unknown>> {
  let messages: unknown = request.inlineMessages ?? null;
  const objectKey = request.objectKey ?? null;
  if (messages === null && objectKey !== null && options.readSpilled !== undefined) {
    try {
      messages = await options.readSpilled(objectKey);
    } catch (error) {
      options.log?.("warn", "导出的 request 外置 messages 读不回来", {
        objectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    type: "request",
    ts: request.at.toISOString(),
    turn: request.turn,
    model: run.model,
    system: request.system,
    // 表里只有 tools 的 hash，字段保留、值如实为 null（maxTokens 同理）。
    tools: null,
    maxTokens: null,
    bytes: request.bytes,
    compiledHash: request.compiledHash,
    sections: request.sections,
    messages,
    objectKey,
    usageId: request.usageId ?? null,
  };
}

/** 压缩条目与 custom 条目 → 一条 `note`（它们都是"给人和 UI 看的事实"）。 */
function noteRecord(entry: StoredEntry, turn: number): Record<string, unknown> | null {
  if (entry.type === "compaction") {
    const payload = entry.payload as { tokensBefore?: number; firstKeptEntryId?: string };
    return {
      type: "note",
      ts: entry.createdAt.toISOString(),
      turn,
      kind: "compaction",
      message: `上下文压缩完成（压前 ${payload.tokensBefore ?? "?"} tokens，保留自 ${payload.firstKeptEntryId ?? "?"}）`,
      entryId: entry.id,
    };
  }
  if (entry.type === "custom") {
    const payload = entry.payload as CustomEntryPayload & { turn?: number | null };
    return {
      type: "note",
      ts: entry.createdAt.toISOString(),
      turn: payload.turn ?? turn,
      kind: payload.customType === NOTE_CUSTOM_TYPE ? "note" : payload.customType,
      message: payload.content,
      entryId: entry.id,
    };
  }
  return null;
}

// ---------------------------------------------------------------- 小工具

function isUserMessage(entry: StoredEntry): boolean {
  return entry.type === "message" && (entry.payload as { role?: string }).role === "user";
}

function userText(entry: StoredEntry): string | null {
  const content = (entry.payload as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}
