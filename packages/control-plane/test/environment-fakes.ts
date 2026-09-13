/**
 * P6 的测试替身：假 builder、脚本化生成器、内存 store（**不是测试文件**——两个测试 glob
 * 只收 `test/unit/*.test.ts` 与 `test/integration/*.test.ts`，所以它不会被当用例跑）。
 *
 * 【为什么要有一份共享的替身，而不是每个测试文件各写一份】单测（无 docker / 无 PG）与集成
 * 测试（真 PG、真 docker）都要用同一套"按脚本失败/成功"的 builder；两份实现必然漂开，
 * 而漂开的那一份会让"单测里成立的行为在集成里不成立"这种最难查的问题发生。
 * 集成测试里用假 builder 的场合是**队列行为**（去重、记账、状态推进），真构建那条用例
 * 用 `DockerBuildRunner`（spec 测试要点 7）。
 *
 * 【替身不模拟什么】假 builder 不执行 Dockerfile、不产生真日志——它按脚本返回
 * `BuildResult`。所以"真 docker 会怎么报错"这件事只能由 `test/fixtures/build-logs/*.log`
 * 的真日志样本与集成测试来证明；替身只保证"拿到某种结果时，编排的行为是对的"。
 */

import type { Usage, UsageRow } from "@reuben-cloud/agent-runtime";
import type { BuildRequest, BuildResult, BuildRunner } from "../src/environment/build.ts";
import type { DockerfileGeneration, DockerfileGenerator, GenerateInput } from "../src/environment/generate.ts";
import { GenerationError } from "../src/environment/generate.ts";
import type { EnvironmentHealthChecker, HealthReport } from "../src/environment/health.ts";
import { readStoredHealth } from "../src/environment/health.ts";
import type { EnvResolverStore } from "../src/environment/resolve.ts";
import type { RollbackStore, RevisionStore } from "../src/environment/revision.ts";
import type { CacheHit, EnvBuildFinish, EnvBuildStore, EnvironmentRow, NewEnvBuild } from "../src/environment/store.ts";
import type { EnvBuildStatus, EnvironmentCandidate, EnvStatus, RepoSignals } from "../src/environment/types.ts";

/** 一个合法的本地镜像 digest（provider 认的两种形态之一）。 */
export const FAKE_DIGEST = `sha256:${"a".repeat(64)}`;

export function fakeSignals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    languages: ["typescript"],
    packageManagers: ["npm"],
    runtimeVersions: { node: "24" },
    hasDockerfile: false,
    hasCompose: false,
    hasDevcontainer: false,
    lockfiles: ["package-lock.json"],
    ciCommands: ["npm test"],
    makeTargets: ["build"],
    scripts: ["test"],
    services: [],
    monorepo: false,
    ignored: [],
    ...overrides,
  };
}

/** 一份推断候选。缺省是 `signals` 级（P6 第一轮就上模型的那种）。 */
export function fakeCandidate(overrides: Partial<EnvironmentCandidate> = {}): EnvironmentCandidate {
  return {
    level: "signals",
    baseImageKind: "node-dev",
    baseImage: "reuben-cloud/base-node-dev:dev",
    dockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
    buildCommands: [],
    verifyCommands: [],
    degradedRisks: [],
    notes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- 假 builder

/** 一步脚本：返回某次构建的结果（没写的字段取缺省）。 */
export interface ScriptedBuildStep {
  ok?: boolean;
  log?: string;
  timedOut?: boolean;
  aborted?: boolean;
  exitCode?: number | null;
  imageDigest?: string | null;
  errorMessage?: string | null;
  /** 覆盖日志 key（默认用请求里的那个）。 */
  logKey?: string | null;
  /** 先等这么久（毫秒）——"假 builder 卡住"用（测试要点 5）。 */
  delayMs?: number;
}

/** 按脚本逐次返回结果的 builder。脚本用完之后的调用一律成功。 */
export class FakeBuildRunner implements BuildRunner {
  readonly name = "fake";
  readonly requests: BuildRequest[] = [];
  /** 每次调用的起止时间（毫秒）。"队列是串行的"这条断言靠它（两段不能重叠）。 */
  readonly spans: Array<{ startedAt: number; endedAt: number }> = [];
  readonly #script: ScriptedBuildStep[];

  constructor(script: ScriptedBuildStep[] = []) {
    this.#script = script;
  }

  get calls(): number {
    return this.requests.length;
  }

  async build(request: BuildRequest): Promise<BuildResult> {
    const index = this.requests.length;
    this.requests.push(request);
    const startedAt = Date.now();
    const step = this.#script[index] ?? { ok: true };
    if (step.delayMs !== undefined && step.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    }
    const ok = step.ok ?? true;
    const result: BuildResult = {
      ok,
      exitCode: step.exitCode ?? (ok ? 0 : 1),
      timedOut: step.timedOut ?? false,
      aborted: step.aborted ?? false,
      log: step.log ?? (ok ? "#1 DONE 0.1s\n" : ""),
      logKey: step.logKey === undefined ? request.logKey : step.logKey,
      durationMs: step.delayMs ?? 5,
      imageDigest: ok ? (step.imageDigest === undefined ? FAKE_DIGEST : step.imageDigest) : null,
      errorMessage: step.errorMessage ?? null,
    };
    this.spans.push({ startedAt, endedAt: Date.now() });
    return result;
  }
}

// ---------------------------------------------------------------- 脚本化生成器

export interface ScriptedGenerateStep {
  /** 模型给出的 Dockerfile（函数形态可以从入参派生，比如"把失败的包名换掉"）。 */
  dockerfile?: string | ((input: GenerateInput) => string);
  /** 抛出这个错误（默认包成 `no_dockerfile_block` 的 `GenerationError`）。 */
  error?: Error;
  /** 这一步的用量（记账测试用）。 */
  usage?: Usage;
}

/** 按脚本逐次返回 Dockerfile 的生成器（脚本用完之后的调用返回第一份结果）。 */
export class ScriptedDockerfileGenerator implements DockerfileGenerator {
  readonly provider = "scripted";
  readonly model = "scripted-env";
  readonly inputs: GenerateInput[] = [];
  readonly #script: ScriptedGenerateStep[];

  constructor(script: ScriptedGenerateStep[]) {
    this.#script = script;
  }

  get calls(): number {
    return this.inputs.length;
  }

  async generate(input: GenerateInput): Promise<DockerfileGeneration> {
    const index = this.inputs.length;
    this.inputs.push(input);
    const step = this.#script[index] ?? this.#script[0] ?? { dockerfile: "FROM reuben-cloud/base-node-dev:dev\n" };
    if (step.error !== undefined) throw step.error;
    const dockerfile =
      typeof step.dockerfile === "function"
        ? step.dockerfile(input)
        : (step.dockerfile ?? "FROM reuben-cloud/base-node-dev:dev\n");
    return {
      dockerfile,
      raw: `\`\`\`dockerfile\n${dockerfile}\`\`\``,
      usage: step.usage ?? { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      provider: this.provider,
      model: this.model,
    };
  }
}

/** 一步"模型没按格式输出"的脚本（抛 `GenerationError`，与真生成器同一条路径）。
 *
 * 【为什么要带上 usage】真模型在这种情况下是**调用了的**（回复里就是没代码块），用法拿得到。
 * 账本就该记这一笔——自愈失败不代表没花钱。
 */
export function noDockerfileBlockStep(raw = "我建议你先装 libvips。"): ScriptedGenerateStep {
  return {
    error: new GenerationError("no_dockerfile_block", "回复里没有 ```dockerfile 代码块", {
      raw,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    }),
  };
}

// ---------------------------------------------------------------- 内存 store

/** 内存里的一行 attempt（`NewEnvBuild` + 收尾字段）。 */
export interface FakeEnvBuildRow extends NewEnvBuild {
  status: EnvBuildStatus;
  errorClass: string | null;
  logKey: string | null;
  durationMs: number | null;
  imageDigest: string | null;
}

/** `EnvBuildStore` 的内存实现：断言"编排往存储里写了什么"。 */
export class MemoryEnvBuildStore implements EnvBuildStore {
  readonly builds: FakeEnvBuildRow[] = [];
  readonly usage: UsageRow[] = [];
  readonly statuses: Array<{ projectKey: string; revision: number; status: EnvStatus }> = [];
  readonly dockerfileWrites: Array<{ projectKey: string; revision: number; dockerfile: string }> = [];
  /** P7：`setEnvironmentImage` 写下来的镜像（与 `statuses` 一样只用于断言）。 */
  readonly images: Array<{ projectKey: string; revision: number; imageDigest: string }> = [];
  /** P7：体检结论的落库记录。 */
  readonly healths: Array<{ projectKey: string; revision: number; report: HealthReport }> = [];
  /** P7：脚本化的缓存命中（键用 `cacheHitKey()` 拼，与 PG 实现的查询条件同一口径）。 */
  readonly cacheHits = new Map<string, CacheHit>();
  /** 设成 false 时 `setEnvironmentStatus` 返回 0（模拟"环境行不在"）。 */
  environmentExists = true;

  cacheHit(projectKey: string, cacheKey: string, hit: CacheHit): void {
    this.cacheHits.set(cacheHitKey(projectKey, cacheKey), hit);
  }

  async startAttempt(row: NewEnvBuild): Promise<void> {
    this.builds.push({
      ...row,
      status: "building",
      errorClass: null,
      logKey: null,
      durationMs: null,
      imageDigest: null,
    });
  }

  async finishAttempt(id: string, patch: EnvBuildFinish): Promise<void> {
    const row = this.builds.find((item) => item.id === id);
    if (row === undefined) throw new Error(`finishAttempt 找不到 ${id}`);
    row.status = patch.status;
    row.errorClass = patch.errorClass ?? null;
    row.logKey = patch.logKey ?? null;
    row.durationMs = patch.durationMs ?? null;
    row.imageDigest = patch.imageDigest ?? null;
  }

  async setEnvironmentStatus(projectKey: string, revision: number, status: EnvStatus): Promise<number> {
    this.statuses.push({ projectKey, revision, status });
    return this.environmentExists ? 1 : 0;
  }

  async setEnvironmentDockerfile(projectKey: string, revision: number, dockerfile: string): Promise<void> {
    this.dockerfileWrites.push({ projectKey, revision, dockerfile });
  }

  async setEnvironmentImage(projectKey: string, revision: number, imageDigest: string): Promise<number> {
    this.images.push({ projectKey, revision, imageDigest });
    return this.environmentExists ? 1 : 0;
  }

  async setEnvironmentHealth(projectKey: string, revision: number, report: HealthReport): Promise<number> {
    this.healths.push({ projectKey, revision, report });
    return this.environmentExists ? 1 : 0;
  }

  async findCacheHit(projectKey: string, cacheKey: string): Promise<CacheHit | null> {
    return this.cacheHits.get(cacheHitKey(projectKey, cacheKey)) ?? null;
  }

  async recordUsage(row: UsageRow): Promise<void> {
    this.usage.push(row);
  }
}

/** 替身里缓存命中的键（PG 那边是 `(project_key, cache_key)`；这里拼成一个字符串）。 */
export function cacheHitKey(projectKey: string, cacheKey: string): string {
  return `${projectKey}\n${cacheKey}`;
}

// ---------------------------------------------------------------- 体检的替身

/** 一份体检报告的最小形态（三态各用一次；`facts` 是 degraded 的判据）。 */
export function fakeHealthReport(
  status: HealthReport["status"] = "ready",
  facts: HealthReport["facts"] = [],
): HealthReport {
  return {
    status,
    reason: status === "ready" ? null : (facts[0]?.reason ?? "step_failed"),
    detail: status === "ready" ? null : (facts[0]?.detail ?? "npm ci 退出码 1"),
    facts,
    steps: [{ cmd: "npm ci", required: true, exitCode: status === "failed" ? 1 : 0, timedOut: false, durationMs: 1, outputTail: "" }],
    logKey: status === "ready" ? null : "env-logs/acme__web/1/envcheck_X.health.log",
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * 体检端口的替身：只记"被问了什么、返回哪一态"。
 * 【为什么不跑真命令】判定逻辑在 `environment-health.test.ts` 里逐条测过；队列要证明的是
 * "体检的结论被落进了环境行 / 体检崩了不把环境判死"，与命令无关。
 */
export class FakeHealthChecker implements EnvironmentHealthChecker {
  readonly calls: Array<{ projectKey: string; revision: number; image: string }> = [];
  report: HealthReport = fakeHealthReport();
  /** 设成一句话时 `check()` 抛这个错（模拟体检的基础设施失败）。 */
  fail: string | null = null;

  async check(input: {
    projectKey: string;
    revision: number;
    image: string;
    candidate: EnvironmentCandidate;
    signals: RepoSignals;
  }): Promise<HealthReport> {
    this.calls.push({ projectKey: input.projectKey, revision: input.revision, image: input.image });
    if (this.fail !== null) throw new Error(this.fail);
    return this.report;
  }
}

// ---------------------------------------------------------------- 版本 / promote 的替身

/**
 * `RevisionStore` + `RollbackStore` 的内存替身（P7 的 promote / 回滚单测用）。
 *
 * 【为什么不复用 `MemoryEnvBuildStore`】那一个是**队列**的存储口（attempt 行、状态推进、
 * 账本）；这一个管的是**版本**（插新行、缓存命中、当前指针）。两个测试关心的事实不同，
 * 混在一起会让每个断言都要先读懂另一半的字段。
 */
export class FakePromotionStore implements RevisionStore, RollbackStore, EnvResolverStore {
  readonly inserted: Array<{ projectKey: string; candidate: EnvironmentCandidate; signals: RepoSignals; cacheKey: string | null }> = [];
  readonly current: Array<[string, number]> = [];
  readonly rows = new Map<number, EnvironmentRow>();
  readonly cacheHits = new Map<string, CacheHit>();
  currentRevision: number | null = null;

  async insertEnvironment(input: {
    projectKey: string;
    candidate: EnvironmentCandidate;
    signals: RepoSignals;
    status?: EnvStatus;
    cacheKey?: string | null;
  }): Promise<EnvironmentRow> {
    const revision = this.rows.size + 1;
    this.inserted.push({
      projectKey: input.projectKey,
      candidate: input.candidate,
      signals: input.signals,
      cacheKey: input.cacheKey ?? null,
    });
    const row = fakeEnvironmentRow({
      revision,
      project_key: input.projectKey,
      candidate: input.candidate,
      signals: input.signals,
      status: input.status ?? "draft",
      cache_key: input.cacheKey ?? null,
      parent_revision: revision === 1 ? null : revision - 1,
    });
    this.rows.set(revision, row);
    return row;
  }

  async findCacheHit(_projectKey: string, cacheKey: string): Promise<CacheHit | null> {
    // 显式脚本优先（promote 的用例用它造"命中"）；否则按 PG 实现的同一套条件在行里找
    // （同键 + ready/degraded + 有 digest，取 revision 最大的那一版）。
    const scripted = this.cacheHits.get(cacheKey);
    if (scripted !== undefined) return scripted;
    const candidates = [...this.rows.values()]
      .filter(
        (row) =>
          row.cache_key === cacheKey &&
          row.image_digest !== null &&
          (row.status === "ready" || row.status === "degraded"),
      )
      .sort((a, b) => b.revision - a.revision);
    const row = candidates[0];
    if (row === undefined) return null;
    return {
      revision: row.revision,
      imageDigest: row.image_digest!,
      health: readStoredHealth(row.health),
      status: row.status,
      cacheKey: row.cache_key!,
    };
  }

  async setProjectEnvState(projectKey: string, revision: number): Promise<void> {
    this.current.push([projectKey, revision]);
    this.currentRevision = revision;
  }

  async getEnvironmentByRevision(_projectKey: string, revision: number): Promise<EnvironmentRow | null> {
    return this.rows.get(revision) ?? null;
  }

  /** 参数被忽略：替身只有一个"当前指针"（PG 实现按 project_key 查）。 */
  async getProjectEnvState(_projectKey?: string): Promise<{ current_revision: number } | null> {
    return this.currentRevision === null ? null : { current_revision: this.currentRevision };
  }
}

/**
 * 一行 `EnvironmentRow` 的完整工厂（缺省是一版刚落的 draft）。
 * `candidate` 是**输入**而不是行的一列：它只是"这一版的候选长什么样"的快捷写法。
 */
export function fakeEnvironmentRow(
  overrides: Partial<EnvironmentRow> & { revision: number; candidate?: EnvironmentCandidate } = { revision: 1 },
): EnvironmentRow {
  const { candidate: candidateOverride, ...rowOverrides } = overrides;
  const candidate = candidateOverride ?? fakeCandidate();
  return {
    id: `env_test_${String(overrides.revision).padStart(4, "0")}`,
    project_key: "acme/web",
    kind: "project",
    level: candidate.level,
    status: "draft",
    base_image: candidate.baseImage,
    dockerfile: candidate.dockerfile,
    signals: fakeSignals(),
    notes: [],
    degraded_risks: candidate.degradedRisks,
    build_commands: candidate.buildCommands,
    verify_commands: candidate.verifyCommands,
    image_digest: null,
    cache_key: null,
    parent_revision: null,
    health: {},
    health_reason: null,
    health_checked_at: null,
    health_log_key: null,
    created_at: new Date(0),
    ...rowOverrides,
  } satisfies EnvironmentRow;
}
