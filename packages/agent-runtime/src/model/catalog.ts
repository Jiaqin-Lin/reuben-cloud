/**
 * `catalog.ts` —— 模型目录：`contextWindow` / `maxTokens` / 成本（M2 Phase 1 新增的小文件）。
 *
 * 【为什么它必须有，而且必须在 agent-runtime】压缩（P3）与上下文编译（P10）都要回答
 * "这个模型能装多少 token、单轮最多能吐多少"。M0 把这两个数散在 `max_tokens: 64000`
 * 的调用点与直觉里；一旦 compaction 上线，"窗口"就是一个**要被计算**的数
 * （`tokens > contextWindow - reserveTokens` 就是压缩的触发条件）。
 *
 * 【为什么未知模型不是报错】模型名是配置（`REUBEN_CLOUD_MODEL`），换一个没登记的名字
 * 不该让 Run 起不来。保守默认 + 一条 warn：宁可压缩早一点发生，也不要上下文爆掉。
 *
 * 【cost 为什么留空】M2 的账本（`usage_ledger`）允许 `cost_usd` 为空，而 M2 没有任何
 * 消费者读它（成本看板是 M3）。填一份没有定价来源的数字比留空更糟——它会被当成真的。
 * 类型留着，M3 接看板时一次性补齐。
 */

import { noopLog } from "../log.ts";
import type { LogFn } from "../log.ts";

/** 每百万 token 的美元价（M3 的成本看板用；M2 不读，见文件头）。 */
export interface ModelCost {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface ModelInfo {
  /** 上下文窗口（token）。压缩的触发阈值由它算出来。 */
  contextWindow: number;
  /** 单轮输出上限（token）。发给 provider 的 `max_tokens`。 */
  maxTokens: number;
  cost?: ModelCost;
}

/**
 * 未知模型的保守默认。**故意比任何真实模型都小**：把它当成"窗口很窄"会让压缩早触发，
 * 早压缩只是多花一次摘要的钱；反过来（把窄窗口当宽窗口）会让请求直接失败。
 */
export const CONSERVATIVE_MODEL_INFO: ModelInfo = { contextWindow: 128_000, maxTokens: 16_000 };

/** 已知模型。键就是 provider 的模型名（与 `REUBEN_CLOUD_MODEL` 的字面值一致）。 */
export const MODEL_CATALOG: Record<string, ModelInfo> = {
  "claude-opus-4-8": { contextWindow: 200_000, maxTokens: 64_000 },
  "claude-sonnet-5": { contextWindow: 200_000, maxTokens: 64_000 },
  "claude-haiku-4-5": { contextWindow: 200_000, maxTokens: 64_000 },
  "deepseek-flash": { contextWindow: 128_000, maxTokens: 8_192 },
  "deepseek-chat": { contextWindow: 128_000, maxTokens: 8_192 },
  "deepseek-reasoner": { contextWindow: 128_000, maxTokens: 64_000 },
};

/**
 * 查一个模型的窗口与输出上限。**未知模型打一条 warn 并返回保守默认**
 * （warn 只在对同一个模型重复查询时出现一次是调用方的事；这里每次都打，
 * 因为目录查询是低频调用——每个 Run 一次）。
 */
export function lookupModel(model: string, log: LogFn = noopLog): ModelInfo {
  const found = MODEL_CATALOG[model];
  if (found !== undefined) return found;
  log("warn", `模型目录里没有 ${model}，按保守默认处理（压缩会更早触发）`, {
    contextWindow: CONSERVATIVE_MODEL_INFO.contextWindow,
    maxTokens: CONSERVATIVE_MODEL_INFO.maxTokens,
  });
  return CONSERVATIVE_MODEL_INFO;
}

/**
 * 单轮输出上限（不打 warn 的版本）。循环的每一轮都要用它，而"未知模型"这件事
 * 每个 Run 说一次就够了——那次在 `lookupModel()` 里说。
 */
export function maxTokensFor(model: string): number {
  return (MODEL_CATALOG[model] ?? CONSERVATIVE_MODEL_INFO).maxTokens;
}
