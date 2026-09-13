/**
 * `environment/resolve.ts` —— Run 侧的环境解析：**只做一次读，从不构建**（spec Phase 7 §5；
 * 设计文档 §C.8）。
 *
 * ```
 * resolveEnvironment(projectKey, signals):
 *   指定了 revision 且它 ready|degraded  → 用它的 image_digest
 *   当前 revision 的 cache_key 命中      → 用它的 image_digest（revision 进 runs.env_revision）
 *   别处有同 cache_key 的可用版本        → 用它，并把当前指针指过去（缓存命中）
 *   都没有                              → 用 Layer 1 的语言镜像 + 一句沙箱事实，
 *                                         同时**异步入队** first_seen（不阻塞这一句）
 * ```
 *
 * 【为什么这一层必须存在、而且必须这么薄】设计文档 §C.8 的推论：构建跟沙箱、会话、对话都
 * 没有关系——它不需要用户说话，也不需要容器。所以"用户的第一句话"与"10 分钟的构建"必须
 * 彻底解耦：用户不等构建，构建也不需要用户。这里的每一行都在维持这条性质（没有一次
 * `await` 落在构建上；入队是 fire-and-forget）。
 *
 * 【为什么回退用的是 Layer 1 而不是"上一次那个环境"】cache_key 没命中意味着**仓库的事实变了**
 * （新锁文件、新语言、新的构建入口）——拿旧环境顶上会让 agent 在一个缺少新依赖的环境里跑，
 * 而它没有任何线索知道这一点。Layer 1 是诚实的：系统工具链齐了、项目依赖没装，而且我们把
 * 这句话当成沙箱事实写进了 system。
 *
 * 【facts 走的是与 degraded 同一条通道】spec 的原话（§5）："把'项目依赖还没装'当成沙箱事实
 * 写进 system（与 degraded 同一条通道）"。所以这里返回的 `facts` 与体检报告里的 facts 是
 * 同一种类型（`SandboxFact`），调用方拼 system 时不需要区分来源。
 *
 * 【没命中就入队——包括上一版是 failed 的情况】一个已知失败的键再试一次，看起来像浪费；
 * 但失败可能是网络抖动（P6 的分类里 `network_timeout` 正是"重试可能有效"那一类），
 * 而"再也不自动试"会让一个坏仓库永远停在 Layer 1 上、只剩人工 `--rebuild-env` 一条路。
 * M2 没有调度级的退避（那是 M3 的配额 / 重试用例），代价由队列自己的去重与轮数上限兜住：
 * 同一个仓库同时只会有一轮、最多三轮。
 */

import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { EnvBaseKind } from "./base-images.ts";
import { computeCacheKey } from "./cache.ts";
import type { SandboxFact, HealthReport } from "./health.ts";
import { readStoredHealth } from "./health.ts";
import type { BuildOutcome, EnqueueRequest } from "./queue.ts";
import type { CacheHit, EnvironmentRow } from "./store.ts";
import type { EnvironmentCandidate, EnvBuildTrigger, RepoSignals } from "./types.ts";

// ---------------------------------------------------------------- 端口

/** 解析要的存储口（PG 实现 / 内存替身都满足；SQL 仍然只在 `store.ts`）。 */
export interface EnvResolverStore {
  getProjectEnvState(projectKey: string): Promise<{ current_revision: number } | null>;
  getEnvironmentByRevision(projectKey: string, revision: number): Promise<EnvironmentRow | null>;
  findCacheHit(projectKey: string, cacheKey: string): Promise<CacheHit | null>;
  insertEnvironment(input: {
    projectKey: string;
    candidate: EnvironmentCandidate;
    signals: RepoSignals;
    status?: EnvironmentRow["status"];
    cacheKey?: string | null;
  }): Promise<EnvironmentRow>;
  setProjectEnvState(projectKey: string, revision: number): Promise<void>;
}

export interface EnvironmentResolverDeps {
  store: EnvResolverStore;
  /** 推断（读 CP 侧的 clone 目录，毫秒级、只读文件）。 */
  infer: () => Promise<{ candidate: EnvironmentCandidate; signals: RepoSignals }>;
  /**
   * 入队口。**调用方保证它不抛**；抛了这里也只记一条 warn（入队失败不该让用户那句话没人处理）。
   */
  enqueue: (request: EnqueueRequest) => Promise<BuildOutcome>;
  /**
   * 拿 Layer 1 的镜像引用（**必须是 digest**：`SandboxSpec.image` 只收 digest）。
   * 返回 null = 那个镜像本地没有（调用方要给出可行动的错误，而不是回一个 tag）。
   */
  baseImageFor: (kind: EnvBaseKind) => Promise<string | null>;
  log?: LogFn;
}

export interface ResolveEnvironmentInput {
  projectKey: string;
  /** 显式指定 revision（`agent:run --env-revision`）。给了就不再走缓存那两条路。 */
  forcedRevision?: number | null;
  /** 入队时用的触发源；缺省 `first_seen`（"第一次看见这个仓库"）。 */
  trigger?: EnvBuildTrigger;
}

/** 解析结果。`image` 可以直接给 `manager.createSandbox`。 */
export interface EnvResolution {
  image: string;
  /** 进 `runs.env_revision`；回退到 Layer 1 时是 null。 */
  revision: number | null;
  source: "forced" | "project" | "cache" | "base";
  cacheKey: string | null;
  /** 写进 system 的沙箱事实（degraded 的原因 / "依赖还没装"）。 */
  facts: SandboxFact[];
  /** 命中的那一版体检报告（没有就是 null）。 */
  health: HealthReport | null;
  /** 回退那条路上有没有把构建排进队列。 */
  queued: boolean;
}

export class ResolveError extends Error {
  readonly reason: "revision_not_found" | "revision_not_usable" | "base_image_missing";

  constructor(reason: ResolveError["reason"], message: string) {
    super(message);
    this.name = "ResolveError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- 事实

/**
 * "项目依赖还没装"这条事实（回退到 Layer 1 时唯一要说的额外信息）。
 *
 * 【为什么 affected 是三个】它同时影响构建、测试与集成测试：没有依赖，这三件事都会以奇怪的
 * 方式失败（找不到模块、命令不存在）。逐个列举比一句"环境不完整"更能让 agent 做出正确决定
 * （先装依赖，而不是去改代码）。
 */
export function pendingEnvironmentFact(): SandboxFact {
  return {
    reason: "dependencies_not_installed",
    affected: ["build", "test", "integration_tests"],
    detail:
      "这个仓库的项目依赖还没装好（现在用的是 Layer 1 基础镜像：系统工具链齐了，但没有安装这个仓库自己的依赖）。" +
      "要跑构建或测试，先按仓库的包管理器装一次依赖；这个仓库的环境构建已经在后台排队，下一次执行会用上它",
  };
}

/** 从体检报告里取出要进 system 的事实（ready 时是空数组）。 */
export function factsOfHealth(health: HealthReport | null): SandboxFact[] {
  return health?.facts ?? [];
}

/** 一行人话摘要（CLI 打印用；不放 system，因为它含 revision 这类会变的东西）。 */
export function describeResolution(resolution: EnvResolution): string {
  const where =
    resolution.revision === null ? "Layer 1 基础镜像" : `项目环境 revision ${resolution.revision}`;
  const how =
    resolution.source === "base"
      ? resolution.queued
        ? "（环境未就绪：已把构建排进队列）"
        : "（环境未就绪，且没有入队）"
      : resolution.source === "cache"
        ? "（缓存命中）"
        : resolution.source === "forced"
          ? "（显式指定）"
          : "";
  return `使用 ${where}${how}`;
}

// ---------------------------------------------------------------- 解析

/**
 * 解析这次 Run 要用哪个镜像。**不抛"环境还没好"**：那不是错误，是一种正常状态
 * （设计文档 §C.1："failed 是合法结果"，"没好"更是）。
 */
export async function resolveEnvironment(
  deps: EnvironmentResolverDeps,
  input: ResolveEnvironmentInput,
): Promise<EnvResolution> {
  const log = deps.log ?? noopLog;
  const projectKey = input.projectKey;

  // ---- ① 显式指定（`--env-revision`）：绕开缓存与指针，但**不绕开可用性**。
  if (input.forcedRevision !== null && input.forcedRevision !== undefined) {
    return resolveForced(deps, projectKey, input.forcedRevision);
  }

  // ---- 推断（缓存键的输入，也是回退时选语言镜像的依据）
  const inferred = await deps.infer();
  const cacheKey = computeCacheKey({
    baseImage: inferred.candidate.baseImage,
    signals: inferred.signals,
    dockerfileText: inferred.candidate.dockerfile,
  });

  // ---- ② 当前 revision 命中缓存键 → 直接用（最常见的一条路：环境已经建好且没过期）
  const state = await deps.store.getProjectEnvState(projectKey);
  if (state !== null) {
    const current = await deps.store.getEnvironmentByRevision(projectKey, state.current_revision);
    if (current !== null && usable(current) && current.cache_key === cacheKey) {
      log("info", "环境解析：当前 revision 命中缓存键", { projectKey, revision: current.revision });
      return resolutionOf(current, "project", cacheKey, false);
    }
  }

  // ---- ③ 别处有同一份事实的可用版本（回滚过、手动重建过）→ 用它，并把指针指过去
  const hit = await deps.store.findCacheHit(projectKey, cacheKey);
  if (hit !== null) {
    log("info", "环境解析：缓存命中（复用别的 revision 的产物）", {
      projectKey,
      revision: hit.revision,
      digest: hit.imageDigest,
    });
    await deps.store.setProjectEnvState(projectKey, hit.revision);
    return {
      image: hit.imageDigest,
      revision: hit.revision,
      source: "cache",
      cacheKey,
      facts: factsOfHealth(hit.health),
      health: hit.health,
      queued: false,
    };
  }

  // ---- ④ 没命中：落一版新的（status=draft）→ **异步入队** → 回退到 Layer 1。
  const environment = await deps.store.insertEnvironment({
    projectKey,
    candidate: inferred.candidate,
    signals: inferred.signals,
    status: "draft",
    cacheKey,
  });
  const trigger: EnvBuildTrigger = input.trigger ?? "first_seen";
  // 不 await：用户不等构建（§C.8）。失败只记一条 warn——它是队列/存储的问题，
  // 不是"这句话没人处理"。
  void deps
    .enqueue({
      projectKey,
      revision: environment.revision,
      candidate: inferred.candidate,
      signals: inferred.signals,
      trigger,
      cacheKey,
    })
    .then(async (outcome) => {
      log("info", "环境构建入队并已完成", {
        projectKey,
        revision: environment.revision,
        ok: outcome.ok,
        attempts: outcome.attempts,
        cached: outcome.cached,
      });
      // 建好了就把指针指过去（只往前走，见 `pointForwardIfNewer`）。
      // 这一步放在这里而不是队列里：队列是进程级的、不知道"当前"这件事（见 runtime.ts 的文件头）。
      if (outcome.ok) await pointForwardIfNewer(deps, projectKey, environment.revision);
    })
    .catch((error: unknown) => {
      log("warn", "环境构建入队失败（这次 Run 用 Layer 1 跑）", {
        projectKey,
        revision: environment.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  const base = await deps.baseImageFor(inferred.candidate.baseImageKind);
  if (base === null) {
    throw new ResolveError(
      "base_image_missing",
      `本地没有 Layer 1 镜像 ${inferred.candidate.baseImage}（先跑 npm run build:image）`,
    );
  }
  log("info", "环境解析：没有可用环境，用 Layer 1 基础镜像 + 异步建环境", {
    projectKey,
    revision: environment.revision,
    base,
  });
  return {
    image: base,
    revision: null,
    source: "base",
    cacheKey,
    facts: [pendingEnvironmentFact()],
    health: null,
    queued: true,
  };
}

/**
 * 把当前指针指到这一版——**只往前走**。
 *
 * 【为什么要这道闸】异步入队的那次构建可能比另一个更晚的 revision 先完成（同一个仓库被连着
 * 触发两次时），后完成的那个如果是旧版本，无条件写指针会把"当前"退回去。指针的语义是
 * "现在生效的那一版"，它的单调性（revision 单调）必须被保住。
 *
 * 【失败为什么不写】它没建出来，指针留在一个能用的版本上是对的。
 */
async function pointForwardIfNewer(
  deps: EnvironmentResolverDeps,
  projectKey: string,
  revision: number,
): Promise<void> {
  try {
    const state = await deps.store.getProjectEnvState(projectKey);
    if (state !== null && state.current_revision >= revision) return;
    await deps.store.setProjectEnvState(projectKey, revision);
  } catch (error) {
    (deps.log ?? noopLog)("warn", "环境构建成功了但当前指针没能推进", {
      projectKey,
      revision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `--env-revision` 的那条路：找不到 / 不能用都要**明确报错**（人显式要的东西不能静默降级）。 */
async function resolveForced(
  deps: EnvironmentResolverDeps,
  projectKey: string,
  revision: number,
): Promise<EnvResolution> {
  const row = await deps.store.getEnvironmentByRevision(projectKey, revision);
  if (row === null) {
    throw new ResolveError("revision_not_found", `${projectKey} 没有 revision ${revision}`);
  }
  if (!usable(row)) {
    throw new ResolveError(
      "revision_not_usable",
      `revision ${revision} 的状态是 ${row.status}（只有 ready / degraded 能用来跑）`,
    );
  }
  return resolutionOf(row, "forced", row.cache_key, false);
}

/** 能不能拿来跑：体检通过 + 有镜像 digest。 */
function usable(row: EnvironmentRow): boolean {
  return (row.status === "ready" || row.status === "degraded") && row.image_digest !== null;
}

function resolutionOf(
  row: EnvironmentRow,
  source: "forced" | "project",
  cacheKey: string | null,
  queued: boolean,
): EnvResolution {
  const health = readStoredHealth(row.health);
  return {
    image: row.image_digest!,
    revision: row.revision,
    source,
    cacheKey,
    facts: factsOfHealth(health),
    health,
    queued,
  };
}
