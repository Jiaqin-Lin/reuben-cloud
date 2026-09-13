/**
 * `environment/store.ts` —— `environments` / `env_builds` 两张表的读写（spec Phase 5 的验收项：
 * 表能存下一份完整候选；Phase 6 §5：每次尝试一行）+ 构建队列要的存储端口。
 *
 * 【为什么 P5 就有了它】spec 的交付物清单里只有迁移，没有 store；但验收标准里写着
 * "`environments` 表能存下一份完整候选（level / dockerfile / signals / notes）"——
 * 只建表不写入口的话，这条验收只能靠测试里手写 SQL 证明，而真正要用的 P6/P7 还得再造一次。
 *
 * 【revision 为什么在 SQL 里算】"同一 project_key 单调递增"必须是**一次**数据库动作
 * （`MAX(revision) + 1` 与插入同一条语句），否则"先查后写"在并发下必然产生重复 revision。
 * `(project_key, revision)` 的唯一键是最后一道闸：并发撞上了会拿到唯一约束冲突，
 * 而不是两份都写进去。P7 会在这个入口上做真正的串行化（它需要 revision 的父子关系）。
 *
 * 【`EnvBuildStore` 为什么在这里而不是 queue.ts】它是**队列的依赖端口**，但实现是 SQL：
 * 端口与实现放一起，`queue.ts` 只 import 类型（没有运行时依赖，也就不存在循环 import）；
 * 单测的替身（内存实现）放在 `test/environment-fakes.ts`，与 SessionStore 的 memory/PG
 * 两份实现是同一条规矩。
 *
 * 【列名为什么是 snake_case】与 `db/sandboxes.ts` 同一条理由：pg 回来的就是这样，
 * 多一层驼峰映射只会多一处能写错的地方。
 */

import type { UsageRow } from "@reuben-cloud/agent-runtime";
import type { Queryable } from "../db/client.ts";
import { maybeOne, one } from "../db/client.ts";
import { insertUsage } from "../session/postgres.ts";
import { prefixedId } from "../ulid.ts";
import type { HealthReport } from "./health.ts";
import { readStoredHealth } from "./health.ts";
import type {
  EnvBuildInference,
  EnvBuildStatus,
  EnvBuildTrigger,
  EnvironmentCandidate,
  EnvKind,
  EnvStatus,
  InferenceLevel,
  RepoSignals,
} from "./types.ts";

/** 一行 environments。字段与 006 迁移一一对应。 */
export interface EnvironmentRow {
  id: string;
  project_key: string;
  revision: number;
  kind: EnvKind;
  level: InferenceLevel;
  status: EnvStatus;
  base_image: string;
  dockerfile: string;
  signals: RepoSignals;
  notes: string[];
  degraded_risks: string[];
  build_commands: string[];
  verify_commands: string[];
  /** P7：这一版环境的镜像（digest 引用）。没构建成功过就是 null。 */
  image_digest: string | null;
  /** P7：缓存键（`cache.ts` 算的）。没有它这一版不参与缓存命中。 */
  cache_key: string | null;
  /** P7：上一版（首版为 NULL）。回滚与"这一版怎么来的"都读它。 */
  parent_revision: number | null;
  /** P7：体检报告；没体检过是 `{}`（用 `health.ts` 的 `readStoredHealth()` 读它）。 */
  health: HealthReport | Record<string, never>;
  health_reason: string | null;
  health_checked_at: Date | null;
  health_log_key: string | null;
  created_at: Date;
}

export interface NewEnvironment {
  /** `owner/name`（base 行用镜像名）。 */
  projectKey: string;
  /** 推断结果。候选里的 level / baseImage / dockerfile 与四个数组都会落库。 */
  candidate: EnvironmentCandidate;
  /** 与候选一起存下来的信号（归一化之后的那份）。 */
  signals: RepoSignals;
  kind?: EnvKind;
  /** 缺省 `draft`：P5 只推断，P6/P7 才会把它推到 building / ready。 */
  status?: EnvStatus;
  /** P7 的缓存键。调用方用 `computeCacheKey()` 算好给进来（SQL 里不重算一遍）。 */
  cacheKey?: string | null;
}

/** `env_<ulid>`（spec §0.1 的 ID 前缀表）。 */
export function environmentId(): string {
  return prefixedId("env");
}

/**
 * 插入一个新 revision，返回落库后的行。
 *
 * 【为什么 `INSERT … SELECT` 而不是先 SELECT 再 INSERT】见文件头：revision 必须在同一条
 * 语句里算出来。`COALESCE(MAX(revision), 0) + 1` 在没有历史行时给出 1，正好是首个 revision。
 */
export async function insertEnvironment(q: Queryable, input: NewEnvironment): Promise<EnvironmentRow> {
  const { candidate } = input;
  return one<EnvironmentRow>(
    q,
    `INSERT INTO environments
       (id, project_key, revision, kind, level, status, base_image, dockerfile, signals,
        notes, degraded_risks, build_commands, verify_commands, cache_key, parent_revision)
     SELECT $1, $2, COALESCE(MAX(revision), 0) + 1, $3, $4, $5, $6, $7, $8::jsonb,
            $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, MAX(revision)
       FROM environments WHERE project_key = $2
     RETURNING *`,
    [
      environmentId(),
      input.projectKey,
      input.kind ?? "project",
      candidate.level,
      input.status ?? "draft",
      candidate.baseImage,
      candidate.dockerfile,
      JSON.stringify(input.signals),
      JSON.stringify(candidate.notes),
      JSON.stringify(candidate.degradedRisks),
      JSON.stringify(candidate.buildCommands),
      JSON.stringify(candidate.verifyCommands),
      input.cacheKey ?? null,
    ],
  );
}

export function getEnvironment(q: Queryable, id: string): Promise<EnvironmentRow | null> {
  return maybeOne<EnvironmentRow>(q, "SELECT * FROM environments WHERE id = $1", [id]);
}

/**
 * 某个 project_key 的最新 revision（P6 的自愈要从它接着来，P7 的缓存命中要看它）。
 *
 * 【为什么按 revision 而不是 created_at 排序】revision 才是单调的那个量；
 * `created_at` 只在同一毫秒内有并发时才会乱，而那正是最难查的一类偶发。
 */
export function latestEnvironment(q: Queryable, projectKey: string): Promise<EnvironmentRow | null> {
  return maybeOne<EnvironmentRow>(
    q,
    "SELECT * FROM environments WHERE project_key = $1 ORDER BY revision DESC LIMIT 1",
    [projectKey],
  );
}

/** 某个 project_key 的历史（UI 的构建列表用；P7 会加过滤与分页）。 */
export function listEnvironments(q: Queryable, projectKey: string, limit = 10): Promise<EnvironmentRow[]> {
  return q
    .query<EnvironmentRow>(
      "SELECT * FROM environments WHERE project_key = $1 ORDER BY revision DESC LIMIT $2",
      [projectKey, limit],
    )
    .then((result) => result.rows);
}

// ---------------------------------------------------------------- 缓存命中、镜像与体检（P7）

/** 某一版（`--env-revision` / 回滚 / 缓存命中的落点都按 revision 取）。 */
export function getEnvironmentByRevision(
  q: Queryable,
  projectKey: string,
  revision: number,
): Promise<EnvironmentRow | null> {
  return maybeOne<EnvironmentRow>(q, "SELECT * FROM environments WHERE project_key = $1 AND revision = $2", [
    projectKey,
    revision,
  ]);
}

/**
 * 缓存命中：同一个键、已经体检通过（ready / degraded）、拿得到 digest 的那一行。
 *
 * 【为什么只认 ready / degraded】`building` 的那一行还没有可用镜像；`failed` 的那一行复用
 * 出去就是“把一个已知不能用的环境当成好的”（那比重新构建贵得多）。`draft` 同理。
 * 【为什么按 revision DESC 取第一行】同一个键可能命中多版（回滚过、手动重建过），
 * 取最新的那一版是唯一能解释的选择：它离当前事实最近。
 */
export function findCacheHit(q: Queryable, projectKey: string, cacheKey: string): Promise<EnvironmentRow | null> {
  return maybeOne<EnvironmentRow>(
    q,
    `SELECT * FROM environments
      WHERE project_key = $1 AND cache_key = $2 AND image_digest IS NOT NULL
        AND status IN ('ready', 'degraded')
      ORDER BY revision DESC LIMIT 1`,
    [projectKey, cacheKey],
  );
}

/** 构建成功后落“这一版环境的镜像是什么”。返回受影响行数（0 = 那一版不在了）。 */
export async function setEnvironmentImage(
  q: Queryable,
  projectKey: string,
  revision: number,
  imageDigest: string,
): Promise<number> {
  const result = await q.query(
    "UPDATE environments SET image_digest = $3 WHERE project_key = $1 AND revision = $2",
    [projectKey, revision, imageDigest],
  );
  return result.rowCount ?? 0;
}

/**
 * 体检结论落地：**状态与报告一起写**（一次 UPDATE）。
 *
 * 【为什么不能拆成两次】“status 已是 ready 但 health 还是空的”这种中间态会被 UI 与
 * Run 侧的解析同时读到，而它们会给出互相矛盾的结论（状态说能用、报告说不知道为什么）。
 */
export async function setEnvironmentHealth(
  q: Queryable,
  projectKey: string,
  revision: number,
  report: HealthReport,
): Promise<number> {
  const result = await q.query(
    `UPDATE environments
        SET status = $3, health = $4::jsonb, health_reason = $5, health_checked_at = $6, health_log_key = $7
      WHERE project_key = $1 AND revision = $2`,
    [
      projectKey,
      revision,
      report.status,
      JSON.stringify(report),
      report.reason,
      report.checkedAt,
      report.logKey,
    ],
  );
  return result.rowCount ?? 0;
}

/** “当前生效的是哪一版”（一行小表，见 008 迁移的注释）。 */
export interface ProjectEnvStateRow {
  project_key: string;
  current_revision: number;
  updated_at: Date;
}

export function getProjectEnvState(q: Queryable, projectKey: string): Promise<ProjectEnvStateRow | null> {
  return maybeOne<ProjectEnvStateRow>(q, "SELECT * FROM project_env_state WHERE project_key = $1", [projectKey]);
}

/** upsert 当前 revision（首次指向与回滚走的是同一个入口）。 */
export async function setProjectEnvState(q: Queryable, projectKey: string, currentRevision: number): Promise<void> {
  await q.query(
    `INSERT INTO project_env_state (project_key, current_revision, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (project_key) DO UPDATE SET current_revision = EXCLUDED.current_revision, updated_at = now()`,
    [projectKey, currentRevision],
  );
}

/**
 * 被沙箱引用过的镜像 digest（清理策略的输入：这些**永不清理**，设计文档 §C.5）。
 *
 * 扫 `sandboxes.image_digest` 而不是 `runs.env_revision`：前者是“真的有容器用过这个镜像”的
 * 硬件事实，而后者只能证明“某次执行声明要用它”。
 */
export async function listReferencedDigests(q: Queryable): Promise<string[]> {
  const result = await q.query<{ image_digest: string | null }>(
    "SELECT DISTINCT image_digest FROM sandboxes WHERE image_digest IS NOT NULL",
  );
  return result.rows.map((row) => row.image_digest!).filter((digest) => digest !== "");
}

/**
 * 缓存命中的最小形态。**故意不是整行 `EnvironmentRow`**：队列与解析层只用得上这四样，
 * 而"端口返回什么"决定了替身要模拟多少（单测不必造一行里的全部字段）。
 */
export interface CacheHit {
  revision: number;
  imageDigest: string;
  /** 命中那一版的体检结论（degraded 时 Run 要把它当沙箱事实写进 system）。 */
  health: HealthReport | null;
  /** 命中那一版的状态（镜像存在但 `health` 列还是 `{}` 的旧行也要能如实交接）。 */
  status: EnvStatus;
  cacheKey: string;
}

/** 整行 → 端口形状（`image_digest` / `cache_key` 缺一个就不算命中）。 */
export function cacheHitOf(row: EnvironmentRow): CacheHit | null {
  if (row.image_digest === null || row.cache_key === null) return null;
  return {
    revision: row.revision,
    imageDigest: row.image_digest,
    health: readStoredHealth(row.health),
    status: row.status,
    cacheKey: row.cache_key,
  };
}

// ---------------------------------------------------------------- 环境状态的推进（P6 的队列写）

/**
 * 推进某一版环境的状态。返回受影响行数（**0 = 那一版不存在**——调用方据此记一条 warn，
 * 而不是静默地把状态丢了：那会让 UI 永远停在旧值上，排查时无从下手）。
 *
 * 【为什么成功不在这里收尾】P6 只证明"docker build 成功"，而 `ready` 的定义是
 * "依赖装上了、构建命令跑通了"（设计文档 §C.6），那是 P7 在一次性沙箱里体检的结论。
 * 所以构建成功之后环境行留在 `building`，等健康检查把它推到 ready / degraded / failed。
 */
async function setEnvironmentStatus(
  q: Queryable,
  projectKey: string,
  revision: number,
  status: EnvStatus,
): Promise<number> {
  const result = await q.query(
    "UPDATE environments SET status = $3 WHERE project_key = $1 AND revision = $2",
    [projectKey, revision, status],
  );
  return result.rowCount ?? 0;
}

/**
 * 自愈成功后把"真正构建的那份文本"写回环境定义。
 *
 * 【为什么必须写回】P7 的缓存键里有一项是 `dockerfileText`：如果环境行留着规则生成的那份、
 * 而镜像是模型改过的那份，缓存命中就会把一个**用另一份文本构建的镜像**当成这一版的产物
 * 复用出去——那是最难查的一类错（"本地是好的，别人那儿不对"）。
 */
async function setEnvironmentDockerfile(
  q: Queryable,
  projectKey: string,
  revision: number,
  dockerfile: string,
): Promise<void> {
  await q.query("UPDATE environments SET dockerfile = $3 WHERE project_key = $1 AND revision = $2", [
    projectKey,
    revision,
    dockerfile,
  ]);
}

// ---------------------------------------------------------------- env_builds（一次尝试一行）

/** 一行 env_builds。字段与 007 迁移一一对应。 */
export interface EnvBuildRow {
  id: string;
  project_key: string;
  revision: number;
  attempt: number;
  inference: EnvBuildInference;
  trigger: EnvBuildTrigger;
  status: EnvBuildStatus;
  error_class: string | null;
  dockerfile: string;
  log_key: string | null;
  duration_ms: number | null;
  image_digest: string | null;
  created_at: Date;
}

/** 开一行 attempt。**在 build 开始前写**（见 007 迁移的头注释：UI 要看得见"正在建"）。 */
export interface NewEnvBuild {
  id: string;
  projectKey: string;
  revision: number;
  attempt: number;
  inference: EnvBuildInference;
  trigger: EnvBuildTrigger;
  /** 本次尝试要构建的文本（生成阶段失败时是模型原文 / 一句说明）。 */
  dockerfile: string;
}

/** 收一行 attempt。成功与失败都走这里；`building` 不会被写回（那是初始值）。 */
export interface EnvBuildFinish {
  status: Exclude<EnvBuildStatus, "building">;
  errorClass?: string | null;
  logKey?: string | null;
  durationMs?: number | null;
  imageDigest?: string | null;
}

/** `bld_<ulid>`（spec §0.1 的 ID 前缀表）。 */
export function envBuildId(): string {
  return prefixedId("bld");
}

/**
 * 队列要的存储端口。
 *
 * 【为什么是端口而不是直接拿 `Db`】自愈循环的全部行为（几轮、分类、记账、状态推进）
 * 都要能在**没有 Postgres、没有 docker** 的单测里验证（npm test 的红线）。
 * 端口把"循环怎么跑"与"往哪落"分开，PG 实现仍然是唯一的 SQL 出处。
 */
export interface EnvBuildStore {
  startAttempt(row: NewEnvBuild): Promise<void>;
  finishAttempt(id: string, patch: EnvBuildFinish): Promise<void>;
  /** 推进环境状态；返回受影响行数（见 `setEnvironmentStatus`）。 */
  setEnvironmentStatus(projectKey: string, revision: number, status: EnvStatus): Promise<number>;
  setEnvironmentDockerfile(projectKey: string, revision: number, dockerfile: string): Promise<void>;
  /**
   * 构建成功后的镜像落库（P7）。返回受影响行数——0 时队列只记一条 warn，
   * 不与“构建成功”这件事纠缠（镜像真的建出来了，只是那一行不在了）。
   */
  setEnvironmentImage(projectKey: string, revision: number, imageDigest: string): Promise<number>;
  /** 体检结论落地（状态 + 报告一次写完，见 `setEnvironmentHealth`）。 */
  setEnvironmentHealth(projectKey: string, revision: number, report: HealthReport): Promise<number>;
  /** 缓存命中查询（只认 ready / degraded + 有 digest）。 */
  findCacheHit(projectKey: string, cacheKey: string): Promise<CacheHit | null>;
  /** 一次 LLM 生成的用量进账本（kind='env_build'，没有 session / run）。 */
  recordUsage(row: UsageRow): Promise<void>;
}

export async function insertEnvBuild(q: Queryable, input: NewEnvBuild): Promise<EnvBuildRow> {
  return one<EnvBuildRow>(
    q,
    `INSERT INTO env_builds (id, project_key, revision, attempt, inference, trigger, status, dockerfile)
     VALUES ($1, $2, $3, $4, $5, $6, 'building', $7)
     RETURNING *`,
    [
      input.id,
      input.projectKey,
      input.revision,
      input.attempt,
      input.inference,
      input.trigger,
      input.dockerfile,
    ],
  );
}

export async function finishEnvBuild(q: Queryable, id: string, patch: EnvBuildFinish): Promise<void> {
  await q.query(
    `UPDATE env_builds
        SET status = $2, error_class = $3, log_key = $4, duration_ms = $5, image_digest = $6
      WHERE id = $1`,
    [
      id,
      patch.status,
      patch.errorClass ?? null,
      patch.logKey ?? null,
      patch.durationMs ?? null,
      patch.imageDigest ?? null,
    ],
  );
}

export function getEnvBuild(q: Queryable, id: string): Promise<EnvBuildRow | null> {
  return maybeOne<EnvBuildRow>(q, "SELECT * FROM env_builds WHERE id = $1", [id]);
}

/** 某一版环境的全部尝试（按 attempt 升序 = 时间序；UI 的分轮日志与排障读它）。 */
export function listEnvBuilds(q: Queryable, projectKey: string, revision: number): Promise<EnvBuildRow[]> {
  return q
    .query<EnvBuildRow>(
      "SELECT * FROM env_builds WHERE project_key = $1 AND revision = $2 ORDER BY attempt",
      [projectKey, revision],
    )
    .then((result) => result.rows);
}

/** 把 PG 包成队列要的端口。**SQL 只在这里**（唯一的方言出处）。 */
export function pgEnvBuildStore(db: Queryable): EnvBuildStore {
  return {
    async startAttempt(row: NewEnvBuild): Promise<void> {
      await insertEnvBuild(db, row);
    },
    async finishAttempt(id: string, patch: EnvBuildFinish): Promise<void> {
      await finishEnvBuild(db, id, patch);
    },
    setEnvironmentStatus(projectKey: string, revision: number, status: EnvStatus): Promise<number> {
      return setEnvironmentStatus(db, projectKey, revision, status);
    },
    async setEnvironmentDockerfile(projectKey: string, revision: number, dockerfile: string): Promise<void> {
      await setEnvironmentDockerfile(db, projectKey, revision, dockerfile);
    },
    setEnvironmentImage(projectKey: string, revision: number, imageDigest: string): Promise<number> {
      return setEnvironmentImage(db, projectKey, revision, imageDigest);
    },
    setEnvironmentHealth(projectKey: string, revision: number, report: HealthReport): Promise<number> {
      return setEnvironmentHealth(db, projectKey, revision, report);
    },
    async findCacheHit(projectKey: string, cacheKey: string): Promise<CacheHit | null> {
      const row = await findCacheHit(db, projectKey, cacheKey);
      return row === null ? null : cacheHitOf(row);
    },
    async recordUsage(row: UsageRow): Promise<void> {
      // 账本 SQL 复用会话侧的插入（`usage_ledger` 只有一份写入实现）。
      await insertUsage(db, row);
    },
  };
}
