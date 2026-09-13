/**
 * `index.ts` —— `@reuben-cloud/agent-runtime` 的公开面。
 *
 * 【为什么要有这个文件】CP 只从这一个入口 import（`@reuben-cloud/agent-runtime`），
 * 而不是深挖 `src/loop.ts` 这类路径。好处是"包内哪些东西是契约"变得显式：
 * 加一个内部文件不会自动变成别人可依赖的 API。
 *
 * 【这里导出什么、不导出什么】导出契约（types）、循环、事件流、预算策略、模型客户端、
 * 内置工具与提示词组装。**不导出**工具内部实现（scanLines / parseToolArguments 这类）——
 * 它们是实现细节，测试要测就直接 import 文件路径（同包内不受这个入口限制）。
 */

export * from "./types.ts";
// 工具的参数 schema 用 TypeBox 写（一份声明三个用途，见 types.ts 的 AgentTool）。
// 把 Type 从这里转出去，CP 侧写工具就不必自己依赖 typebox。
export { Type } from "typebox";
export type { Static, TSchema } from "typebox";
export { EventStream, AssistantMessageEventStream, createAssistantMessageEventStream } from "./event-stream.ts";
export {
  agentLoop,
  agentLoopContinue,
  runAgentLoop,
  runAgentLoopContinue,
  defaultConvertToLlm,
  renderCompactionSummary,
  toLlmTools,
} from "./loop.ts";
export { validateToolArguments } from "./validate.ts";
export { noopLog } from "./log.ts";
export type { LogFn, LogLevel } from "./log.ts";
export {
  DEFAULT_MAX_TURNS,
  DEFAULT_OUTPUT_TOKEN_BUDGET,
  DEFAULT_WALL_CLOCK_MS,
  REPEAT_NOTICE,
  REPEAT_NOTICE_THRESHOLD,
  REPEAT_STOP,
  REPEAT_STOP_THRESHOLD,
  createRepeatGuard,
  defaultStopPolicy,
  signatureOf,
  stableJson,
} from "./limits.ts";
export type { BudgetLimits, BudgetStopReason, RepeatGuard, RepeatGuardOptions, StopPolicy, StopPolicyOptions } from "./limits.ts";
export { MODEL_CATALOG, CONSERVATIVE_MODEL_INFO, lookupModel, maxTokensFor } from "./model/catalog.ts";
export type { ModelCost, ModelInfo } from "./model/catalog.ts";
export {
  AnthropicModelClient,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEEPSEEK_BASE_URL,
  ENV_API_KEY,
  ENV_DEEPSEEK_API_KEY,
  ENV_EFFORT,
  ENV_MAX_TOKENS,
  ENV_MODEL,
  ENV_PROVIDER,
  ModelError,
  isRetryableModelError,
  maxTokensFromEnv,
  modelFromEnv,
  modelNamedFromEnv,
  selectProvider,
  toModelError,
  toSdkMessages,
  toSdkParams,
  toSdkTools,
} from "./model/client.ts";
export type { AnthropicModelOptions, Effort, ModelErrorReason, ModelProvider, ProviderSelection, SdkParamsOptions } from "./model/client.ts";
export { AbortedError, DEFAULT_RETRY_POLICY, retryWithBackoff, sleepWithSignal } from "./model/retry.ts";
export type { RetryPolicy } from "./model/retry.ts";
export * from "./tools/index.ts";
// 会话层（Phase 2）：接口 + entries 投影 + 内存实现 + JSONL 导出。
// 四个面分开导出（store / entries / memory / export），而不是再套一个 session/index.ts 门面：
// 两边的实现者（CP 的 PG 实现、测试的内存实现）需要的类型不同，多一层门面只会多一处要维护的名单。
export * from "./session/store.ts";
export * from "./session/entries.ts";
export { MemorySessionStore } from "./session/memory.ts";
export type { MemorySessionStoreOptions } from "./session/memory.ts";
export { exportSession } from "./session/export.ts";
export type { ExportSessionOptions, SpilledMessagesReader } from "./session/export.ts";
// 压缩（Phase 3）。分三层导出：估算/切点（单测与调试直接用）、摘要生成、控制器（CP 接线）。
// 不用 `export *`：压缩内部有 `ProjectedMessage` / `CompactItem` 这类只给同包用的形状，
// 一次性倒出去会让它们看起来像契约。
export { calculateContextTokens, estimateContextTokens, estimateTokens, shouldCompact } from "./compaction/tokens.ts";
export type { ContextUsageEstimate } from "./compaction/tokens.ts";
export { findCutPoint, findTurnStartIndex, findValidCutPoints } from "./compaction/cut.ts";
export type { CutPointResult } from "./compaction/cut.ts";
export {
  CompactionError,
  TOOL_RESULT_MAX_CHARS,
  computeFileLists,
  createFileOps,
  extractFileOperations,
  extractFileOpsFromMessage,
  formatFileOperations,
  generateSummary,
  generateTurnPrefixSummary,
  serializeConversation,
  summaryBudgetChars,
} from "./compaction/summarize.ts";
export type { FileLists, FileOperations, SummaryOptions, SummaryResult } from "./compaction/summarize.ts";
export {
  DEFAULT_COMPACTION_SETTINGS,
  ENV_COMPACTION_ENABLED,
  ENV_COMPACTION_KEEP_TOKENS,
  ENV_COMPACTION_RESERVE_TOKENS,
  ENV_COMPACTION_SUMMARY_MODEL,
  compact,
  compactionSettingsFromEnv,
  createCompactionController,
  isContextOverflowError,
  prepareCompaction,
} from "./compaction/index.ts";
export type {
  CompactOptions,
  CompactOutcome,
  CompactionAppend,
  CompactionController,
  CompactionControllerOptions,
  CompactionFailure,
  CompactionPreparation,
  CompactionSettings,
} from "./compaction/index.ts";
export { REPO_DIR, ROLE_PROMPT, DEFAULT_EGRESS_NOTE, buildSandboxSection, buildSystemPrompt } from "./prompt/system.ts";
export type { SandboxFacts, SystemPromptSections } from "./prompt/system.ts";
export { buildTaskPrompt, initialMessages } from "./prompt/task.ts";
export type { TaskPromptOptions } from "./prompt/task.ts";
