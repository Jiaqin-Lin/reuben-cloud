/**
 * `session/compaction.ts` —— 压缩控制器的 CP 侧构造（Phase 3 的接线）。
 *
 * 【为什么多这一层】`createCompactionController`（agent-runtime）要的三样东西里有两样是
 * CP 的知识：
 *  · **摘要模型**：`REUBEN_CLOUD_COMPACTION_SUMMARY_MODEL` 是一个模型名，要按它的前缀
 *    选 provider、从 env 取凭据（`modelNamedFromEnv`）——凭据只在 CP 这一侧，这条红线没变；
 *  · **压缩条目的落点**：走 `EntryRecorder.appendCompaction`（leaf 链在记录器手里）。
 *
 * 【为什么不是一个环境变量解析函数】会话编排（`session-run.ts`）与手工脚本
 * （`scripts/agent-run.ts`）都要这一份构造。复制两次的后果是"脚本与产品路径的压缩配置不一样"
 * ——P2 已经因为同类问题吃过一次（`session-run` 与脚本各写一份记账逻辑）。
 */

import type {
  CompactionAppend,
  CompactionController,
  CompactionSettings,
  ModelClient,
  SessionStore,
} from "@reuben-cloud/agent-runtime";
import { compactionSettingsFromEnv, createCompactionController, modelNamedFromEnv } from "@reuben-cloud/agent-runtime";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

export interface SessionCompactionOptions {
  store: SessionStore;
  sessionId: string;
  runId: string | null;
  /** 主模型：上下文窗口从它的名字查目录，摘要默认也用它。 */
  model: ModelClient;
  /** 写压缩条目（会话层注入 `EntryRecorder.appendCompaction`）。 */
  appendCompaction: CompactionAppend;
  /** 覆盖 env 读出来的配置（测试用；生产不给）。 */
  settings?: Partial<CompactionSettings>;
  /** 第 N 次轮次准备时强制压缩一次（`agent:run --compact`；只生效一次）。 */
  forceAtTurn?: number | null;
  env?: NodeJS.ProcessEnv;
  log?: LogFn;
}

/** 建一个 Run 的压缩控制器（env 里的几个旋钮 + 可选的摘要模型）。 */
export function createSessionCompaction(options: SessionCompactionOptions): CompactionController {
  const log = options.log ?? noopLog;
  const env = options.env ?? process.env;
  const settings = { ...compactionSettingsFromEnv(env), ...options.settings };
  // 摘要模型与主模型同名（或没配）时不另建客户端——同一个模型两个实例没有意义。
  const summaryModel =
    settings.summaryModel === undefined || settings.summaryModel === options.model.model
      ? options.model
      : modelNamedFromEnv(settings.summaryModel, env, { log });

  return createCompactionController({
    store: options.store,
    sessionId: options.sessionId,
    runId: options.runId,
    model: options.model,
    summaryModel,
    settings,
    appendCompaction: options.appendCompaction,
    ...(options.forceAtTurn === undefined ? {} : { forceAtTurn: options.forceAtTurn }),
    env,
    log,
  });
}
