/**
 * `environment/queue.ts` —— 构建队列与自愈循环（spec Phase 6 §4/§6；设计文档 §C.4/§C.8）。
 *
 * 【这个文件是 P6 的编排层】它把三件事串起来：生成（`generate.ts`）、构建（`build.ts`）、
 * 记账（`store.ts` 的端口）。它自己不认识 docker、不认识模型、不认识 SQL——三样都是注入的
 * 端口。所以"三轮上限、失败不阻塞、同一仓库去重、每轮一行 attempt"这些**行为**可以在
 * 没有 docker / PG / 网络的单测里逐条验证。
 *
 * 【队列为什么是"串行 + 去重"两个动作，而不是一个信号量】
 *  · **并发 1 是串行**：宿主机 docker daemon 是共享资源（设计文档 §C.7），队列就是一条链，
 *    后来的排在链尾。用一个计数信号量会让"谁在跑、谁在等"变成不可见的内部状态，而 UI 要
 *    能回答"我的仓库排到了没有"——链尾的位置就是答案。
 *  · **去重按 project_key**：同一个仓库已经有构建在跑（或排着队）时，第二次入队**复用那一次**
 *    的结果，而不是再排一次。`first_seen` 是会话创建时触发的，一个仓库很快会有第二个会话——
 *    没有这一步，第二次入队会在构建后面再排一遍完全相同的工作。
 *  · **失败不阻塞**：链上挂的是"吞掉结果"的 promise。一个坏仓库的 3×10 分钟不应该让后面
 *    所有仓库都等它。（这也是"失败是结果"在队列层面的样子：`enqueue` 对构建失败不抛。）
 *
 * 【成功之后为什么状态还是 building（直到体检）】`ready` 的定义是"依赖装上了、构建命令跑通了"（设计文档
 * §C.6），那是 P7 在一次性沙箱里体检的结论。P6 只能证明"docker build 成功"，所以环境行先留在
 * `building`；P7 接上体检端口之后，队列在同一次入队里把它推到 ready / degraded / failed。
 * 没有体检端口（没接 Docker 的部署形态、集成测试里只验构建）时仍然留在 `building`。
 *
 * 【队列为什么自己也查缓存】P6 §6 的原话：“已有 ready 且 cache_key 没变 → 直接返回旧 digest”。
 * 上游（resolve / `env:build`）也会在插入新 revision 之前查一次，那一次是常规路径；
 * 这里这一道是**最后一道闸**：即使调用方没查、或者两个进程同时为了同一个仓库入队，
 * 也不会重复构建。命中时把 digest 与体检结论复制到本次要求的那一版上，好让“它被要求建，
 * 但事实上复用了”这件事在库里也看得见。
 */

import type { Usage, UsageRow } from "@reuben-cloud/agent-runtime";
import type { BuildFailure, BuildResult, BuildRunner, EnvBuildErrorClass } from "./build.ts";
import { classifyBuildFailure, envBuildLogKey, envImageTag } from "./build.ts";
import type { DockerfileGenerator } from "./generate.ts";
import { GenerationError, validateGeneratedDockerfile } from "./generate.ts";
import type { EnvironmentHealthChecker, HealthReport } from "./health.ts";
import type { EnvBuildStore } from "./store.ts";
import { envBuildId } from "./store.ts";
import type { EnvBuildInference, EnvBuildTrigger, EnvironmentCandidate, RepoSignals } from "./types.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

/** 轮数硬上限（spec 技术边界：**代码**里的约束，不是运维约定）。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * `network_timeout` 的重试上限（spec §3 的表："网络问题，重试可能有效"——不重试超过 1 次）。
 *
 * 【为什么单独卡这一类】网络抖动重试一次是对的；把三次机会都花在同一个 DNS 故障上，
 * 只会让队列后面的仓库多等 20 分钟、多烧两次模型调用，而结果一样。
 */
export const NETWORK_RETRY_LIMIT = 1;

export interface EnqueueRequest {
  /** `owner/name`（或 `local/<dir>`）。队列按它去重。 */
  projectKey: string;
  /** 对应 `environments` 的那一版（调用方先insert；见 store.ts）。 */
  revision: number;
  /** P5 的推断结果：第一轮的规则文本、基础镜像选择、level 都在这里。 */
  candidate: EnvironmentCandidate;
  /** 与候选一起采集的信号（生成 prompt 的输入）。 */
  signals: RepoSignals;
  trigger: EnvBuildTrigger;
  /**
   * 这一版的缓存键（`computeCacheKey()`）。队列用它做最后一道缓存闸；
   * `trigger === "manual"` 时跳过（人显式要求重建，见文件头的说明与附录 A-4x）。
   */
  cacheKey: string;
}

/** 一次入队的最终结果。**失败也是结果**（ok=false + 结构化原因，不抛）。 */
export interface BuildOutcome {
  projectKey: string;
  revision: number;
  ok: boolean;
  /** 成功时的镜像 digest（成功才有值）。 */
  imageDigest: string | null;
  /** 真正跑了几轮（1..maxAttempts）。 */
  attempts: number;
  /** 最终失败时的分类；成功时是 null。 */
  errorClass: EnvBuildErrorClass | null;
  /** 最终失败的人话说明（UI 与 CLI 直接用）。 */
  detail: string | null;
  /** 每次尝试的 `env_builds.id`（排障时按它取日志）。 */
  buildIds: string[];
  /** 模型真的参与了（有 LLM 生成）——成本与排障用。 */
  usedModel: boolean;
  /** 缓存命中：**一轮都没跑**，digest 与体检结论都是复用的。`attempts === 0` 与它同义。 */
  cached: boolean;
  /** 体检报告（没接体检端口、或体检自己崩了时为 null）。 */
  health: HealthReport | null;
}

export interface BuildQueueOptions {
  builder: BuildRunner;
  store: EnvBuildStore;
  /**
   * 生成端口。不给 = 只能用规则生成的 Dockerfile（没配模型 key 的部署形态）；
   * `signals` 级的仓库会退化成"只有一行 FROM 的规则镜像"，能跑但没有系统依赖。
   */
  generator?: DockerfileGenerator | null;
  /**
   * 体检端口（P7）。不给 = 构建成功后就停在 `building`（没接 Docker 的部署形态、
   * 只验构建的集成测试）。给了且在构建成功后跑一次，结论直接落进环境行的 status / health。
   */
  health?: EnvironmentHealthChecker | null;
  /** 轮数上限。缺省 3（测试会调小）。 */
  maxAttempts?: number;
  /** 单轮超时，透传给 builder。缺省由 builder 定（10 分钟）。 */
  timeoutMs?: number;
  log?: LogFn;
}

/** 一轮的生成计划（无论规则还是模型，都归成这一个形状）。 */
interface AttemptPlan {
  dockerfile: string;
  inference: EnvBuildInference;
  usage: Usage | null;
  provider: string | null;
  model: string | null;
  usedModel: boolean;
  /** 生成阶段就没成（模型失败 / 没有代码块）。非 null 时这一轮不进构建。 */
  generationError: GenerationError | null;
}

export class BuildQueue {
  readonly #builder: BuildRunner;
  readonly #store: EnvBuildStore;
  readonly #generator: DockerfileGenerator | null;
  readonly #health: EnvironmentHealthChecker | null;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number | undefined;
  readonly #log: LogFn;
  /** 每个 project_key 的进行中任务（去重靠它，见文件头）。 */
  readonly #pending = new Map<string, Promise<BuildOutcome>>();
  /** 串行链（并发 1：队列就是这条链，后来的排链尾）。 */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: BuildQueueOptions) {
    this.#builder = options.builder;
    this.#store = options.store;
    this.#generator = options.generator ?? null;
    this.#health = options.health ?? null;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#timeoutMs = options.timeoutMs;
    this.#log = options.log ?? noopLog;
  }

  /** 还在等或还在跑的仓库数（UI 的"排队中"与测试用）。 */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * 入队。同一个 project_key 已有任务时**复用那一次**（返回同一个 promise）。
   *
   * 【这个 promise 拒绝意味着什么】构建失败是 `BuildOutcome.ok=false`，不会拒绝。
   * 拒绝只发生在基础设施错误（数据库写不进去、存储端口抛了）——那是调用方必须看见的，
   * 所以这里不吞。`first_seen` 那种"发完不管"的调用要自己挂一个 catch（P7 的接线）。
   */
  enqueue(request: EnqueueRequest): Promise<BuildOutcome> {
    const existing = this.#pending.get(request.projectKey);
    if (existing !== undefined) {
      this.#log("info", "同一个仓库已有构建任务，复用那一次", { projectKey: request.projectKey });
      return existing;
    }
    const run = this.#chain.then(() => this.#run(request));
    // 链上挂"吞结果"的版本：一个仓库失败不能卡住后面排队的（测试要点 10）。
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    const settled = run.finally(() => {
      if (this.#pending.get(request.projectKey) === settled) this.#pending.delete(request.projectKey);
    });
    this.#pending.set(request.projectKey, settled);
    return settled;
  }

  /** 等队列空（CLI 收尾与测试用；不改变队列的行为）。 */
  async drain(): Promise<void> {
    // 每等一轮都重新取 `#chain`：等的时候可能有人又入队了。
    let current: Promise<unknown> | null = null;
    while (current !== this.#chain) {
      current = this.#chain;
      await current;
    }
  }

  // -------------------------------------------------------------- 一轮一轮地跑

  async #run(request: EnqueueRequest): Promise<BuildOutcome> {
    const { projectKey, revision, candidate } = request;
    this.#log("info", "开始构建环境", { projectKey, revision, trigger: request.trigger });

    // ---- 最后一道缓存闸（见文件头）。manual 跳过：人显式要求重建时，"缓存键没变"不是理由
    // ——他可能正是因为 Layer 1 被重建、上游依赖变了才点的那一下（缓存键看不见这两件事）。
    if (request.trigger !== "manual") {
      const hit = await this.#store.findCacheHit(projectKey, request.cacheKey);
      if (hit !== null) {
        await this.#store.setEnvironmentImage(projectKey, revision, hit.imageDigest);
        if (hit.health !== null) await this.#store.setEnvironmentHealth(projectKey, revision, hit.health);
        else await this.#store.setEnvironmentStatus(projectKey, revision, hit.status);
        this.#log("info", "缓存命中，复用已有镜像与体检结论", {
          projectKey,
          revision,
          hitRevision: hit.revision,
          digest: hit.imageDigest,
        });
        return {
          projectKey,
          revision,
          ok: true,
          imageDigest: hit.imageDigest,
          attempts: 0,
          errorClass: null,
          detail: null,
          buildIds: [],
          usedModel: false,
          cached: true,
          health: hit.health,
        };
      }
    }

    const touched = await this.#store.setEnvironmentStatus(projectKey, revision, "building");
    if (touched === 0) {
      // 环境行不在 = 调用方跳过了 insertEnvironment。不抛（构建本身还有意义），但要说出来。
      this.#log("warn", "环境行不存在，状态没能推进", { projectKey, revision });
    }

    const buildIds: string[] = [];
    let previousDockerfile: string | null = null;
    let failure: BuildFailure | null = null;
    let lastLog = "";
    let attempts = 0;
    let usedModel = false;
    let built: { text: string; digest: string } | null = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      attempts = attempt;
      const buildId = envBuildId();
      buildIds.push(buildId);
      const attemptStartedAt = Date.now();

      const plan = await this.#plan(request, attempt, previousDockerfile, failure, lastLog);
      usedModel = usedModel || plan.usedModel;

      // 硬约束校验（生成失败时没有可校验的文本——它连 build 都不进）。
      const violations = plan.generationError === null ? validateGeneratedDockerfile(plan.dockerfile) : [];

      // 开行：UI 从这里就能看见"正在建第 N 轮"。
      await this.#store.startAttempt({
        id: buildId,
        projectKey,
        revision,
        attempt,
        inference: plan.inference,
        trigger: request.trigger,
        dockerfile: plan.dockerfile,
      });

      // 记账：模型调用已经发生，无论这一轮建不建得成都花了钱。
      if (plan.usage !== null && plan.provider !== null && plan.model !== null) {
        await this.#store.recordUsage(usageRowOf(plan));
      }

      // ---- 生成阶段失败：记行，不进构建。
      if (plan.generationError !== null) {
        failure = {
          klass: "generation_failed",
          detail: plan.generationError.reason,
          advice: `上一次没有产出可用的 Dockerfile：${plan.generationError.message}`,
        };
        previousDockerfile = plan.dockerfile;
        await this.#store.finishAttempt(buildId, {
          status: "failed",
          errorClass: failure.klass,
          logKey: null,
          durationMs: Date.now() - attemptStartedAt,
          imageDigest: null,
        });
        this.#log("warn", "环境 Dockerfile 生成失败", {
          projectKey,
          revision,
          attempt,
          reason: plan.generationError.reason,
        });
        continue;
      }

      // ---- 硬约束违规：同样不进构建（spec §1："校验不通过直接判失败，不进 build"）。
      if (violations.length > 0) {
        failure = {
          klass: "constraint_violation",
          detail: violations[0] ?? null,
          advice: `上一次生成的 Dockerfile 违反了硬约束，这次别再这么写：${violations.join("；")}`,
        };
        previousDockerfile = plan.dockerfile;
        await this.#store.finishAttempt(buildId, {
          status: "failed",
          errorClass: failure.klass,
          logKey: null,
          durationMs: Date.now() - attemptStartedAt,
          imageDigest: null,
        });
        this.#log("warn", "环境 Dockerfile 违反硬约束，已拒绝（不进构建）", {
          projectKey,
          revision,
          attempt,
          violations,
        });
        continue;
      }

      // ---- 真构建。
      let result: BuildResult;
      try {
        result = await this.#builder.build({
          dockerfile: plan.dockerfile,
          tag: envImageTag(projectKey, revision),
          logKey: envBuildLogKey(projectKey, revision, buildId),
          ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
        });
      } catch (error) {
        // 构建器**抛异常**是它自己的契约破了（它只应该返回 ok:false）；重试一个坏掉的 runner
        // 不会变好，所以记一行、停下。不静默吞掉："构建没开始"与"构建失败"是两件事。
        const message = error instanceof Error ? error.message : String(error);
        failure = { klass: "unknown", detail: null, advice: `构建器抛异常（不是构建失败）：${message}` };
        await this.#store.finishAttempt(buildId, {
          status: "failed",
          errorClass: failure.klass,
          logKey: null,
          durationMs: Date.now() - attemptStartedAt,
          imageDigest: null,
        });
        this.#log("error", "构建器抛异常，停止自愈", { projectKey, revision, attempt, error: message });
        break;
      }
      const durationMs = Date.now() - attemptStartedAt;

      if (result.ok && result.imageDigest !== null) {
        built = { text: plan.dockerfile, digest: result.imageDigest };
        await this.#store.finishAttempt(buildId, {
          status: "built",
          errorClass: null,
          logKey: result.logKey,
          durationMs,
          imageDigest: result.imageDigest,
        });
        this.#log("info", "环境镜像构建成功", { projectKey, revision, attempt, digest: result.imageDigest });
        break;
      }
      if (result.ok) {
        // 构建成功但拿不到 digest：这个镜像没有可引用的身份（`SandboxSpec.image` 只收 digest），
        // 所以它对产品来说是不可用的。重试没有意义（下一次大概率还拿不到），直接停。
        failure = { klass: "unknown", detail: null, advice: "构建成功但拿不到镜像 digest（--iidfile 与 image inspect 都失败）" };
        await this.#store.finishAttempt(buildId, {
          status: "failed",
          errorClass: failure.klass,
          logKey: result.logKey,
          durationMs,
          imageDigest: null,
        });
        this.#log("warn", "环境镜像构建成功但没有 digest，按不可用处理", { projectKey, revision, attempt });
        break;
      }

      failure = classifyBuildFailure({ log: result.log, timedOut: result.timedOut, aborted: result.aborted });
      if (result.errorMessage !== null) failure = { ...failure, advice: `${failure.advice}（${result.errorMessage}）` };
      lastLog = result.log;
      previousDockerfile = plan.dockerfile;
      await this.#store.finishAttempt(buildId, {
        status: "failed",
        errorClass: failure.klass,
        logKey: result.logKey,
        durationMs,
        imageDigest: null,
      });
      this.#log("info", "环境镜像构建失败", {
        projectKey,
        revision,
        attempt,
        errorClass: failure.klass,
        detail: failure.detail,
      });

      // 网络类故障：只值得再试一次（见 NETWORK_RETRY_LIMIT）。
      if (failure.klass === "network_timeout" && attempt > NETWORK_RETRY_LIMIT) {
        this.#log("warn", "网络类故障已达到重试上限，停止自愈", { projectKey, revision, attempt });
        break;
      }
    }

    const ok = built !== null;
    let health: HealthReport | null = null;
    if (built !== null) {
      // 自愈改过的文本要写回环境定义：P7 的缓存键读的是这一列（见 store.ts 的说明）。
      if (built.text !== candidate.dockerfile) {
        await this.#store.setEnvironmentDockerfile(projectKey, revision, built.text);
      }
      // ---- 镜像落库（P7）：Run 侧的解析、缓存命中、UI 都读这一列。
      const imaged = await this.#store.setEnvironmentImage(projectKey, revision, built.digest);
      if (imaged === 0) this.#log("warn", "环境行不存在，镜像 digest 没能落库", { projectKey, revision });

      // ---- 体检（P7 §3）：构建成功 ≠ 能用。这一步在**一次性沙箱**里跑（§C.6）。
      // 没接体检端口：留在 building（P6 的行为，见文件头）。
      if (this.#health !== null) {
        try {
          health = await this.#health.check({
            projectKey,
            revision,
            image: built.digest,
            candidate,
            signals: request.signals,
          });
          const checked = await this.#store.setEnvironmentHealth(projectKey, revision, health);
          if (checked === 0) this.#log("warn", "环境行不存在，体检结论没能落库", { projectKey, revision });
        } catch (error) {
          // 体检自己崩了（建沙箱的基础设施错误、存储抖动）：**不把环境判死**。
          // 镜像真的建出来了，只是我们还不知道能不能用——那就如实停在 building。
          this.#log("warn", "环境体检没能完成，状态留在 building", {
            projectKey,
            revision,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      // 三/二/一轮全失败：环境行收在 failed（P7 的健康检查不会再跑它）。
      const touchedAfter = await this.#store.setEnvironmentStatus(projectKey, revision, "failed");
      if (touchedAfter === 0) this.#log("warn", "环境行不存在，失败状态没能落库", { projectKey, revision });
    }

    const outcome: BuildOutcome = {
      projectKey,
      revision,
      ok,
      imageDigest: built === null ? null : built.digest,
      attempts,
      errorClass: ok ? null : (failure?.klass ?? "unknown"),
      detail: ok ? null : (failure?.advice ?? null),
      buildIds,
      usedModel,
      cached: false,
      health,
    };
    this.#log("info", ok ? "环境构建完成" : "环境构建最终失败", {
      projectKey,
      revision,
      attempts,
      errorClass: outcome.errorClass,
    });
    return outcome;
  }

  // -------------------------------------------------------------- 生成（规则 / 模型）

  /**
   * 决定这一轮用哪种生成方式。
   *
   * 【为什么 `signals` 级的第一轮就走模型】P5 §4 对这一级的原话是"本地规则；P6 接 LLM 生成"：
   * 规则渲染对 signals 级只给得出一行 `FROM base-<lang>`（没有作者写的 devcontainer / Dockerfile
   * 可复用的东西），而这一级恰恰是最需要"从信号里推断系统依赖"的一级。等构建失败再上模型的话，
   * 一行 FROM 的镜像**几乎永远构不出错**——模型就永远没有机会出手，环境里也就永远没有系统依赖。
   * devcontainer / dockerfile 级相反：规则输出里已经有作者的事实，第一轮先用它（省一次模型调用），
   * 失败再自愈（附录 A-33）。
   */
  async #plan(
    request: EnqueueRequest,
    attempt: number,
    previousDockerfile: string | null,
    failure: BuildFailure | null,
    lastLog: string,
  ): Promise<AttemptPlan> {
    const { candidate, signals } = request;
    const generator = this.#generator;
    const useModel = generator !== null && (attempt > 1 || candidate.level === "signals");
    if (!useModel || generator === null) {
      // 没有生成端口时（没配模型 key / `--no-model`）三轮跑的是同一份文本。不提前退出：
      // 网络类故障完全可能在第 2/3 轮成功（那一类的重试上限是 1 次，见 NETWORK_RETRY_LIMIT），
      // 而"同文本重跑"对代码类的错误只是多花两次构建——轮数上限本来就是这么设计的。
      return {
        dockerfile: candidate.dockerfile,
        inference: candidate.level,
        usage: null,
        provider: null,
        model: null,
        usedModel: false,
        generationError: null,
      };
    }

    const retry =
      previousDockerfile === null || failure === null
        ? null
        : { previousDockerfile, failure, logTail: lastLog };
    try {
      const generated = await generator.generate({
        signals,
        baseline: candidate.dockerfile,
        retry,
      });
      return {
        dockerfile: generated.dockerfile,
        inference: "llm",
        usage: generated.usage,
        provider: generated.provider,
        model: generated.model,
        usedModel: true,
        generationError: null,
      };
    } catch (error) {
      if (!(error instanceof GenerationError)) throw error;
      return {
        dockerfile: error.raw === "" ? `# 生成失败：${error.message}\n` : error.raw,
        inference: "llm",
        usage: error.usage,
        provider: generator.provider,
        model: generator.model,
        usedModel: true,
        generationError: error,
      };
    }
  }
}

/** `Usage`（模型客户端的形状）→ `UsageRow`（账本的形状）。四个量一一对应，只换了名字。 */
function usageRowOf(plan: AttemptPlan): UsageRow {
  const usage = plan.usage!;
  return {
    sessionId: null,
    runId: null,
    kind: "env_build",
    provider: plan.provider!,
    model: plan.model!,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    cacheWriteTokens: usage.cacheCreationInputTokens,
  };
}
