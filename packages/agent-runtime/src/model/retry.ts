/**
 * `retry.ts` —— 限流 / 超时的退避重试（模型调用的薄政策层）。
 *
 * 【为什么单独一个文件】"429 等一会儿再试"和"5xx 重试有意义"是**两件事的判断**，
 * 但它们共用同一套退避节奏（指数 + 上限 + 抖动）。把节奏抽出来之后，
 * 模型客户端只需要回答"这个错误值不值得重试"（`shouldRetry` 谓词）。
 *
 * 【为什么默认不做无限重试】agent 循环的每一次重试都是真金白银的输出 token 与用户等待。
 * 3 次、1s 起、上限 30s，是够覆盖"对端抖了一下"的量级；真的限流（429）应该由
 * 调用方决定要不要等更久（M3 的调度器），不是循环里偷偷等。
 *
 * 【可注入 `sleep` / `now`】测试要验"退避了多久"，不该真的睡 3 秒。
 */

import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

export interface RetryPolicy {
  /** 最多试几次（含第一次）。默认 3。 */
  attempts?: number;
  /** 第一次重试前等多久。默认 1000ms。 */
  baseDelayMs?: number;
  /** 每次失败的倍数。默认 2。 */
  factor?: number;
  /** 单次等待的上限。默认 30000ms（限流场景等太久没有意义，Run 本身有墙钟上限）。 */
  maxDelayMs?: number;
  /** 只有它说 true 的错误才重试。默认全部重试（调用方应给谓词）。 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 取消信号：等待期间被取消 → 立刻抛 `aborted`。 */
  signal?: AbortSignal;
  /** 每次决定重试时回调（记日志、记账）。 */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** 可注入的等待（测试用）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: LogFn;
}

export const DEFAULT_RETRY_POLICY: Required<Pick<RetryPolicy, "attempts" | "baseDelayMs" | "factor" | "maxDelayMs">> = {
  attempts: 3,
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 30_000,
};

/** 被调用方取消时抛的错（重试层与调用方都靠这个 reason 区分"等太久"与"用户不要了"）。 */
export class AbortedError extends Error {
  constructor(message = "重试等待被取消") {
    super(message);
    this.name = "AbortedError";
  }
}

/**
 * 跑一个可能失败的操作，失败时按指数退避重试。
 *
 * 语义：`shouldRetry(error, attempt)` 里的 `attempt` 是**已经失败的次数**（从 1 起）；
 * 它返回 false 就立刻把原错误抛出去。全部试完还是失败 → 抛**最后一次**的错误
 * （保留它自己的类型与 stack，调用方按 reason 分类）。
 */
export async function retryWithBackoff<T>(operation: () => Promise<T>, policy: RetryPolicy = {}): Promise<T> {
  const attempts = policy.attempts ?? DEFAULT_RETRY_POLICY.attempts;
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs;
  const factor = policy.factor ?? DEFAULT_RETRY_POLICY.factor;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs;
  const sleep = policy.sleep ?? sleepWithSignal;
  const log = policy.log ?? noopLog;
  const shouldRetry = policy.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error, attempt)) throw error;
      const delayMs = Math.min(maxDelayMs, Math.round(baseDelayMs * factor ** (attempt - 1)));
      policy.onRetry?.({ attempt, delayMs, error });
      log("warn", `第 ${attempt} 次尝试失败，${delayMs}ms 后重试`, {
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs, policy.signal);
    }
  }
  throw lastError;
}

/** 可被取消的等待。取消时抛 `AbortedError`（而不是静默返回——静默会让重试继续跑）。 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new AbortedError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
