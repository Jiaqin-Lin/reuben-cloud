/**
 * `environment/store.ts` —— `environments` 表的读写（spec Phase 5 的验收项：表能存下一份完整候选）。
 *
 * 【为什么 P5 就有了它】spec 的交付物清单里只有迁移，没有 store；但验收标准里写着
 * "`environments` 表能存下一份完整候选（level / dockerfile / signals / notes）"——
 * 只建表不写入口的话，这条验收只能靠测试里手写 SQL 证明，而真正要用的 P6/P7 还得再造一次。
 * 所以这里只放**最小**的三个函数（插入 / 按 id 取 / 取最新），revision 的父指针、promote、
 * 清理策略都留给 P7 的 `revision.ts`（附录 A-27）。
 *
 * 【revision 为什么在 SQL 里算】"同一 project_key 单调递增"必须是**一次**数据库动作
 * （`MAX(revision) + 1` 与插入同一条语句），否则"先查后写"在并发下必然产生重复 revision。
 * `(project_key, revision)` 的唯一键是最后一道闸：并发撞上了会拿到唯一约束冲突，
 * 而不是两份都写进去。P7 会在这个入口上做真正的串行化（它需要 revision 的父子关系）。
 *
 * 【列名为什么是 snake_case】与 `db/sandboxes.ts` 同一条理由：pg 回来的就是这样，
 * 多一层驼峰映射只会多一处能写错的地方。
 */

import type { Queryable } from "../db/client.ts";
import { maybeOne, one } from "../db/client.ts";
import { prefixedId } from "../ulid.ts";
import type { EnvironmentCandidate, EnvKind, EnvStatus, InferenceLevel, RepoSignals } from "./types.ts";

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
        notes, degraded_risks, build_commands, verify_commands)
     SELECT $1, $2, COALESCE(MAX(revision), 0) + 1, $3, $4, $5, $6, $7, $8::jsonb,
            $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb
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
