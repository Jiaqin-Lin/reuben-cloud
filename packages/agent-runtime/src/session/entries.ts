/**
 * `session/entries.ts` —— 对话树的**构造与投影**（Phase 2；设计文档 §G.2）。
 *
 * 【这一层解决什么】存储里的一条 entry 是"发生过的事实"（`type` + `payload` jsonb），
 * 而模型下一轮要的是"一段消息序列"。两者之间的翻译（哪条进模型、压缩之后从哪开始、
 * 旁路信息要不要进去）全部收在这一个文件里——它是"历史"与"上下文"之间唯一的接缝。
 *
 * 【压缩怎么改变投影，而不是改变历史】`buildContextEntries` 找**最后一条** compaction
 * 条目，从它的 `firstKeptEntryId` 开始取（含），前面只放一条摘要消息。被压掉的条目
 * 仍然在存储里（审计、回放、导出都要用），只是不再进模型。这是设计文档 §E.4 的
 * "压缩只改变送去模型的投影"落到代码上的那一行。
 *
 * 【为什么 note 也要进 entries】观察窗（P4）与导出（spec P2 §7）都要它。但它**不进模型**：
 * 一条"上下文太大，丢了 6 条旧工具结果"的提示对模型是纯噪声。所以自定义条目带
 * `forModel` 标记（缺省 true，note 显式 false），投影时按它过滤——用一个字段表达
 * "给谁看"，比在类型上分两种 custom 便宜。
 */

import type {
  AgentMessage,
  CompactionSummaryMessage,
  CustomMessage,
  Usage,
} from "../types.ts";
import type { EntryType, NewEntry, StoredEntry } from "./store.ts";

// ---------------------------------------------------------------- payload 形状

/** `type='message'` 的 payload：**就是一条 AgentMessage**（不加包装，导出时少一层剥壳）。 */
export type MessageEntryPayload = AgentMessage;

/** `type='compaction'` 的 payload（P3 生产；这里的形状 P10 的编译与导出都要认）。 */
export interface CompactionEntryPayload {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** 累积的文件清单（P3 §3：下一次压缩继续累积，否则"改过哪些文件"会随压缩丢失）。 */
  details?: CompactionDetails;
  /** 生成这份摘要的用量（进账本，`kind='compaction'`）。 */
  usage?: Usage;
}

export interface CompactionDetails {
  readFiles?: string[];
  modifiedFiles?: string[];
  [key: string]: unknown;
}

/** `type='custom'` 的 payload。`forModel === false` 的条目只给 UI / 导出看。 */
export interface CustomEntryPayload {
  customType: string;
  content: string;
  display: boolean;
  forModel?: boolean;
}

/** note 条目的 `customType`。导出（M0 的 `note` 记录）与观察窗都按它识别。 */
export const NOTE_CUSTOM_TYPE = "note";

export interface EntryLocation {
  parentId?: string | null;
}

// ---------------------------------------------------------------- 构造

/** 一条消息 → 一条 `message` entry。 */
export function entryForMessage(message: AgentMessage, location: EntryLocation = {}): NewEntry {
  return withLocation({ type: "message", payload: message }, location);
}

/** 一份压缩摘要 → 一条 `compaction` entry。 */
export function entryForCompaction(
  payload: CompactionEntryPayload,
  location: EntryLocation = {},
): NewEntry {
  return withLocation({ type: "compaction", payload }, location);
}

/**
 * 一条旁路信息 → 一条 `custom` entry（`forModel:false`）。
 * `turn` 放在 payload 里而不是 entry 列上：它是展示信息，不是查询维度。
 */
export function entryForNote(
  kind: string,
  message: string,
  options: { turn?: number | null; parentId?: string | null } = {},
): NewEntry {
  const payload: CustomEntryPayload & { turn?: number | null } = {
    customType: NOTE_CUSTOM_TYPE,
    content: message,
    display: true,
    forModel: false,
    ...(options.turn === undefined ? {} : { turn: options.turn }),
  };
  return withLocation({ type: "custom", payload }, { parentId: options.parentId ?? null });
}

/** 一条给模型的系统提示（技能提示、审批记录）→ `custom` entry（`forModel:true`）。 */
export function entryForCustom(
  payload: Omit<CustomEntryPayload, "forModel"> & { forModel?: boolean },
  location: EntryLocation = {},
): NewEntry {
  return withLocation({ type: "custom", payload: { ...payload } }, location);
}

function withLocation(entry: NewEntry, location: EntryLocation): NewEntry {
  return { ...entry, parentId: location.parentId ?? null };
}

// ---------------------------------------------------------------- 投影

/**
 * `buildContextEntries` —— entries → 下一轮要送模型的消息序列。
 *
 * 两条规则，按顺序应用：
 *  ① 从最后一条 compaction 之后重建：先放一条摘要消息，再从 `firstKeptEntryId` 开始追加
 *     （**含**那一条——P3 测试 4 的"第二次的边界起点 = 上一次 firstKeptEntryId"）。
 *  ② 投影时按 entry 类型翻译；`custom` 且 `forModel:false` 的直接丢掉。
 *
 * 【firstKeptEntryId 找不到时怎么办】保持"从压缩条目之后"的全量（不猜、不静默丢历史）。
 * 那是一个不该发生的状态（说明 entries 被裁过），宁可多给模型一点上下文。
 */
export function buildContextEntries(entries: readonly StoredEntry[]): AgentMessage[] {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const compactionIndex = findLastCompactionIndex(ordered);
  if (compactionIndex < 0) return projectAll(ordered);

  const payload = ordered[compactionIndex]!.payload as CompactionEntryPayload;
  const summary: CompactionSummaryMessage = {
    role: "compactionSummary",
    summary: payload.summary,
    firstKeptEntryId: payload.firstKeptEntryId,
    tokensBefore: payload.tokensBefore,
  };
  const keptFrom = ordered.findIndex((entry) => entry.id === payload.firstKeptEntryId);
  // 【为什么是两段拼起来】`firstKeptEntryId` 在压缩条目**之前**（它是"保留到哪"的边界），
  // 而压缩之后还有新条目（后续的对话）。只取 firstKept 之后会把压缩条目自己也发进去
  // （第二次摘要），只取压缩之后又会丢掉被保留的那一段。正确区间是 [K, C) ∪ (C, end]。
  const tail =
    keptFrom < 0
      ? ordered.slice(compactionIndex + 1)
      : [...ordered.slice(keptFrom, compactionIndex), ...ordered.slice(compactionIndex + 1)];
  return [summary, ...projectAll(tail)];
}

/** 最后一条 compaction entry（P3 的"累积文件清单"与测试要看它）。没有就是 null。 */
export function lastCompactionEntry(entries: readonly StoredEntry[]): StoredEntry | null {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const index = findLastCompactionIndex(ordered);
  return index < 0 ? null : (ordered[index] ?? null);
}

/** 所有 compaction 条目（按 seq 升序）。P3 累积摘要与 details 时用。 */
export function compactionEntries(entries: readonly StoredEntry[]): StoredEntry[] {
  return [...entries].filter((entry) => entry.type === "compaction").sort((a, b) => a.seq - b.seq);
}

function findLastCompactionIndex(ordered: readonly StoredEntry[]): number {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index]!.type === "compaction") return index;
  }
  return -1;
}

function projectAll(entries: readonly StoredEntry[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const entry of entries) {
    const message = projectEntry(entry);
    if (message !== null) out.push(message);
  }
  return out;
}

/**
 * 一条 entry → 一条消息（`null` = 这条不进模型）。**这是"哪些东西进模型"的唯一判据**，
 * 加一种新 entry 类型时改这里一处就够。
 */
export function projectEntry(entry: StoredEntry): AgentMessage | null {
  switch (entry.type) {
    case "message":
      return entry.payload as AgentMessage;
    case "compaction": {
      const payload = entry.payload as CompactionEntryPayload;
      return {
        role: "compactionSummary",
        summary: payload.summary,
        firstKeptEntryId: payload.firstKeptEntryId,
        tokensBefore: payload.tokensBefore,
      };
    }
    case "custom": {
      const payload = entry.payload as CustomEntryPayload;
      if (payload.forModel === false) return null;
      const message: CustomMessage = {
        role: "custom",
        customType: payload.customType,
        content: payload.content,
        display: payload.display,
      };
      return message;
    }
    default:
      return null;
  }
}

/** entry 是不是 note（导出与 UI 用它，避免各自比对字符串）。 */
export function isNoteEntry(entry: StoredEntry): boolean {
  if (entry.type !== "custom") return false;
  const payload = entry.payload as Partial<CustomEntryPayload>;
  return payload.customType === NOTE_CUSTOM_TYPE;
}

/** entry 的 payload 类型收窄（导出与测试用）。 */
export function typedEntry<T>(entry: StoredEntry, type: EntryType): T | null {
  return entry.type === type ? (entry.payload as T) : null;
}
