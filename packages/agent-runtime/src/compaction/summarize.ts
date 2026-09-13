/**
 * `compaction/summarize.ts` —— 结构化摘要的生成与"改过哪些文件"的累积（Phase 3；spec P3 §3）。
 *
 * 【这一层最容易踩的两个坑，都在这文件里解决】
 *  ① **摘要请求自己会超窗**：一次真实会话里有几十条工具结果，单条可能几十 KB。把它们
 *     原文塞进摘要请求，压缩就变成了"另一次超窗"。两道闸：单条工具结果截断到 2000 字符
 *     （pi 的口径），整段序列化再按 `reserveTokens` 卡总长（超了保留头尾、中间标省略）。
 *  ② **"改过哪些文件"会随压缩丢失**：摘要是自然语言，模型未必会把文件路径都写进去。
 *     所以文件清单是**结构化累积**的——本次摘要区间里的工具调用 + 上一份摘要的 details
 *     合并去重，写进 `CompactionEntry.details`，下一次压缩继续累积。
 *
 * 【为什么摘要走 `stream()` 而不是另开一个非流式接口】模型客户端只有一个出口（设计文档
 * §B.5：流是唯一真相）。摘要只要终态，所以这里把流消费掉再取 `result()`——少一个接口就
 * 少一处"两条路径行为不一致"的可能。
 */

import { maxTokensFor } from "../model/catalog.ts";
import type {
  AgentMessage,
  AssistantMessage,
  Content,
  LlmMessage,
  ModelClient,
  ModelRequest,
  Usage,
} from "../types.ts";
import { emptyUsage } from "../types.ts";
import { defaultConvertToLlm } from "../loop.ts";
import {
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./summary-prompt.ts";

/** 摘要过程的结构化失败（`index.ts` 把它翻成 Run 的 `compaction_failed`）。 */
export class CompactionError extends Error {
  readonly reason: "summarization_failed" | "aborted" | "empty_summary";

  constructor(reason: CompactionError["reason"], message: string) {
    super(message);
    this.name = "CompactionError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- 文件清单

/** 累积中的文件操作。三个集合分开是因为 edit 与 write 都算"改动过"（读与写的优先级不同）。 */
export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/**
 * 摘要条目里的文件清单形状（`CompactionEntryPayload.details` 用它）。
 *
 * 【为什么是 type 不是 interface】只有 type 别名才有 TS 的隐式索引签名，
 * `CompactionDetails` 带索引签名，interface 版本会报
 * “Index signature for type 'string' is missing”。
 */
export type FileLists = {
  readFiles: string[];
  modifiedFiles: string[];
};

export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** 从一条 assistant 消息的工具调用里收集文件路径（只认 read / write / edit 三个名字）。 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") return;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const path = typeof block.arguments["path"] === "string" ? (block.arguments["path"] as string) : null;
    if (path === null) continue;
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
      default:
        break;
    }
  }
}

/**
 * 合并一堆消息 + 上一份摘要的 details → 本次要写进 details 的两份清单。
 *
 * 【读过的文件为什么可以少】被改过的文件从"只读清单"里剔掉：模型更关心"我动过什么"，
 * 而"读过又改过"的文件出现在两份清单里只会浪费 token。
 */
export function extractFileOperations(messages: readonly AgentMessage[], previous?: FileLists | null): FileOperations {
  const fileOps = createFileOps();
  for (const path of previous?.readFiles ?? []) fileOps.read.add(path);
  for (const path of previous?.modifiedFiles ?? []) fileOps.edited.add(path);
  for (const message of messages) extractFileOpsFromMessage(message, fileOps);
  return fileOps;
}

/** 两个集合 → 排序后的清单（顺序稳定才能让 details 的字节可预期）。 */
export function computeFileLists(fileOps: FileOperations): FileLists {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((path) => !modified.has(path)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

/** 把清单拼成摘要正文末尾的两个标签块（没有内容就返回空串）。 */
export function formatFileOperations(lists: FileLists): string {
  const sections: string[] = [];
  if (lists.readFiles.length > 0) sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
  if (lists.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------- 对话序列化

/** 单条工具结果在摘要请求里的字符上限（pi 的口径，见文件头坑 ①）。 */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** 序列化时的总预算（字符）。`reserveTokens × 4` 就是"给摘要请求留的那部分窗口"。 */
export function summaryBudgetChars(reserveTokens: number): number {
  return Math.max(1, reserveTokens) * 4;
}

/** 截断一条工具结果，并**明确写出被截掉了多少**（模型知道"还有更多"，不会以为那就是全部）。 */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... 后面还有 ${text.length - maxChars} 个字符被截断]`;
}

/**
 * 把协议消息序列化成一段纯文本（摘要请求的正文）。
 *
 * 【为什么先转成 LlmMessage 再序列化】摘要要看到的应该是"模型当时看到的东西"——压缩摘要
 * 消息会被渲染成带前缀的 user 文本、自定义系统提示会带 `[系统提示]` 前缀，这些语义只在
 * `convertToLlm` 里定义一次。这里不自己再实现一遍。
 */
export function serializeConversation(messages: readonly LlmMessage[], budgetChars = Number.POSITIVE_INFINITY): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = contentText(message.content);
      if (content !== "") parts.push(`[User]: ${content}`);
      continue;
    }
    if (message.role === "assistant") {
      const thinking: string[] = [];
      const toolCalls: string[] = [];
      for (const block of message.content) {
        if (block.type === "thinking") thinking.push(block.thinking);
        else if (block.type === "toolCall") {
          const args = Object.entries(block.arguments)
            .map(([key, value]) => `${key}=${safeJson(value)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${args})`);
        }
      }
      if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      if (message.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(message.content)}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      continue;
    }
    const content = contentText(message.content);
    if (content !== "") parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
  }

  const serialized = parts.join("\n\n");
  return clampMiddle(serialized, budgetChars);
}

/**
 * 超预算时保留**头 + 尾**、中间标省略。
 *
 * 【为什么不只留最新的】最早的几条里通常有用户的原始诉求与约束（"不要改 X"），只留尾部
 * 会让摘要丢掉 Goal；反过来只留头部会丢掉"刚刚做到哪了"。两头都留是唯一不会结构性丢信息
 * 的简单做法（比例的 1/4 偏头部：开头通常短而关键）。
 */
function clampMiddle(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text;
  const marker = "\n\n[... 中间部分因为篇幅被省略 ...]\n\n";
  const headChars = Math.floor(budgetChars / 4);
  const tailChars = Math.max(0, budgetChars - headChars - marker.length);
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

/** 一串内容块里的可见文字（摘要与 prompt 渲染共用）。 */
function contentText(content: string | readonly Content[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<Content, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------- 摘要请求

export interface SummaryOptions {
  /** 摘要模型（默认与主模型相同，由调用方决定）。 */
  model: ModelClient;
  /** 给摘要请求预留的 token（决定 maxTokens 与序列化总预算）。 */
  reserveTokens: number;
  /** 上一份摘要（迭代更新用；没有就是首次摘要）。 */
  previousSummary?: string;
  signal?: AbortSignal;
}

export interface SummaryResult {
  text: string;
  usage: Usage;
}

/** 摘要请求的正文：`<conversation>` + 可选 `<previous-summary>` + 模板。 */
function buildSummaryPrompt(messages: readonly AgentMessage[], options: SummaryOptions): string {
  const conversation = serializeConversation(
    defaultConvertToLlm(messages),
    summaryBudgetChars(options.reserveTokens),
  );
  let prompt = `<conversation>\n${conversation}\n</conversation>\n\n`;
  if (options.previousSummary !== undefined && options.previousSummary !== "") {
    prompt += `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += options.previousSummary === undefined || options.previousSummary === "" ? SUMMARIZATION_PROMPT : UPDATE_SUMMARIZATION_PROMPT;
  return prompt;
}

/** 生成一份历史摘要（带上一份时是迭代更新）。 */
export async function generateSummary(messages: readonly AgentMessage[], options: SummaryOptions): Promise<SummaryResult> {
  return completeSummary(buildSummaryPrompt(messages, options), {
    label: "摘要",
    maxTokens: maxOutputTokens(options.reserveTokens, 0.8, options.model),
    ...options,
  });
}

/** 生成 split turn 的前半段摘要。 */
export async function generateTurnPrefixSummary(
  messages: readonly AgentMessage[],
  options: SummaryOptions,
): Promise<SummaryResult> {
  const conversation = serializeConversation(
    defaultConvertToLlm(messages),
    summaryBudgetChars(options.reserveTokens),
  );
  const prompt = `<conversation>\n${conversation}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  return completeSummary(prompt, {
    label: "turn prefix 摘要",
    maxTokens: maxOutputTokens(options.reserveTokens, 0.5, options.model),
    ...options,
  });
}

/** 摘要的输出上限：预留预算的一个比例，并且不超过模型自己的单轮上限。 */
function maxOutputTokens(reserveTokens: number, ratio: number, model: ModelClient): number {
  return Math.max(1, Math.min(Math.floor(ratio * reserveTokens), maxTokensFor(model.model)));
}

/** 发一次摘要请求并取回正文与用量。**不写 prompt cache**（一次性请求，见 client.ts）。 */
async function completeSummary(
  prompt: string,
  options: SummaryOptions & { label: string; maxTokens: number },
): Promise<SummaryResult> {
  const request: ModelRequest = {
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    tools: [],
    maxTokens: options.maxTokens,
    cache: "none",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const message = await complete(options.model, request, options.label);
  const text = contentText(message.content).trim();
  if (text === "") {
    // 空摘要会把整段历史换成一个空字符串——宁可整体失败，也不要静默丢上下文。
    throw new CompactionError("empty_summary", `${options.label}模型没有输出任何文本`);
  }
  return { text, usage: message.usage ?? emptyUsage() };
}

/** 消费一次模型流并取终态。失败（error / aborted）转成 `CompactionError`——见 `index.ts` 的接线。 */
async function complete(model: ModelClient, request: ModelRequest, label: string): Promise<AssistantMessage> {
  const stream = model.stream(request);
  for await (const _event of stream) {
    // 摘要只要终态；这里消费流是因为"流是唯一真相"（见文件头）。
  }
  const message = await stream.result();
  if (message.stopReason === "aborted") {
    throw new CompactionError("aborted", `${label}请求被取消`);
  }
  if (message.stopReason === "error" || message.stopReason === undefined) {
    throw new CompactionError("summarization_failed", `${label}请求失败：${message.errorMessage ?? "未知原因"}`);
  }
  return message;
}
