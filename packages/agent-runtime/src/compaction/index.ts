/**
 * `compaction/index.ts` —— 压缩的触发、准备与落库（Phase 3；spec P3 §4）。
 *
 * 【压缩在系统里的位置】它只改变"送去模型的投影"，历史一行不删（设计文档 §E.4）。
 * 落到代码上就是三件事：
 *  ① **准备**（`prepareCompaction`）：把 entries 投影成"摘要区间 / turn 前缀 / 保留尾部"三段；
 *  ② **生成**（`compact`）：跑摘要模型，把结果与累积的文件清单拼成一条 `CompactionEntry`；
 *  ③ **接线**（`createCompactionController`）：挂在循环的两个钩子上——
 *     `prepareNextTurn`（阈值到点 / `--compact` 手动）与 `recoverFromModelError`（溢出恢复）。
 *
 * 【为什么"挂载"也在这里，而不是各调用方各写一遍】压缩有三条触发路径，它们的共同点
 * 是"什么时候压、压完把上下文换成什么"——这三件事必须一起对。散在 CP 的会话编排里，
 * 产品路径（`handleUserMessage`）与手工脚本（`agent:run`）一定会漂。
 *
 * 【compaction_failed 怎么走到 Run 的终态】摘要有一步失败（`prepareCompaction` 找不到
 * 可压的区间、或者摘要模型报错），控制器返回 `{stop: {reason: "compaction_failed", …}}`；
 * 循环发一条同名 `note` 然后收工，宿主的停止原因映射表认得这个名字。**不重试**——
 * "压缩 → 还想压 → 再压缩"是一个只会烧钱的死循环（spec P3 的技术边界）。
 */

import { lookupModel } from "../model/catalog.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { buildContextEntries, entryForCompaction, projectEntry } from "../session/entries.ts";
import type { CompactionEntryPayload } from "../session/entries.ts";
import type { SessionStore, StoredEntry, UsageRow } from "../session/store.ts";
import type {
  AgentContext,
  AgentLoopTurnUpdate,
  AgentMessage,
  CompactionReason,
  ModelClient,
  ModelFailureRecoveryContext,
  PrepareNextTurnContext,
  Usage,
} from "../types.ts";
import { accumulateUsage } from "../types.ts";
import { findCutPoint } from "./cut.ts";
import type { FileLists, FileOperations } from "./summarize.ts";
import {
  CompactionError,
  computeFileLists,
  extractFileOperations,
  formatFileOperations,
  generateSummary,
  generateTurnPrefixSummary,
} from "./summarize.ts";
import { estimateContextTokens, shouldCompact } from "./tokens.ts";

// ---------------------------------------------------------------- 配置

export interface CompactionSettings {
  /** 自动压缩的总开关（`--compact` 手动触发不受它限制）。 */
  enabled: boolean;
  /** 给摘要请求 + 摘要输出留的窗口（触发阈值的一部分）。 */
  reserveTokens: number;
  /** 压缩后近似保留的近期上下文 token 数。 */
  keepRecentTokens: number;
  /** 摘要模型名（缺省与主模型相同；换便宜模型是配置，不是默认）。 */
  summaryModel?: string;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export const ENV_COMPACTION_ENABLED = "REUBEN_CLOUD_COMPACTION_ENABLED";
export const ENV_COMPACTION_RESERVE_TOKENS = "REUBEN_CLOUD_COMPACTION_RESERVE_TOKENS";
export const ENV_COMPACTION_KEEP_TOKENS = "REUBEN_CLOUD_COMPACTION_KEEP_TOKENS";
export const ENV_COMPACTION_SUMMARY_MODEL = "REUBEN_CLOUD_COMPACTION_SUMMARY_MODEL";

/** env → 配置。坏值**抛错**（静默退回默认值会让"明明配了却没生效"变成一个谜）。 */
export function compactionSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<CompactionSettings> {
  const settings: Partial<CompactionSettings> = {};
  const enabled = (env[ENV_COMPACTION_ENABLED] ?? "").trim();
  if (enabled !== "") settings.enabled = !["0", "false", "off", "no"].includes(enabled.toLowerCase());
  const reserve = positiveInt(env[ENV_COMPACTION_RESERVE_TOKENS], ENV_COMPACTION_RESERVE_TOKENS);
  if (reserve !== undefined) settings.reserveTokens = reserve;
  const keep = positiveInt(env[ENV_COMPACTION_KEEP_TOKENS], ENV_COMPACTION_KEEP_TOKENS);
  if (keep !== undefined) settings.keepRecentTokens = keep;
  const summaryModel = (env[ENV_COMPACTION_SUMMARY_MODEL] ?? "").trim();
  if (summaryModel !== "") settings.summaryModel = summaryModel;
  return settings;
}

function positiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数，收到 ${JSON.stringify(raw)}`);
  return value;
}

// ---------------------------------------------------------------- 溢出识别

/**
 * "上下文超出窗口"的报错文案（各家不一样，所以是一张表）。
 *
 * 【为什么只留这几条】我们只有两家 provider（Anthropic / DeepSeek 的 Anthropic 兼容端点），
 * 这张表是 pi 那张大表的**子集**（pi 要覆盖十几个后端）。多写的每一条都是"可能误判"的
 * 入口：误判的代价是把一次本来可以失败的请求当成"压一压还能救"，多烧一次摘要的钱。
 * 真接第三家时按它的报错文案补一条，并在这里写清是哪家的原话。
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic：prompt is too long: 213462 tokens > 200000 maximum
  /request_too_large/i, // Anthropic：413 request_too_large
  /maximum context length/i, // DeepSeek / OpenRouter：This model's maximum context length is X tokens
  /context[_ ]length[_ ]exceeded/i, // 通用兜底（OpenAI 风格）
  /reduce the length of the messages/i, // 通用兜底
  /too many tokens/i, // 通用兜底
];

/** 这条错误是不是"上下文超出窗口"。`errorMessage` 为空时恒 false（不猜）。 */
export function isContextOverflowError(message: string | undefined | null): boolean {
  if (message === undefined || message === null || message === "") return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

// ---------------------------------------------------------------- 准备

/** 压缩的三段切分（`compact()` 的输入）。 */
export interface CompactionPreparation {
  /** 要被总结掉的旧消息（不含 turn 前缀）。 */
  messagesToSummarize: AgentMessage[];
  /** split turn 时，被切开的那个 turn 的前半段（单独生成一份摘要）。 */
  turnPrefixMessages: AgentMessage[];
  /** 压缩后仍然完整保留的消息（从切点之后）。 */
  retainedTail: AgentMessage[];
  isSplitTurn: boolean;
  /** 压缩前的上下文估算（写进条目与事件，事后能对账）。 */
  tokensBefore: number;
  /** 上一份摘要（迭代更新用）。 */
  previousSummary?: string;
  /** 上一份摘要累积的文件清单（本次继续累积）。 */
  previousDetails: FileLists | null;
  /** 本次区间收集到的文件操作（与 `previousDetails` 合并后写进新条目）。 */
  fileOps: FileOperations;
  settings: CompactionSettings;
  /** 保留区的第一条 entry（投影从它开始；这也是"第二次压缩的起点"）。 */
  firstKeptEntryId: string;
}

/**
 * 把 entries 切成三段。没有可压的区间（空会话 / 最后一条就是压缩条目 / 全在保留区）
 * 返回 undefined——调用方据此决定"跳过"还是"报告压缩失败"。
 */
export function prepareCompaction(
  entries: readonly StoredEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0) return undefined;
  // 最后一条就是压缩条目：自上次压缩以来没有任何新东西，压了也是原地踏步。
  if (ordered[ordered.length - 1]!.type === "compaction") return undefined;

  let previousSummary: string | undefined;
  let previousDetails: FileLists | null = null;
  let items: StoredEntry[];

  const lastCompactionIndex = findLastCompactionIndex(ordered);
  if (lastCompactionIndex < 0) {
    items = ordered;
  } else {
    const payload = ordered[lastCompactionIndex]!.payload as CompactionEntryPayload;
    previousSummary = payload.summary;
    previousDetails = readFileLists(payload.details);
    // 上次压缩的起点：从它开始才是"上次幸存下来的消息"（spec P3 §2 规则 ③）。
    const keptFrom = ordered.findIndex((entry) => entry.id === payload.firstKeptEntryId);
    const start = keptFrom >= 0 ? keptFrom : lastCompactionIndex + 1;
    // 区间 [K, C) ∪ (C, end]：C 是压缩条目自己，它在 seq 上排在它保留的内容**之后**，
    // 但在投影里排在最前——所以这里要显式把它（以及更早的压缩条目）剔出去。
    items = [...ordered.slice(start, lastCompactionIndex), ...ordered.slice(lastCompactionIndex + 1)].filter(
      (entry) => entry.type !== "compaction",
    );
  }
  if (items.length === 0) return undefined;

  const tokensBefore = estimateContextTokens(buildContextEntries(ordered)).tokens;
  const cut = findCutPoint(items, 0, items.length, settings.keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize = messagesOf(items.slice(0, historyEnd));
  const turnPrefixMessages = cut.isSplitTurn
    ? messagesOf(items.slice(cut.turnStartIndex, cut.firstKeptEntryIndex))
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

  const firstKept = items[cut.firstKeptEntryIndex]!;
  return {
    messagesToSummarize,
    turnPrefixMessages,
    retainedTail: messagesOf(items.slice(cut.firstKeptEntryIndex)),
    isSplitTurn: cut.isSplitTurn,
    tokensBefore,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    previousDetails,
    fileOps: extractFileOperations([...messagesToSummarize, ...turnPrefixMessages], previousDetails),
    settings,
    firstKeptEntryId: firstKept.id,
  };
}

/** 一段 entries → 消息序列（跳过不进模型的元数据条目与摘要条目）。 */
function messagesOf(entries: readonly StoredEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    const message = projectEntry(entry);
    if (message === null || message.role === "compactionSummary") continue;
    messages.push(message);
  }
  return messages;
}

function findLastCompactionIndex(entries: readonly StoredEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.type === "compaction") return index;
  }
  return -1;
}

/** 从上一份摘要的 details 里读回文件清单（形状不对时当作没有，不猜）。 */
function readFileLists(details: unknown): FileLists | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const record = details as Record<string, unknown>;
  const readFiles = stringArray(record["readFiles"]);
  const modifiedFiles = stringArray(record["modifiedFiles"]);
  if (readFiles === null && modifiedFiles === null) return null;
  return { readFiles: readFiles ?? [], modifiedFiles: modifiedFiles ?? [] };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

// ---------------------------------------------------------------- 生成

export interface CompactOptions {
  /** 摘要模型（默认与主模型相同，由控制器决定）。 */
  model: ModelClient;
  signal?: AbortSignal;
  log?: LogFn;
}

export interface CompactOutcome {
  /** 摘要正文（末尾已带 `<read-files>` / `<modified-files>` 标签块）。 */
  summary: string;
  /** 摘要调用的用量（进账本，`kind='compaction'`）。 */
  usage: Usage;
  /** 累积后的文件清单（写进条目的 details）。 */
  details: FileLists;
}

/**
 * 跑摘要。split turn 是两次请求（历史 + turn 前缀）合并成一份摘要：前缀摘要是"看懂后缀"
 * 的补充说明，放在历史摘要之后（`compact` 只做拼接，合并的语义在提示词里）。
 */
export async function compact(preparation: CompactionPreparation, options: CompactOptions): Promise<CompactOutcome> {
  const { settings } = preparation;
  const base = {
    model: options.model,
    reserveTokens: settings.reserveTokens,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  let summary: string;
  let usage: Usage;
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    let historyText = "（这一段没有更早的历史。）";
    let historyUsage: Usage | null = null;
    if (preparation.messagesToSummarize.length > 0) {
      const history = await generateSummary(preparation.messagesToSummarize, {
        ...base,
        ...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
      });
      historyText = history.text;
      historyUsage = history.usage;
    }
    const prefix = await generateTurnPrefixSummary(preparation.turnPrefixMessages, base);
    summary = `${historyText}\n\n---\n\n**本轮前半段（split turn）：**\n\n${prefix.text}`;
    usage = historyUsage === null ? prefix.usage : accumulateUsage(historyUsage, prefix.usage);
  } else {
    const result = await generateSummary(preparation.messagesToSummarize, {
      ...base,
      ...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
    });
    summary = result.text;
    usage = result.usage;
  }

  const details = computeFileLists(preparation.fileOps);
  return { summary: `${summary}${formatFileOperations(details)}`, usage, details };
}

// ---------------------------------------------------------------- 控制器

/** 压缩条目的写入口（会话层注入它，才能把对话树的 leaf 接下去）。 */
export type CompactionAppend = (input: { payload: CompactionEntryPayload; usage: UsageRow }) => Promise<string>;

/** 压缩失败的结构化原因（Run 的终态与日志都用这一句话）。 */
export interface CompactionFailure {
  reason: "compaction_failed";
  detail: string;
}

export interface CompactionControllerOptions {
  store: SessionStore;
  sessionId: string;
  /** 本次执行的 id（压缩条目挂在它下面；缺省 null = 会话级条目）。 */
  runId?: string | null;
  /** 主模型：上下文窗口从它的名字查目录，摘要默认也用它。 */
  model: ModelClient;
  /** 摘要模型（`REUBEN_CLOUD_COMPACTION_SUMMARY_MODEL` 时由调用方另建一个客户端）。 */
  summaryModel?: ModelClient;
  /** 覆盖默认配置（缺省 = env 覆盖默认值）。 */
  settings?: Partial<CompactionSettings>;
  /** 上下文窗口覆盖（测试用；缺省查模型目录）。 */
  contextWindow?: number;
  /** 写压缩条目。不给就退化成 `store.appendEntry`（对话树会缺一个 parent 链，仅测试路径）。 */
  appendCompaction?: CompactionAppend;
  /** 第 N 次 `prepareNextTurn` 时强制压缩一次（`agent:run --compact`；只生效一次）。 */
  forceAtTurn?: number | null;
  env?: NodeJS.ProcessEnv;
  log?: LogFn;
}

/**
 * 压缩控制器。**一个 Run 一个实例**（它持有轮次计数与失败状态）。
 */
export interface CompactionController {
  /** 挂在循环的 `prepareNextTurn` 上（阈值触发 / 手动强制）。 */
  prepareNextTurn(context: PrepareNextTurnContext): Promise<AgentLoopTurnUpdate | undefined>;
  /** 挂在循环的 `recoverFromModelError` 上（溢出恢复：强制压一次再重试本轮）。 */
  recoverFromModelError(context: ModelFailureRecoveryContext): Promise<AgentLoopTurnUpdate | undefined>;
  /** 已经成功压缩的次数（诊断与测试用）。 */
  readonly compactions: number;
  /** 上一次压缩失败的原因（诊断用；Run 的终态由 note 事件给出）。 */
  readonly failure: CompactionFailure | null;
  readonly settings: CompactionSettings;
}

export function createCompactionController(options: CompactionControllerOptions): CompactionController {
  const log = options.log ?? noopLog;
  const settings: CompactionSettings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...compactionSettingsFromEnv(options.env ?? process.env),
    ...options.settings,
  };
  const store = options.store;
  const sessionId = options.sessionId;
  const runId = options.runId ?? null;
  const summaryModel = options.summaryModel ?? options.model;
  const contextWindow = options.contextWindow ?? lookupModel(options.model.model, log).contextWindow;
  const forceAtTurn = options.forceAtTurn ?? null;

  let turnCalls = 0;
  let forceUsed = false;
  let compactions = 0;
  let failure: CompactionFailure | null = null;

  /** 一次压缩尝试的三种结果：压成了 / 没东西可压 / 压失败了。 */
  type Attempt =
    | { kind: "compacted"; preparation: CompactionPreparation; outcome: CompactOutcome }
    | { kind: "nothing" }
    | { kind: "failed"; detail: string };

  async function attempt(reason: CompactionReason, signal: AbortSignal | undefined): Promise<Attempt> {
    let preparation: CompactionPreparation | undefined;
    try {
      const entries = await store.listEntries(sessionId);
      preparation = prepareCompaction(entries, settings);
    } catch (error) {
      // 读 entries 失败是存储问题，不是"没东西可压"——如实报。
      return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (preparation === undefined) return { kind: "nothing" };

    let outcome: CompactOutcome;
    try {
      outcome = await compact(preparation, {
        model: summaryModel,
        ...(signal === undefined ? {} : { signal }),
        log,
      });
    } catch (error) {
      if (error instanceof CompactionError && error.reason === "aborted") return { kind: "nothing" };
      if (signal?.aborted === true) return { kind: "nothing" };
      return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
    }

    const payload: CompactionEntryPayload = {
      summary: outcome.summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: outcome.details,
      usage: outcome.usage,
    };
    const usageRow: UsageRow = {
      kind: "compaction",
      provider: summaryModel.provider,
      model: summaryModel.model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheReadTokens: outcome.usage.cacheReadInputTokens,
      cacheWriteTokens: outcome.usage.cacheCreationInputTokens,
    };
    let entryId: string;
    try {
      // 摘要已经生成（钱花出去了），但落在存储上才是事实——写不进去时按结构化失败收尾，
      // 不让一个存储错误冒泡成"循环崩了"（那会连上下文都丢）。
      entryId =
        options.appendCompaction !== undefined
          ? await options.appendCompaction({ payload, usage: usageRow })
          : await store.appendEntry(sessionId, runId, entryForCompaction(payload), { usage: usageRow });
    } catch (error) {
      return { kind: "failed", detail: `压缩条目落库失败：${error instanceof Error ? error.message : String(error)}` };
    }

    compactions += 1;
    log("info", `上下文已压缩（${reason}）`, {
      tokensBefore: preparation.tokensBefore,
      firstKeptEntryId: preparation.firstKeptEntryId,
      summarized: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length,
      kept: preparation.retainedTail.length,
      splitTurn: preparation.isSplitTurn,
      entryId,
    });
    return { kind: "compacted", preparation, outcome };
  }

  /** 压完之后的下一轮上下文：从 entries 重新投影（存储是唯一真相）。 */
  async function rebuild(
    current: { context: AgentContext },
    reason: CompactionReason,
    preparation: CompactionPreparation,
    dropTrailingAssistant: boolean,
  ): Promise<AgentLoopTurnUpdate> {
    const entries = await store.listEntries(sessionId);
    const messages = buildContextEntries(entries);
    if (dropTrailingAssistant) {
      // 溢出恢复：末尾那条是刚失败的 assistant 尝试，它没有任何产出；重试的请求必须以
      // 用户那句话结尾（末条是 assistant 的话模型会去续写它）。
      while (messages.length > 0 && messages[messages.length - 1]!.role === "assistant") messages.pop();
    }
    return {
      context: { ...current.context, messages },
      compaction: { reason, tokensBefore: preparation.tokensBefore, firstKeptEntryId: preparation.firstKeptEntryId },
    };
  }

  function failed(detail: string): AgentLoopTurnUpdate {
    failure = { reason: "compaction_failed", detail };
    return { stop: { reason: "compaction_failed", detail } };
  }

  /**
   * 撞上意外异常时的兜底：**压缩失败必须是一条结构化终态**，不能让异常冒泡成
   * 循环崩溃（`loop_crashed` 会把这一次 Run 的消息都丢掉，排障时看不到发生了什么）。
   * 用户 abort 的情况除外——那不是失败，什么都不做、交给循环自己收尾。
   */
  async function guarded(
    signal: AbortSignal | undefined,
    run: () => Promise<AgentLoopTurnUpdate | undefined>,
  ): Promise<AgentLoopTurnUpdate | undefined> {
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted === true) return undefined;
      const detail = error instanceof Error ? error.message : String(error);
      log("error", "压缩过程中出了意外（按 compaction_failed 收尾）", { error: detail });
      return failed(`上下文压缩出错：${detail}`);
    }
  }

  return {
    prepareNextTurn(context: PrepareNextTurnContext): Promise<AgentLoopTurnUpdate | undefined> {
      return guarded(context.signal, async () => {
        if (!settings.enabled) return undefined;
        turnCalls += 1;
        const forced = forceAtTurn !== null && !forceUsed && turnCalls >= forceAtTurn;
        const estimate = estimateContextTokens(context.context.messages);
        if (!forced && !shouldCompact(estimate.tokens, contextWindow, settings)) return undefined;
        if (forced) forceUsed = true;

        const reason: CompactionReason = forced ? "manual" : "threshold";
        const result = await attempt(reason, context.signal);
        if (result.kind === "nothing") return undefined;
        if (result.kind === "failed") return failed(`上下文压缩失败：${result.detail}`);
        return rebuild(context, reason, result.preparation, false);
      });
    },

    recoverFromModelError(context: ModelFailureRecoveryContext): Promise<AgentLoopTurnUpdate | undefined> {
      return guarded(context.signal, async () => {
        if (!settings.enabled) return undefined;
        if (context.attempt > 0) return undefined;
        if (!isContextOverflowError(context.message.errorMessage)) return undefined;

        const result = await attempt("overflow", context.signal);
        if (result.kind === "failed") return failed(`上下文超出窗口，压缩失败：${result.detail}`);
        if (result.kind === "nothing") {
          return failed("上下文超出窗口，但已经没有可压缩的历史了");
        }
        return rebuild(context, "overflow", result.preparation, true);
      });
    },

    get compactions() {
      return compactions;
    },
    get failure() {
      return failure;
    },
    get settings() {
      return settings;
    },
  };
}
