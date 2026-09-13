/**
 * `limits.ts` —— 预算与守卫：**循环之外的政策**（设计文档 §B.2）。
 *
 * 【为什么不把 40 轮 / 30 分钟 / 300k 输出 token 写在循环里】M0 的循环自己管预算，
 * 后果是"给不同任务类型设不同上限"每次都要改循环结构。M2 把它们变成一个
 * `shouldStopAfterTurn` 策略函数（与 pi 一致）：循环只问"还要不要跑下一轮"，
 * 数值是可迭代资产，替换策略不碰循环。M3 的配额系统换的就是这个函数。
 *
 * 【为什么重复调用守卫也在这里】它和预算同类：是"什么时候该停下"的政策，不是循环机制。
 * 它挂在 `beforeToolCall` / `afterToolCall` 两个钩子上，循环本身不知道"重复"这个概念。
 */

import { noopLog } from "./log.ts";
import type { LogFn } from "./log.ts";
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  Content,
  ShouldStopAfterTurnContext,
} from "./types.ts";

// ---------------------------------------------------------------- 默认预算

/** 轮数上限（§4）。 */
export const DEFAULT_MAX_TURNS = 40;

/** 墙钟上限：30 分钟。 */
export const DEFAULT_WALL_CLOCK_MS = 30 * 60_000;

/**
 * 累计输出 token 上限。
 *
 * 300k 的理由与 M0 相同：40 轮 × 平均 7.5k 输出 token 的正常 Run 远远到不了；
 * 而一个"模型陷进疯狂输出"的 Run 会在烧掉几十美元之前先撞上它。
 */
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 300_000;

export interface BudgetLimits {
  maxTurns?: number;
  wallClockMs?: number;
  outputTokenBudget?: number;
}

/** 预算停下的三种原因（与 M0 的 `AgentStopReason` 同名同义）。 */
export type BudgetStopReason = "max_turns" | "wall_clock" | "output_token_budget";

/**
 * 默认停止策略。三件事的顺序与 M0 一致：轮数 → 墙钟 → 输出 token。
 * （M0 在每轮**开始前**查，这里在每轮**结束后**查——差值最多一轮，换来的是
 * 循环里再也没有预算代码。墙钟的**硬**约束由宿主挂的 abort 定时器负责，
 * 见 `deadline` 与 `control-plane/src/agent/run.ts`。）
 */
export interface StopPolicy {
  shouldStopAfterTurn(context: ShouldStopAfterTurnContext): boolean;
  /** 已经停了吗、为什么停（没停是 null）。宿主在循环结束后读它。 */
  readonly stopReason: BudgetStopReason | null;
  /** 对应的描述（写进 Run 结果与日志）。 */
  readonly detail: string | null;
  /** 墙钟到点的绝对毫秒时间。宿主据此给循环挂 abort 定时器。 */
  readonly deadline: number;
  /** 到目前为止累计的输出 token（诊断用）。 */
  readonly outputTokens: number;
}

export interface StopPolicyOptions {
  /** 可注入时钟（测试用它拨快墙钟）。 */
  now?: () => number;
  limits?: BudgetLimits;
}

/**
 * 建默认策略。**每个 Run 一个实例**（它是状态：累计输出、墙钟起点、停下的原因）。
 */
export function defaultStopPolicy(limits: BudgetLimits = {}, options: StopPolicyOptions = {}): StopPolicy {
  const maxTurns = limits.maxTurns ?? DEFAULT_MAX_TURNS;
  const wallClockMs = limits.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const outputTokenBudget = limits.outputTokenBudget ?? DEFAULT_OUTPUT_TOKEN_BUDGET;
  const now = options.now ?? Date.now;
  const deadline = now() + wallClockMs;

  let turns = 0;
  let outputTokens = 0;
  let stop: { reason: BudgetStopReason; detail: string } | null = null;

  return {
    shouldStopAfterTurn(context: ShouldStopAfterTurnContext): boolean {
      turns += 1;
      outputTokens += context.message.usage?.outputTokens ?? 0;
      if (turns >= maxTurns) {
        stop = { reason: "max_turns", detail: `达到轮数上限（${maxTurns} 轮）` };
      } else if (now() >= deadline) {
        stop = { reason: "wall_clock", detail: `达到墙钟上限（${Math.round(wallClockMs / 1000)}s），在第 ${turns} 轮停下` };
      } else if (outputTokens >= outputTokenBudget) {
        stop = {
          reason: "output_token_budget",
          detail: `达到累计输出 token 上限（${outputTokenBudget}），在第 ${turns} 轮停下`,
        };
      }
      return stop !== null;
    },
    get stopReason() {
      return stop?.reason ?? null;
    },
    get detail() {
      return stop?.detail ?? null;
    },
    get deadline() {
      return deadline;
    },
    get outputTokens() {
      return outputTokens;
    },
  };
}

// ---------------------------------------------------------------- 重复调用守卫

/** 同一工具 + 同样参数连续出现几次开始提示 / 几次就停（与 M0 相同的两个数）。 */
export const REPEAT_NOTICE_THRESHOLD = 3;
export const REPEAT_STOP_THRESHOLD = 4;

/** 重复调用的提示语（§4 的原文要求：说清"换个方法或者说明你卡在哪"）。 */
export const REPEAT_NOTICE =
  "你已经用相同的参数调用过这个工具三次，而且结果没有变化。换一个方法，或者说明你卡在哪里、需要什么信息。";

/** 重复到无可救药时的停止说明。 */
export const REPEAT_STOP = "同一调用连续出现太多次且结果没有变化，停止这次执行。";

/**
 * 重复守卫：挂 `beforeToolCall` 的**有状态政策**。
 *
 * 语义（与 M0 的 `trackRepeats` 一致）：**连续**——某个签名这一轮没出现就把它的计数
 * 清零（中间夹了别的调用说明模型在试探别的方法，不该算重复）。同一轮里多个相同签名
 * 只算一次。
 *
 * 与 M0 的一处差异：第 3 次**不执行**那个工具，直接把提示作为 isError 结果返回。
 * M0 是先执行、再往同一条消息里塞一条提示块——既然已经知道它是重复，就没有理由
 * 再跑一遍（这也是 pi 的 `block` 语义）。
 */
export interface RepeatGuard {
  beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined>;
  /** 已经注入过提示（一次 Run 只提示一次）。 */
  readonly noticeInjected: boolean;
  /** 这个 Run 是不是因为重复被停的（兼容层据此给出 `repeated_tool_calls` 终态）。 */
  readonly stopped: boolean;
  /** 停下来时用的说明（没停是 null）。 */
  readonly stopDetail: string | null;
  /** 当前各签名的连续计数（诊断/测试用）。 */
  counts(): ReadonlyMap<string, number>;
}

export interface RepeatGuardOptions {
  noticeThreshold?: number;
  stopThreshold?: number;
  notice?: string;
  stopDetail?: string;
  /** 旁路通知（兼容层接到 `note` 事件上）。 */
  onNote?: (kind: "repeat_notice" | "repeat_stop", message: string) => void;
  log?: LogFn;
}

export function createRepeatGuard(options: RepeatGuardOptions = {}): RepeatGuard {
  const noticeThreshold = options.noticeThreshold ?? REPEAT_NOTICE_THRESHOLD;
  const stopThreshold = options.stopThreshold ?? REPEAT_STOP_THRESHOLD;
  const notice = options.notice ?? REPEAT_NOTICE;
  const stopDetail = options.stopDetail ?? REPEAT_STOP;
  const log = options.log ?? noopLog;

  const counts = new Map<string, number>();
  /** 上一批（同一条 assistant 消息）是哪一个；换批就重算所有签名。 */
  let lastBatch: unknown = null;
  let noticeInjected = false;
  let stopped = false;

  const guard: RepeatGuard = {
    async beforeToolCall(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
      if (signal?.aborted === true) return undefined;
      if (context.assistantMessage !== lastBatch) {
        lastBatch = context.assistantMessage;
        updateBatchCounts(counts, context.assistantMessage.content);
      }
      const signature = signatureOf(context.toolCall);
      const count = counts.get(signature) ?? 0;
      if (count >= stopThreshold || (count >= noticeThreshold && noticeInjected)) {
        stopped = true;
        options.onNote?.("repeat_stop", `${stopDetail}（${signature} 连续 ${count} 次）`);
        log("warn", "重复调用达到停止阈值", { signature, count });
        return { block: true, reason: stopDetail, terminate: true };
      }
      if (count >= noticeThreshold) {
        noticeInjected = true;
        options.onNote?.("repeat_notice", notice);
        log("warn", "检测到重复调用，已插入提示", { signature, count });
        return { block: true, reason: notice };
      }
      return undefined;
    },
    get noticeInjected() {
      return noticeInjected;
    },
    get stopped() {
      return stopped;
    },
    get stopDetail() {
      return stopped ? stopDetail : null;
    },
    counts() {
      return counts;
    },
  };
  return guard;
}

/** 工具的调用签名：名字 + 参数的稳定 JSON（键排序，同样的参数必然同样签名）。 */
export function signatureOf(call: { name: string; arguments: unknown }): string {
  return `${call.name}(${stableJson(call.arguments)})`;
}

/** 参数的稳定序列化（键排序），用来判断"同样参数"。 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/**
 * 更新一整批的计数。**按 assistant 消息为单位**：同一批里的相同签名只算一次，
 * 这一批没出现的签名清零（"连续"的定义）。
 */
function updateBatchCounts(counts: Map<string, number>, content: readonly Content[]): void {
  const seen = new Set<string>();
  for (const block of content) {
    if (block.type !== "toolCall") continue;
    const signature = signatureOf(block);
    if (seen.has(signature)) continue;
    seen.add(signature);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  for (const key of [...counts.keys()]) {
    if (!seen.has(key)) counts.delete(key);
  }
}
