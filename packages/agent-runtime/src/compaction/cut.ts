/**
 * `compaction/cut.ts` —— 摘要区间的切点（Phase 3；spec P3 §2）。
 *
 * 【切点规则为什么不能随手定】压缩之后送进模型的是"摘要 + 保留的尾部"。切点落在哪里
 * 决定了三件事：模型还能看到多少完整上下文、协议上会不会出现孤立的 `tool_result`、
 * 以及"改过哪些文件"这类信息会不会被拦腰切断。三条硬规则：
 *
 *  ① **切点只能落在 turn 边界**：user / assistant / custom（自定义系统提示）消息。
 *     `tool_result` **绝不能**当切点——tool_use 与 tool_result 必须同生共死，切成两半
 *     下一次请求就是 400（Anthropic 的硬约束）。
 *  ② **单个 turn 本身就超过保留预算时，允许切在 turn 中间**（split turn）：前半段单独
 *     生成一份"turn prefix 摘要"，与历史摘要合并。没有这条，一个超长 turn 会让压缩
 *     永远无法推进（切点只能落在 user 上，而那个 user 又必须被保留）。
 *  ③ **第二次压缩的起点是上一次的 `firstKeptEntryId`**（不是压缩条目本身）：上次幸存的
 *     消息这次仍要纳入摘要，否则它们会永远卡在窗口里（spec P3 §2 的原话）。
 *
 * 【entry 是什么、消息是什么】存储里的 entry 是"发生过的事实"（可能有 note 这种不进模型的
 * 元数据），下一轮要的是消息序列。两者的翻译只有一处：`projectEntry`。所以这一层不自己
 * 判断"哪种 entry 算消息"，而是问 `projectEntry`——将来加一种 entry 类型时改一处就够。
 */

import { projectEntry } from "../session/entries.ts";
import type { StoredEntry } from "../session/store.ts";
import type { AgentMessage } from "../types.ts";
import { estimateTokens } from "./tokens.ts";

/** 一条 entry 投影成的消息（`null` = 这条不进模型，例如 note）。 */
export type ProjectedMessage = AgentMessage | null;

/** 投影一条 entry（薄包装，让 cut.ts 读起来不用每次都 import 两个模块）。 */
export function projectedMessage(entry: StoredEntry): ProjectedMessage {
  return projectEntry(entry);
}

/** 切点选择的结果（与 pi 的 `CutPointResult` 同形）。 */
export interface CutPointResult {
  /** 保留下来的第一条 entry 的下标（`items` 里的下标）。 */
  firstKeptEntryIndex: number;
  /** split turn 时，被切开的那个 turn 的起点下标；不是 split 时是 -1。 */
  turnStartIndex: number;
  /** 切点落在一个 turn 的中间（该 turn 的后半段被留下，前半段要单独摘要）。 */
  isSplitTurn: boolean;
}

/**
 * 找出 `[startIndex, endIndex)` 里所有可用的切点。
 *
 * 【为什么 assistant 也是切点】切在 assistant 上意味着"这条 assistant 之后的内容全部保留"，
 * 而它之前（含它自己）进摘要——那是合法的 turn 中间切法（split turn 的 `firstKeptEntryIndex`）。
 * 真正不能切的是 `tool_result`（见文件头规则 ①）与压缩摘要本身（它已经是摘要了）。
 */
export function findValidCutPoints(entries: readonly StoredEntry[], startIndex: number, endIndex: number): number[] {
  const points: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const message = projectedMessage(entries[index]!);
    if (message === null) continue;
    switch (message.role) {
      case "user":
      case "assistant":
      case "custom":
        points.push(index);
        break;
      case "toolResult":
      case "compactionSummary":
        break;
    }
  }
  return points;
}

/**
 * 找一条 entry 所属 turn 的起点（最近的一条 user 消息）。
 * 摘要条目之前没有可归的起点（摘要覆盖的 turn 已经不在列表里了）→ -1。
 */
export function findTurnStartIndex(entries: readonly StoredEntry[], entryIndex: number, startIndex: number): number {
  for (let index = entryIndex; index >= startIndex; index -= 1) {
    const message = projectedMessage(entries[index]!);
    if (message === null) continue;
    if (message.role === "user") return index;
    if (message.role === "compactionSummary") return -1;
  }
  return -1;
}

/**
 * 挑切点：从最新往回累加 token，首次达到 `keepRecentTokens` 时停下，取"不早于该下标的
 * 最小可用切点"。找不到可用切点时退回列表开头（等于"这次没什么可压的"，调用方会跳过）。
 */
export function findCutPoint(
  entries: readonly StoredEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    const message = projectedMessage(entries[index]!);
    if (message === null) continue;
    accumulatedTokens += estimateTokens(message);
    if (accumulatedTokens >= keepRecentTokens) {
      // 往后挪到最近的合法切点：index 本身可能是 tool_result（不能切），挪到下一个
      // 合法切点意味着"宁可多压一点，也不切出孤立的 tool_result"（对齐 pi）。
      //
      // 【切点之后只剩 tool_result 时为什么往回退】那说明尾巴是一大段工具输出——
      // 往后没有切点了。退回**之前**最近的切点（通常是发这批调用的那条 assistant）：
      // 保留区会比预算大一点，但绝不能退回列表开头——那等于"什么都不压"，
      // 而这一轮要压的恰恰是那段工具结果**前面**的历史。
      const next = cutPoints.find((point) => point >= index);
      cutIndex = next ?? lastCutPointBefore(cutPoints, index) ?? cutPoints[0]!;
      break;
    }
  }

  // 往回吃掉紧邻的元数据条目（note 之类不进模型的东西）：它们跟着保留区一起走，
  // 免得"一条看不见的 note"成为摘要区间的最后一条（对齐 pi）。
  while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1]!;
    if (previous.type === "compaction") break;
    if (projectedMessage(previous) !== null) break;
    cutIndex -= 1;
  }

  // 判定 turn 边界时看**第一条真的进模型的消息**：note 这类元数据条目不影响上下文，
  // 让它们决定"切点是不是 turn 起点"会得出一个与模型看到的东西无关的结论。
  let decisionIndex = cutIndex;
  while (decisionIndex < endIndex && projectedMessage(entries[decisionIndex]!) === null) decisionIndex += 1;
  const cutMessage = decisionIndex < endIndex ? projectedMessage(entries[decisionIndex]!) : null;
  const isUserMessage = cutMessage?.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, decisionIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

/** 小于 `index` 的最后一个切点（没有就是 undefined）。 */
function lastCutPointBefore(cutPoints: readonly number[], index: number): number | undefined {
  let found: number | undefined;
  for (const point of cutPoints) {
    if (point < index) found = point;
  }
  return found;
}
