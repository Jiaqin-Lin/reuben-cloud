/**
 * `compaction/tokens.ts` —— token 估算与压缩阈值（Phase 3；spec P3 §1）。
 *
 * 【为什么用 chars/4 而不是 tokenizer】跨 provider（Anthropic / DeepSeek）的 tokenizer 不同，
 * 装两套的复杂度换来的精度提升，远不如"以真实 usage 为基线 + 只有尾部用估算"来得实在。
 * pi 的选择也是这个（设计文档 §E.4）。
 *
 * 【为什么基线取"最后一条能用的 assistant usage"】usage 是 provider 报的真实值（免费、
 * 精确），它覆盖了"到那一条为止的全部上下文"；它之后的消息才需要估。全部用 chars/4 会把
 * 误差按轮次累加，而压缩的触发点恰恰是"离窗口很近"的地方——那里最不能有累积误差。
 *
 * 【error / aborted 的 usage 不算基线】那两类的 usage 不完整（请求可能根本没发出去），
 * 拿它当基线会让估算凭空缩水 → 压缩不触发 → 下一次请求直接超窗。stopReason 缺失
 * （还在流式中的 partial）同理不算。
 */

import type { AgentMessage, AssistantMessage, Content, Usage } from "../types.ts";

/** 一次模型调用占用的总上下文量（四个量之和）。 */
export function calculateContextTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

/** 图片的字符估值（对齐 pi：一张图按 4800 字符算）。我们没有图片输入，但类型里有。 */
const ESTIMATED_IMAGE_CHARS = 4800;

/** 一条能当基线的 assistant 消息的 usage（不能当基线的返回 undefined，理由见文件头）。 */
function usageOf(message: AgentMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  const assistant = message as AssistantMessage;
  if (
    assistant.stopReason === undefined ||
    assistant.stopReason === "error" ||
    assistant.stopReason === "aborted" ||
    assistant.usage === undefined
  ) {
    return undefined;
  }
  return calculateContextTokens(assistant.usage) > 0 ? assistant.usage : undefined;
}

/**
 * 估一条消息的 token。返回值是**保守上界**：宁可多估（早压缩一点）也不要少估。
 *
 * 各 role 的口径与 spec P3 §1 一致：
 *  user / toolResult 算正文；assistant 算 text + thinking + 工具调用的名字与参数；
 *  compactionSummary / custom 算它们的文本。
 */
export function estimateTokens(message: AgentMessage): number {
  switch (message.role) {
    case "user":
      return Math.ceil(contentChars(message.content) / 4);
    case "assistant": {
      let chars = 0;
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") chars += block.name.length + safeJsonLength(block.arguments);
      }
      return Math.ceil(chars / 4);
    }
    case "toolResult":
      return Math.ceil(contentChars(message.content) / 4);
    case "compactionSummary":
      return Math.ceil(message.summary.length / 4);
    case "custom":
      return Math.ceil(message.content.length / 4);
    default:
      return 0;
  }
}

/** `string | Content[]` 的字符数（图片按固定估值，其它块按文本）。 */
function contentChars(content: string | Content[]): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** JSON.stringify 永远不会抛（参数里可能有循环引用，来自被救回来的坏 JSON）。 */
function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** 估算结果。拆成三段是为了让"哪一段在涨"可诊断（压缩触发时看的就是它）。 */
export interface ContextUsageEstimate {
  /** 估算的上下文总量（这就是与 `contextWindow` 比较的那个数）。 */
  tokens: number;
  /** 基线 usage 贡献的部分（精确值）。 */
  usageTokens: number;
  /** 基线之后用 chars/4 估的部分。 */
  trailingTokens: number;
  /** 基线那条消息的下标（没有基线是 null）。 */
  lastUsageIndex: number | null;
}

/**
 * 估当前上下文的 token 数。
 *
 * 【有基线时不要重估前面】基线之前的消息早就被 provider 计过价了，重估只会引入误差；
 * 只有基线之后（还没被任何 usage 覆盖）的消息需要估。
 */
export function estimateContextTokens(messages: readonly AgentMessage[]): ContextUsageEstimate {
  let usage: Usage | undefined;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const found = usageOf(messages[i]!);
    if (found !== undefined) {
      usage = found;
      index = i;
      break;
    }
  }

  if (usage === undefined) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }

  const usageTokens = calculateContextTokens(usage);
  let trailingTokens = 0;
  for (let i = index + 1; i < messages.length; i += 1) trailingTokens += estimateTokens(messages[i]!);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: index };
}

/** 压缩的阈值判据（`enabled` 为假时永远 false——手动触发不走这里）。 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: { enabled: boolean; reserveTokens: number }): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
