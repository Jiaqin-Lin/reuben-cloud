/**
 * `web/env.ts` —— 环境页的读模型与手动触发口（spec Phase 7 §4；设计文档 §C.6/§C.8）。
 *
 * ```
 * GET  /env/{projectKey}            → 页面（env.html）
 * GET  /env/{projectKey}/info       → 这个仓库的版本历史 + 每版的构建行 + 当前指针
 * POST /env/{projectKey}/build      → manual 入队（页面上那个"构建 / 重建"按钮）
 * GET  /env/{projectKey}/logs/{n}?build=<bld_id>    → 构建日志（只读代理）
 * GET  /env/{projectKey}/logs/{n}?health=<run_id>   → 体检日志（同一个落点、同一个前缀）
 * ```
 *
 * 【为什么读模型在 CP 侧而不是让页面自己拼】页面要的是"一版环境的全貌"（状态 + 体检细节 +
 * 历次尝试），那是三张读的组合：`environments` 的历史、`env_builds` 的分轮、`project_env_state`
 * 的指针。让它自己发三个请求，只会把"哪一版是当前的"这个判断搬到浏览器里。
 *
 * 【为什么日志走"服务端按参数拼 key"而不是把 key 传给服务端】key 是对象存储里的路径，
 * 让客户端指定它等于开了一个任意读的口（`../`、别人的仓库、别的前缀）。这里服务端只用
 * **校验过的四段**（projectKey / revision / buildId | runId）拼出 `env-logs/…` 下的一个 key
 * ——"只允许 env-logs 前缀"因此是结构上成立的，而不是靠一条 if 挡着。
 *
 * 【为什么触发口是 `EnvironmentRuntime` 而不是裸队列】"页面上点一下"要走的是与 CLI
 * 完全相同的那条路（跳过缓存、落新 revision、体检、动指针）——那正是 `rebuild()` 的语义。
 * 只有这个进程认识的那个仓库能触发；别的 key 仍然能看（页面是历史视图）。
 */

import type { Readable } from "node:stream";
import type { Queryable } from "../db/client.ts";
import type { BuildLogStore } from "../environment/build.ts";
import { envBuildLogKey, envHealthLogKey } from "../environment/build.ts";
import type { SandboxFact } from "../environment/health.ts";
import { readStoredHealth } from "../environment/health.ts";
import type { EnvironmentRuntime } from "../environment/runtime.ts";
import type { EnvBuildRow, EnvironmentRow } from "../environment/store.ts";
import { getProjectEnvState, listEnvBuilds, listEnvironments } from "../environment/store.ts";

/** 读口（页面要的三张读；SQL 仍然只在 `environment/store.ts`）。 */
export interface EnvWebStore {
  listEnvironments(projectKey: string, limit: number): Promise<EnvironmentRow[]>;
  getProjectEnvState(projectKey: string): Promise<{ current_revision: number } | null>;
  listEnvBuilds(projectKey: string, revision: number): Promise<EnvBuildRow[]>;
}

export function pgEnvironmentWebStore(db: Queryable): EnvWebStore {
  return {
    listEnvironments: (projectKey, limit) => listEnvironments(db, projectKey, limit),
    getProjectEnvState: (projectKey) => getProjectEnvState(db, projectKey),
    listEnvBuilds: (projectKey, revision) => listEnvBuilds(db, projectKey, revision),
  };
}

export interface EnvironmentWebPort {
  store: EnvWebStore;
  /** 这个进程认识的那个仓库（触发只用它）。没有 = 只读页面。 */
  runtime?: EnvironmentRuntime | null;
  /** 日志落点（构建与体检日志都走它）。没有时日志路由回 503。 */
  logs?: BuildLogStore | null;
}

// ---------------------------------------------------------------- 读模型

/** 页面上的一行构建尝试（只取页面要显示的字段）。 */
export interface EnvBuildView {
  id: string;
  attempt: number;
  inference: string;
  trigger: string;
  status: string;
  errorClass: string | null;
  logKey: string | null;
  durationMs: number | null;
  imageDigest: string | null;
  createdAt: string;
}

/** 页面上的一版环境。 */
export interface EnvRevisionView {
  revision: number;
  parentRevision: number | null;
  status: string;
  level: string;
  baseImage: string;
  imageDigest: string | null;
  cacheKey: string | null;
  createdAt: string;
  health: {
    status: string;
    reason: string | null;
    detail: string | null;
    facts: SandboxFact[];
    checkedAt: string | null;
    logKey: string | null;
  } | null;
  buildCommands: string[];
  verifyCommands: string[];
  degradedRisks: string[];
  notes: string[];
  builds: EnvBuildView[];
}

export interface EnvironmentView {
  projectKey: string;
  currentRevision: number | null;
  /** 这个进程能不能触发这个仓库的构建（页面上那个按钮的可用性）。 */
  canBuild: boolean;
  revisions: EnvRevisionView[];
}

/** 一页最多列多少版（与保留窗口同一个量级：再往前就是被清理掉的那些）。 */
export const ENV_PAGE_REVISION_LIMIT = 10;

/**
 * 一个仓库的环境全貌。**没有这个仓库时返回 null**（调用方回 404，而不是回一个空页面）。
 */
export async function readEnvironmentView(
  port: EnvironmentWebPort,
  projectKey: string,
  options: { limit?: number } = {},
): Promise<EnvironmentView | null> {
  const rows = await port.store.listEnvironments(projectKey, options.limit ?? ENV_PAGE_REVISION_LIMIT);
  if (rows.length === 0) return null;
  const state = await port.store.getProjectEnvState(projectKey);
  const revisions: EnvRevisionView[] = [];
  for (const row of rows) {
    const builds = await port.store.listEnvBuilds(projectKey, row.revision);
    revisions.push(revisionViewOf(row, builds));
  }
  return {
    projectKey,
    currentRevision: state?.current_revision ?? null,
    canBuild: port.runtime?.projectKey === projectKey,
    revisions,
  };
}

function revisionViewOf(row: EnvironmentRow, builds: EnvBuildRow[]): EnvRevisionView {
  const health = readStoredHealth(row.health);
  return {
    revision: row.revision,
    parentRevision: row.parent_revision,
    status: row.status,
    level: row.level,
    baseImage: row.base_image,
    imageDigest: row.image_digest,
    cacheKey: row.cache_key,
    createdAt: row.created_at.toISOString(),
    health:
      health === null
        ? null
        : {
            status: health.status,
            reason: health.reason,
            detail: health.detail,
            facts: health.facts ?? [],
            checkedAt: row.health_checked_at?.toISOString() ?? null,
            logKey: row.health_log_key,
          },
    buildCommands: row.build_commands,
    verifyCommands: row.verify_commands,
    degradedRisks: row.degraded_risks,
    notes: row.notes,
    builds: builds.map((build) => ({
      id: build.id,
      attempt: build.attempt,
      inference: build.inference,
      trigger: build.trigger,
      status: build.status,
      errorClass: build.error_class,
      logKey: build.log_key,
      durationMs: build.duration_ms,
      imageDigest: build.image_digest,
      createdAt: build.created_at.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------- 日志（只读代理）

/** 日志一次最多读多少字节（超过就截断并说明——证据是给人看的，不是给人下载的）。 */
export const ENV_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface EnvironmentLogRequest {
  projectKey: string;
  revision: number;
  /** `bld_<ulid>`（某次构建尝试）。 */
  buildId?: string | null;
  /** `envcheck_<ulid>`（某次体检）。 */
  healthRunId?: string | null;
}

export type EnvironmentLogResult =
  | { ok: true; key: string; text: string; truncated: boolean }
  | { ok: false; reason: "no_log_store" | "missing" };

/** 从查询参数取日志的两选一（两个都给 / 都不给都不合法，调用方回 400）。 */
export function logRequestOf(input: {
  projectKey: string;
  revision: number;
  buildId?: string | null;
  healthRunId?: string | null;
}): EnvironmentLogRequest | null {
  const hasBuild = input.buildId !== null && input.buildId !== undefined && input.buildId !== "";
  const hasHealth = input.healthRunId !== null && input.healthRunId !== undefined && input.healthRunId !== "";
  if (hasBuild === hasHealth) return null;
  return {
    projectKey: input.projectKey,
    revision: input.revision,
    ...(hasBuild ? { buildId: input.buildId } : { healthRunId: input.healthRunId }),
  };
}

/**
 * 取一份日志。key **由服务端拼**（见文件头）：`envBuildLogKey` / `envHealthLogKey` 都只会
 * 产出 `env-logs/…` 下的路径，所以"只允许这个前缀"是结构上的性质。
 */
export async function readEnvironmentLog(
  port: EnvironmentWebPort,
  request: EnvironmentLogRequest,
): Promise<EnvironmentLogResult> {
  const logs = port.logs ?? null;
  if (logs === null) return { ok: false, reason: "no_log_store" };
  const key =
    request.buildId !== undefined && request.buildId !== null
      ? envBuildLogKey(request.projectKey, request.revision, request.buildId)
      : envHealthLogKey(request.projectKey, request.revision, request.healthRunId!);
  try {
    const text = await readAllBounded(await logs.get(key), ENV_LOG_MAX_BYTES);
    return { ok: true, key, text: text.text, truncated: text.truncated };
  } catch {
    // 对象不存在 / 目录不存在：日志是证据，缺了就是缺了——回 404，不编一个空文件。
    return { ok: false, reason: "missing" };
  }
}

/** 读到上限为止（读满就停下并把连接断掉，不把整个对象拉进内存）。 */
async function readAllBounded(stream: Readable, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    const room = maxBytes - size;
    if (buffer.length >= room) {
      chunks.push(buffer.subarray(0, Math.max(room, 0)));
      size = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  if (truncated) stream.destroy();
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
