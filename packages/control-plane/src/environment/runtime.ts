/**
 * `environment/runtime.ts` —— 环境子系统的**组合根**：把存储、队列、体检、镜像解析与解析策略
 * 装成两个入口，让调用方（`agent:run` / `env:build` / 环境页）只需要说"我要一个环境"
 * （spec Phase 7 §5）。
 *
 * ```
 * createEnvironmentQueue(config)      一个进程一个：并发 1（宿主机 docker daemon 是共享资源）
 * createEnvironmentRuntime(options)  一个 project_key 一个：解析 / 构建 / promote / 回滚 / 清理
 * ```
 *
 * 【为什么队列是进程级、运行时是仓库级】"同时只跑一个 docker build"是关于宿主机的性质，
 * 不是关于某个仓库的（设计文档 §C.7）；而"这个仓库当前是哪一版"当然是仓库级的。把两者塞进
 * 一个对象，会让"多个仓库共用一个队列"变成不可能——而那正是要靠队列保证的事。
 *
 * 【为什么构建入口有两个而不是一个】它们问的是不同的问题：
 *  · `buildIfNeeded()`：**事实没变就别重复建**（缓存优先）。`env:build` 的默认路径与自动触发
 *    走它——验收标准"同一仓库第二次构建 < 10s"就是这条（第二次直接命中，不构建也不体检）。
 *  · `rebuild()`：**我说了算**（跳过缓存，落新 revision）。`--rebuild-env` 与页面按钮走它。
 *    人显式要求重建时"缓存键没变"不是理由：他可能正是因为 Layer 1 被重建、上游依赖变了才点
 *    的那一下，而那两件事缓存键看不见（附录 A-40）。
 *
 * 【指针什么时候动】只有"构建 + 体检成功"之后（`pointIfOk`）。推一个新版本失败不该弄坏正在
 * 生效的那一版（见 `revision.ts` 的文件头）。
 */

import { baseImageRef, baseKindOfRef } from "./base-images.ts";
import type { EnvBaseKind } from "./base-images.ts";
import { DockerBuildRunner, envBuildLogStoreFromEnv, envHealthLogKey, runProcess } from "./build.ts";
import type { BuildLogStore, BuildRunner } from "./build.ts";
import { computeCacheKey } from "./cache.ts";
import { validateGeneratedDockerfile } from "./generate.ts";
import type { DockerfileGenerator } from "./generate.ts";
import type { EnvironmentHealthChecker, HealthSandboxPort } from "./health.ts";
import { healthPlanFor, runHealthCheck } from "./health.ts";
import { createHealthSandboxPort } from "./health-sandbox.ts";
import { SandboxManager } from "../manager/sandbox-manager.ts";
import type { SandboxApiClient } from "../client/sandbox-api.ts";
import { inferFromClone } from "./infer.ts";
import type { BuildOutcome, EnqueueRequest } from "./queue.ts";
import { BuildQueue } from "./queue.ts";
import { resolveImageRef } from "../provider/image-ref.ts";
import type { EnvironmentResolverDeps, EnvResolution, EnvResolverStore } from "./resolve.ts";
import { resolveEnvironment } from "./resolve.ts";
import type { PromoteResult, RevisionStore, RollbackStore } from "./revision.ts";
import {
  DEFAULT_KEEP_REVISIONS,
  planRevisionCleanup,
  promoteEnvironment,
  pruneRevisionImages,
  rollbackEnvironment,
} from "./revision.ts";
import type { CacheHit, EnvironmentRow } from "./store.ts";
import {
  cacheHitOf,
  findCacheHit,
  getEnvironmentByRevision,
  getProjectEnvState,
  insertEnvironment,
  listEnvironments,
  listReferencedDigests,
  pgEnvBuildStore,
  setProjectEnvState,
} from "./store.ts";
import type { EnvironmentCandidate, EnvStatus, RepoSignals } from "./types.ts";
import type { Queryable } from "../db/client.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { prefixedId } from "../ulid.ts";

/** 体检沙箱的 run id 前缀（`sandboxes.run_id` 是自由文本，用它区分体检与真执行）。 */
export const ENV_CHECK_RUN_PREFIX = "envcheck";

// ---------------------------------------------------------------- 存储适配

/** 三个端口（解析 / 版本 / 回滚）共用一份适配：`store.ts` 的函数带 `Queryable` 首参。 */
export function environmentStore(db: Queryable): EnvResolverStore & RevisionStore & RollbackStore {
  return {
    getProjectEnvState(projectKey: string) {
      return getProjectEnvState(db, projectKey);
    },
    getEnvironmentByRevision(projectKey: string, revision: number): Promise<EnvironmentRow | null> {
      return getEnvironmentByRevision(db, projectKey, revision);
    },
    async findCacheHit(projectKey: string, cacheKey: string): Promise<CacheHit | null> {
      const row = await findCacheHit(db, projectKey, cacheKey);
      return row === null ? null : cacheHitOf(row);
    },
    insertEnvironment(input: {
      projectKey: string;
      candidate: EnvironmentCandidate;
      signals: RepoSignals;
      status?: EnvStatus;
      cacheKey?: string | null;
    }): Promise<EnvironmentRow> {
      return insertEnvironment(db, input);
    },
    async setProjectEnvState(projectKey: string, revision: number): Promise<void> {
      await setProjectEnvState(db, projectKey, revision);
    },
  };
}

// ---------------------------------------------------------------- 队列（进程级）

export interface EnvironmentQueueConfig {
  db: Queryable;
  builder: BuildRunner;
  generator?: DockerfileGenerator | null;
  logStore?: BuildLogStore | null;
  /** 体检沙箱口。不给 = 构建成功后就停在 `building`（P6 的行为；没接 Docker 的部署形态）。 */
  healthSandbox?: HealthSandboxPort | null;
  /** 体检沙箱里的仓库根（与工具层、提示词同一个常量）。 */
  repoDir: string;
  healthTimeoutMs?: number;
  /** 单轮构建超时（缺省由 builder 定：10 分钟）。 */
  timeoutMs?: number;
  maxAttempts?: number;
  log?: LogFn;
}

/**
 * 建一个进程级的构建队列，并把体检端口接上——于是"构建成功 → 体检 → ready/degraded/failed"
 * 是同一条链上的三段，不需要第三个调用方记得去补那一步。
 */
export function createEnvironmentQueue(config: EnvironmentQueueConfig): BuildQueue {
  const log = config.log ?? noopLog;
  return new BuildQueue({
    builder: config.builder,
    store: pgEnvBuildStore(config.db),
    generator: config.generator ?? null,
    health: createEnvironmentHealthChecker({
      sandbox: config.healthSandbox ?? null,
      logs: config.logStore ?? null,
      repoDir: config.repoDir,
      ...(config.healthTimeoutMs === undefined ? {} : { timeoutMs: config.healthTimeoutMs }),
      log,
    }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
    log,
  });
}

// ---------------------------------------------------------------- 体检（端口实现）

export interface EnvironmentHealthCheckerOptions {
  sandbox?: HealthSandboxPort | null;
  logs?: BuildLogStore | null;
  repoDir: string;
  timeoutMs?: number;
  log?: LogFn;
}

/**
 * 体检端口的生产实现：算计划 → 在一次性沙箱里跑 → 出一份报告。
 * 仓库的 clone / 灌入 / 销毁在 `health-sandbox.ts`（那个文件认识 manager 与 git）。
 */
export function createEnvironmentHealthChecker(
  options: EnvironmentHealthCheckerOptions,
): EnvironmentHealthChecker | null {
  const sandbox = options.sandbox ?? null;
  if (sandbox === null) return null;
  const log = options.log ?? noopLog;

  return {
    async check(input) {
      const plan = healthPlanFor({ candidate: input.candidate, signals: input.signals });
      const runId = prefixedId(ENV_CHECK_RUN_PREFIX);
      return runHealthCheck({
        image: input.image,
        runId,
        repoDir: options.repoDir,
        plan,
        sandbox,
        logs: options.logs ?? null,
        logKey: envHealthLogKey(input.projectKey, input.revision, runId),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        log,
      });
    },
  };
}

// ---------------------------------------------------------------- 子系统装配

export interface EnvironmentSubsystemOptions {
  db: Queryable;
  projectKey: string;
  /** 推断的输入（Run 已经 clone 好的目录）；体检沙箱会自己再 clone 一份。 */
  cloneDir: string;
  /** 体检沙箱专用的 manager（**不带 artifacts**，见 `health-sandbox.ts`）。 */
  healthManager: SandboxManager;
  api: SandboxApiClient;
  /** 仓库来源（体检要在同一个 commit 上做）。 */
  repo: { url: string; commit: string; token: () => Promise<string | null> };
  /** 日志落点（构建日志与体检日志都走它）。缺省 `envBuildLogStoreFromEnv()`。 */
  logStore?: BuildLogStore | null;
  builder?: BuildRunner | null;
  generator?: DockerfileGenerator | null;
  /** 体检沙箱里的仓库根。 */
  repoDir: string;
  /** 单轮构建超时。 */
  timeoutMs?: number;
  /** 不体检（排障构建本身时用）。 */
  health?: boolean;
  log?: LogFn;
}

/** 装配结果：队列（进程级）+ 运行时（仓库级）+ 日志落点（UI 的日志代理要用）。 */
export interface EnvironmentSubsystem {
  queue: BuildQueue;
  runtime: EnvironmentRuntime;
  logStore: BuildLogStore;
}

/**
 * 一条命令把环境子系统装好：日志落点 → 构建器 → 体检沙箱 → 队列 → 运行时。
 *
 * 【为什么这个装配要在 CP 里而不是两个脚本里】`agent:run`、`env:build`、环境页的服务都要
 * 同一套（否则三个地方会各自漂出一个不同的默认值：日志落点、体检开关、单轮超时……）。
 * 脚本仍然负责"造哪些具体实现"（db / manager / 模型），这里只负责把它们接成形状。
 */
export function createEnvironmentSubsystem(options: EnvironmentSubsystemOptions): EnvironmentSubsystem {
  const log = options.log ?? noopLog;
  const logStore = options.logStore ?? envBuildLogStoreFromEnv();
  const builder = options.builder ?? new DockerBuildRunner({ logStore, log });
  const healthSandbox =
    options.health === false
      ? null
      : createHealthSandboxPort({
          manager: options.healthManager,
          api: options.api,
          repo: options.repo,
          workspaceDir: options.repoDir,
          log,
        });
  const queue = createEnvironmentQueue({
    db: options.db,
    builder,
    generator: options.generator ?? null,
    logStore,
    healthSandbox,
    repoDir: options.repoDir,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    log,
  });
  const runtime = createEnvironmentRuntime({
    db: options.db,
    projectKey: options.projectKey,
    cloneDir: options.cloneDir,
    queue,
    log,
  });
  return { queue, runtime, logStore };
}

// ---------------------------------------------------------------- 运行时（仓库级）

/** 一次构建尝试的结果（两个入口共用）。 */
export interface BuildAttempt {
  /** 命中缓存：一轮都没跑、没有新 revision。 */
  cacheHit: boolean;
  /** 这一版（命中时是被复用的那一版）。 */
  revision: number;
  /** 新落的 revision（命中时为 null）。 */
  environment: EnvironmentRow | null;
  cacheKey: string;
  /** 真构建时的那次结果（命中时为 null）。 */
  outcome: BuildOutcome | null;
}

export interface EnvironmentRuntimeOptions {
  db: Queryable;
  /** `owner/name`（或 `local/<名>`）。 */
  projectKey: string;
  /** 推断的输入：Run 已经 clone 好的目录（毫秒级只读）。 */
  cloneDir: string;
  /** 进程级的队列（`createEnvironmentQueue` 建的）。 */
  queue: BuildQueue;
  /** Layer 1 的 tag → digest。缺省走 docker CLI；解析不到返回 null（调用方报错）。 */
  baseImageFor?: (kind: EnvBaseKind) => Promise<string | null>;
  log?: LogFn;
}

export interface RuntimeInference {
  candidate: EnvironmentCandidate;
  signals: RepoSignals;
  cacheKey: string;
}

export interface EnvironmentRuntime {
  readonly projectKey: string;
  readonly queue: BuildQueue;
  /** 推断（候选 + 归一化信号 + 缓存键）。 */
  infer(): Promise<RuntimeInference>;
  resolve(input?: { forcedRevision?: number | null; trigger?: EnqueueRequest["trigger"] }): Promise<EnvResolution>;
  /** 缓存优先：命中就不建（不产生新 revision）。 */
  buildIfNeeded(trigger?: EnqueueRequest["trigger"]): Promise<BuildAttempt>;
  /** 显式重建：跳过缓存，落新 revision 并等结果。 */
  rebuild(trigger?: EnqueueRequest["trigger"]): Promise<BuildAttempt>;
  /** 把一份（会话里验证有效的）Dockerfile 固化成新 revision。 */
  promote(dockerfile: string, options?: { dryRun?: boolean }): Promise<PromoteResult>;
  /** 回滚：把当前指针指回旧 revision。 */
  rollback(revision: number): Promise<EnvironmentRow>;
  /** 清掉超出保留窗口、且没被任何沙箱引用过的旧镜像（只删镜像，不删行）。 */
  prune(keep?: number): Promise<{ removed: string[]; pruned: number[] }>;
}

export function createEnvironmentRuntime(options: EnvironmentRuntimeOptions): EnvironmentRuntime {
  const log = options.log ?? noopLog;
  const store = environmentStore(options.db);
  const baseImageFor = options.baseImageFor ?? defaultBaseImageResolver(log);

  const inferOnce = async (): Promise<RuntimeInference> => {
    const inference = await inferFromClone(options.cloneDir);
    return {
      candidate: inference.candidate,
      signals: inference.signals,
      cacheKey: computeCacheKey({
        baseImage: inference.candidate.baseImage,
        signals: inference.signals,
        dockerfileText: inference.candidate.dockerfile,
      }),
    };
  };

  const resolverDeps: EnvironmentResolverDeps = {
    store,
    infer: async () => {
      const inferred = await inferOnce();
      return { candidate: inferred.candidate, signals: inferred.signals };
    },
    enqueue: (request) => options.queue.enqueue(request),
    baseImageFor,
    log,
  };

  const prune = async (keep: number = DEFAULT_KEEP_REVISIONS): Promise<{ removed: string[]; pruned: number[] }> => {
    const rows = await listEnvironments(options.db, options.projectKey, 1000);
    const referenced = await listReferencedDigests(options.db);
    const plan = planRevisionCleanup(rows, { keep, referencedDigests: referenced });
    const removed = await pruneRevisionImages(plan, createDockerImageRemover(), log);
    if (removed.length > 0) log("info", `清理了 ${removed.length} 个旧环境镜像`, { projectKey: options.projectKey });
    return { removed, pruned: plan.pruned };
  };

  const pruneInBackground = (): void => {
    void prune().catch((error: unknown) => {
      log("warn", "环境镜像清理失败（留给下一轮）", {
        projectKey: options.projectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const build = async (mode: "if-needed" | "force", trigger: EnqueueRequest["trigger"]): Promise<BuildAttempt> => {
    const inferred = await inferOnce();
    if (mode === "if-needed") {
      const hit = await store.findCacheHit(options.projectKey, inferred.cacheKey);
      if (hit !== null) {
        await store.setProjectEnvState(options.projectKey, hit.revision);
        log("info", "缓存命中：复用已有镜像，不构建也不体检", {
          projectKey: options.projectKey,
          revision: hit.revision,
        });
        return { cacheHit: true, revision: hit.revision, environment: null, cacheKey: inferred.cacheKey, outcome: null };
      }
    }
    const environment = await store.insertEnvironment({
      projectKey: options.projectKey,
      candidate: inferred.candidate,
      signals: inferred.signals,
      status: "draft",
      cacheKey: inferred.cacheKey,
    });
    const outcome = await options.queue.enqueue({
      projectKey: options.projectKey,
      revision: environment.revision,
      candidate: inferred.candidate,
      signals: inferred.signals,
      trigger,
      cacheKey: inferred.cacheKey,
    });
    if (outcome.ok) await store.setProjectEnvState(options.projectKey, environment.revision);
    // 新镜像出来了正是清理旧镜像的时机（超出窗口 + 没人引用的那些）。
    if (outcome.ok && !outcome.cached) pruneInBackground();
    return { cacheHit: false, revision: environment.revision, environment, cacheKey: inferred.cacheKey, outcome };
  };

  return {
    projectKey: options.projectKey,
    queue: options.queue,
    infer: inferOnce,
    resolve: (input = {}) =>
      resolveEnvironment(resolverDeps, {
        projectKey: options.projectKey,
        ...(input.forcedRevision === undefined ? {} : { forcedRevision: input.forcedRevision }),
        ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      }),
    buildIfNeeded: (trigger = "manual") => build("if-needed", trigger),
    rebuild: (trigger = "manual") => build("force", trigger),

    async promote(dockerfile, promoteOptions = {}): Promise<PromoteResult> {
      // 硬约束与生成的 Dockerfile 同一套：promote 是"人写的文本进构建"，它必须过同一道闸
      // （FROM 只能来自 Layer 1、不许 CMD/ENTRYPOINT、不许 COPY 仓库内容……）。
      const violations = validateGeneratedDockerfile(dockerfile);
      if (violations.length > 0) {
        throw new PromoteError("constraint_violation", `promote 的 Dockerfile 违反硬约束：${violations.join("；")}`);
      }
      const inferred = await inferOnce();
      // 基线取**当前仓库事实**的推断结果（buildCommands / level / signals 都来自它），
      // 只把 dockerfile 与 baseImageKind 换成这份文本自己的事实。
      const kind = baseKindOfRef(fromOf(dockerfile) ?? inferred.candidate.baseImage) ?? inferred.candidate.baseImageKind;
      const candidate: EnvironmentCandidate = {
        ...inferred.candidate,
        dockerfile,
        baseImageKind: kind,
        baseImage: baseImageRef(kind),
        notes: [...inferred.candidate.notes, `promote：以人为给定的 Dockerfile 固化为一版新环境（${kind}）`],
      };
      return promoteEnvironment(
        { store, queue: options.queue, log },
        {
          projectKey: options.projectKey,
          dockerfile,
          candidate,
          signals: inferred.signals,
          ...(promoteOptions.dryRun === undefined ? {} : { dryRun: promoteOptions.dryRun }),
        },
      );
    },

    rollback: (revision) => rollbackEnvironment(store, { projectKey: options.projectKey, revision }),
    prune,
  };
}

/** promote 的文本不合规（与 `generate.ts` 的硬约束同一套判据）。 */
export class PromoteError extends Error {
  readonly reason: "constraint_violation";

  constructor(reason: "constraint_violation", message: string) {
    super(message);
    this.name = "PromoteError";
    this.reason = reason;
  }
}

/** 取 Dockerfile 的第一条 `FROM` 的镜像引用（没有就返回 null）。 */
export function fromOf(dockerfile: string): string | null {
  const match = /^\s*FROM\s+(\S+)/im.exec(dockerfile);
  return match === null ? null : match[1]!;
}

/** 缺省的 Layer 1 解析：docker CLI（`provider/image-ref.ts`）。解析不到只记 warn、返回 null。 */
function defaultBaseImageResolver(log: LogFn): (kind: EnvBaseKind) => Promise<string | null> {
  return async (kind) => {
    const tag = baseImageRef(kind);
    try {
      return await resolveImageRef(tag, "npm run build:base-images");
    } catch (error) {
      log("warn", `本地没有 Layer 1 镜像 ${tag}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
}

/** `docker image rm`。失败由 `pruneRevisionImages` 记 warn（清理是尽力而为的后台动作）。 */
export function createDockerImageRemover(
  options: { docker?: string; timeoutMs?: number } = {},
): (digest: string) => Promise<void> {
  const docker = options.docker ?? "docker";
  return async (digest) => {
    const outcome = await runProcess([docker, "image", "rm", digest], {
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    if (outcome.code !== 0) throw new Error(`docker image rm ${digest} 退出码 ${outcome.code}`);
  };
}
