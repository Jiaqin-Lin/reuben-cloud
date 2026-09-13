/**
 * `environment/revision.ts` —— 环境版本的规则：父子关系、promote、回滚、旧镜像清理
 * （spec Phase 7 §2；设计文档 §C.5）。
 *
 * ```
 * revision 单调递增   同一 project_key 下 1, 2, 3……（在 SQL 里算，见 store.ts）
 * parent_revision     指向上一个 revision（插入时由 SQL 一起写）
 * 重新构建            新 revision（即使 Dockerfile 一样，只要不是缓存命中）
 * promote             基于当前 revision 生成新 Dockerfile → 新 revision
 * 回滚                把 project_env_state.current_revision 指回旧值（不删任何行）
 * 清理                保留最近 10 个 revision；被 sandboxes 引用过的 digest 永不清理
 * ```
 *
 * 【为什么"当前 revision"是一个指针而不是"最新那一行"】最新那一行可能正在构建、也可能是
 * failed。设计文档 §C.5 要求回滚是一次**指针赋值**——指针跟着"能用的那一版"走，而
 * "最新"只是一个时间事实。P7 落地时把两个含义分开：`pointCurrentRevisionAfterBuild()`
 * 只在构建 + 体检成功之后才动指针（推一个新版本失败不该弄坏正在生效的那一版）。
 *
 * 【为什么清理只删镜像、不删行】`runs.env_revision` 指向某一版；删行会让"这次执行当时用的
 * 是什么环境"变成悬空引用，而那正是排障要看的第一条线索。行是证据（很小），镜像是资源
 * （很大）——所以清理的对象只有镜像。参考实现 pi 那边没有这一层（它不做环境），这里是
 * 设计文档 §C.5 保留策略的直接落地。
 *
 * 【为什么"被引用过"是永久的】一次 Run 用过某个 digest，就意味着可能有 PR / 分支 / 报告
 * 指向"当时那个环境"。按"最近 N 版"清掉它，等于让历史执行无法复现——所以引用是一条硬闸，
 * 它的输入来自 `sandboxes.image_digest`（真的有容器用过），不是 `runs.env_revision`
 * （只是声明要用）。
 */

import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { computeCacheKey } from "./cache.ts";
import type { EnqueueRequest, BuildOutcome } from "./queue.ts";
import type { CacheHit, EnvironmentRow } from "./store.ts";
import { setProjectEnvState } from "./store.ts";
import type { EnvironmentCandidate, EnvStatus, RepoSignals } from "./types.ts";

/** 保留多少个 revision（设计文档 §C.5 的 N=10）。**代码里的常量**，不是运维约定。 */
export const DEFAULT_KEEP_REVISIONS = 10;

// ---------------------------------------------------------------- 清理计划（纯函数）

/** 计划要读的那几列。**不是一个新类型**：`EnvironmentRow` 结构上就满足它。 */
export interface RevisionView {
  revision: number;
  image_digest: string | null;
  status: EnvStatus;
}

export interface RevisionCleanupPlan {
  /** 保留的 revision：最近的 N 版，加上"镜像还被别处需要"的那些（被沙箱引用 / 被窗口内的版本共用）。 */
  keep: number[];
  /** 可以删的镜像（去重；仍然被保留的版本用着的 digest 不在里面）。 */
  removeImages: string[];
  /** 超出保留窗口、且镜像可以删的那几版（它们的行留在库里，只是不再有镜像可用）。 */
  pruned: number[];
}

/**
 * 算一次清理计划。
 *
 * 【判据的顺序为什么是"先窗口、再引用"】窗口是"最近 10 版"这个简单事实；引用与共用是
 * **否决**。反过来（先看引用再截窗口）会让"被引用"的旧版本挤掉一个新版本的位置，
 * 于是"保留最近 10 版"这句话就不成立了。
 *
 * 【为什么要看"共用"】同一个 digest 可能同时被窗口内的一版拿着（回滚、promote 后又回滚——
 * 两次都指向同一个镜像）。删掉它等于把正在用的那一版一起弄坏，而 docker 的 `rmi` 在镜像
 * 只有一个 tag 时是真的删层。
 */
export function planRevisionCleanup(
  rows: readonly RevisionView[],
  options: { keep?: number; referencedDigests?: readonly string[] } = {},
): RevisionCleanupPlan {
  const keepCount = options.keep ?? DEFAULT_KEEP_REVISIONS;
  const referenced = new Set(options.referencedDigests ?? []);
  const sorted = [...rows].sort((a, b) => b.revision - a.revision);
  const inWindow = new Set(sorted.slice(0, keepCount).map((row) => row.revision));
  const keptDigests = new Set(
    sorted.filter((row) => inWindow.has(row.revision)).map((row) => row.image_digest).filter((d): d is string => d !== null),
  );

  const keep: number[] = [];
  const pruned: number[] = [];
  for (const row of sorted) {
    // 保留的两条理由：在窗口里，或者它的镜像还被别的地方需要（窗口内的某一版、或某个沙箱）。
    // 【没有 digest 的行为什么不算"被保护"】它本来就没有镜像可删，留在保留集里只会让
    // “哪些镜像还能用”这个问题多出一批无意义的答案（它们是历史记录，永远留在库里）。
    const shared =
      row.image_digest !== null && (keptDigests.has(row.image_digest) || referenced.has(row.image_digest));
    if (inWindow.has(row.revision) || shared) keep.push(row.revision);
    else pruned.push(row.revision);
  }

  const removeImages = [
    ...new Set(
      sorted
        .filter((row) => pruned.includes(row.revision))
        .map((row) => row.image_digest)
        .filter((digest): digest is string => digest !== null && !keptDigests.has(digest) && !referenced.has(digest)),
    ),
  ];

  return { keep, removeImages, pruned };
}

/**
 * 执行清理：只动镜像，不动行。`removeImage` 是端口（生产 = `docker rmi`；单测 = 记一笔）。
 *
 * 【为什么删不掉不算失败】镜像可能已经被手工删了、可能还有别的 tag 指着它（docker 会拒绝
 * 删最后一个引用之外的场景，各版本行为不一致）。清理是**尽力而为的后台动**：一次删不掉
 * 留到下一轮，不影响任何人的构建与 Run。
 */
export async function pruneRevisionImages(
  plan: RevisionCleanupPlan,
  removeImage: (digest: string) => Promise<void>,
  log: LogFn = noopLog,
): Promise<string[]> {
  const removed: string[] = [];
  for (const digest of plan.removeImages) {
    try {
      await removeImage(digest);
      removed.push(digest);
    } catch (error) {
      log("warn", "旧环境镜像没删掉（留给下一轮清理）", {
        digest,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}

// ---------------------------------------------------------------- promote

/** promote 要的存储口（PG 实现 / 内存替身都满足）。 */
export interface RevisionStore {
  insertEnvironment(input: {
    projectKey: string;
    candidate: EnvironmentCandidate;
    signals: RepoSignals;
    status?: EnvStatus;
    cacheKey?: string | null;
  }): Promise<EnvironmentRow>;
  findCacheHit(projectKey: string, cacheKey: string): Promise<CacheHit | null>;
  setProjectEnvState(projectKey: string, revision: number): Promise<void>;
}

export interface PromoteDeps {
  store: RevisionStore;
  /** 入队口。promote 不是一个"只改数据库"的动作：新文本要真的建、真的体检。 */
  queue: { enqueue(request: EnqueueRequest): Promise<BuildOutcome> };
  log?: LogFn;
}

export interface PromoteRequest {
  projectKey: string;
  /** 会话里验证有效的那份 Dockerfile（固化下来的改动）。 */
  dockerfile: string;
  /** 基线候选：只有 dockerfile 被换掉，baseImage / buildCommands / level 都沿用。 */
  candidate: EnvironmentCandidate;
  signals: RepoSignals;
  /** 只落一行 revision、不入队（"先固化、稍后建"）。缺省 false = 入队并等结果。 */
  dryRun?: boolean;
}

export interface PromoteResult {
  /** 新落的那一版；缓存命中时为 null（命中不产生新 revision，spec §1）。 */
  environment: EnvironmentRow | null;
  /** 现在生效的 revision（缓存命中时是被复用的那一版）。 */
  revision: number;
  cacheKey: string;
  cacheHit: boolean;
  outcome: BuildOutcome | null;
}

/**
 * 把一个改动固化成项目级的新 revision。
 *
 * 【为什么先查缓存】"同一份文本已经在库里且能用"时，再建一遍只是拿同一个键重复烧钱。
 * 命中时**不产生新行**（spec §1："重新构建 = 新 revision（即使 dockerfile 一样，只要不是
 * 缓存命中）"这句话的另一半就是"命中不产生"）。
 *
 * 【为什么只在成功之后才动指针】见文件头：推一个新版本失败不该弄坏正在生效的那一版。
 * 失败时新行留在库里（failed + 日志），指针不动。
 */
export async function promoteEnvironment(deps: PromoteDeps, request: PromoteRequest): Promise<PromoteResult> {
  const log = deps.log ?? noopLog;
  const candidate: EnvironmentCandidate = { ...request.candidate, dockerfile: request.dockerfile };
  const cacheKey = computeCacheKey({
    baseImage: candidate.baseImage,
    signals: request.signals,
    dockerfileText: candidate.dockerfile,
  });

  const hit = await deps.store.findCacheHit(request.projectKey, cacheKey);
  if (hit !== null) {
    log("info", "promote 命中缓存：这份文本的产物已经在库里，直接指过去", {
      projectKey: request.projectKey,
      revision: hit.revision,
    });
    await deps.store.setProjectEnvState(request.projectKey, hit.revision);
    return { environment: null, revision: hit.revision, cacheKey, cacheHit: true, outcome: null };
  }

  const environment = await deps.store.insertEnvironment({
    projectKey: request.projectKey,
    candidate,
    signals: request.signals,
    status: "draft",
    cacheKey,
  });
  log("info", `promote 已落成 revision ${environment.revision}`, {
    projectKey: request.projectKey,
    parent: environment.parent_revision,
    cacheKey: cacheKey.slice(0, 12),
  });
  if (request.dryRun === true) {
    return { environment, revision: environment.revision, cacheKey, cacheHit: false, outcome: null };
  }

  const outcome = await deps.queue.enqueue({
    projectKey: request.projectKey,
    revision: environment.revision,
    candidate,
    signals: request.signals,
    trigger: "promote",
    cacheKey,
  });
  if (outcome.ok) await deps.store.setProjectEnvState(request.projectKey, environment.revision);
  else log("warn", "promote 的构建没有成功，当前 revision 不动", { projectKey: request.projectKey, revision: environment.revision });
  return { environment, revision: environment.revision, cacheKey, cacheHit: false, outcome };
}

// ---------------------------------------------------------------- 回滚

/** 回滚要的存储口（比 `RevisionStore` 多一个按 revision 取）。 */
export interface RollbackStore extends RevisionStore {
  getEnvironmentByRevision(projectKey: string, revision: number): Promise<EnvironmentRow | null>;
}

export class RollbackError extends Error {
  readonly reason: "not_found" | "not_usable";

  constructor(reason: "not_found" | "not_usable", message: string) {
    super(message);
    this.name = "RollbackError";
    this.reason = reason;
  }
}

/**
 * 把当前指针指回旧 revision（设计文档 §C.5："回滚 = 把指针指回旧值（不删任何行）"）。
 *
 * 【为什么不允许回滚到一个不能用 / 还没体检的版本】那不是回滚，是把环境推回未知状态。
 * 旧镜像本来就按引用活在本地（或者在 registry 里），而能用的那一版一定是 ready / degraded
 * 中的一种。
 */
export async function rollbackEnvironment(
  store: RollbackStore,
  input: { projectKey: string; revision: number },
): Promise<EnvironmentRow> {
  const row = await store.getEnvironmentByRevision(input.projectKey, input.revision);
  if (row === null) {
    throw new RollbackError("not_found", `${input.projectKey} 没有 revision ${input.revision}`);
  }
  if (row.status !== "ready" && row.status !== "degraded") {
    throw new RollbackError(
      "not_usable",
      `revision ${input.revision} 的状态是 ${row.status}（只有 ready / degraded 能回滚过去）`,
    );
  }
  await store.setProjectEnvState(input.projectKey, input.revision);
  return row;
}
