/**
 * `environment/health.ts` —— 环境体检：在用该镜像起的一次性沙箱里跑 smoke test，
 * 把"这个环境能不能用"变成一个显式状态（spec Phase 7 §3；设计文档 §C.6）。
 *
 * 【为什么必须在沙箱里、用一次性沙箱】宿主上根本没有目标环境（没有那个 node / python，
 * 更没有从镜像里继承的 uid 与环境变量）；而体检要跑 `npm ci` / `go build` 这类**会写文件、会
 * 出网、会执行仓库里的脚本**的命令，它不能落在 CP 的进程里。跑完即销毁：体检的产物只有
 * 一份报告，沙箱本身没有第二个用途。
 *
 * 【为什么先灌仓库再体检】"依赖装上了、构建命令跑通了"这件事只能对着仓库内容做判断
 * （镜像是 P6 从信号里生成的，它只装系统依赖，不装项目依赖）。所以体检沙箱 = 环境镜像 +
 * 仓库，而灌仓库这一步在 `health-sandbox.ts`（端口实现）里，这里只认三个动作：
 * open / exec / destroy。
 *
 * 【三态怎么判（设计文档 §C.6 的表）】
 *   ready    ：构建命令（`buildCommands`，全部 required）退出码 0，且没有命中任何降级风险；
 *   degraded ：上面的都成立，但命中一条降级风险（compose 里的服务不在、浏览器缺失……）
 *              或某个**可选**检查（compileall / go build / cargo check）失败；
 *   failed   ：某条 required 命令失败或超时 —— "装不上依赖"是合法结果，比让 Run 到中途
 *              才发现装不上好得多。
 *
 * 【为什么 degraded 也要跑完所有 required 步】degraded 的定义是"能用，只是缺一块能力"。
 * 提前退出会让"到底缺哪一块"这件事只能靠猜；代价是多跑几条命令（都是秒级）。
 *
 * 【为什么 facts 是结构化的】设计文档 §C.6 的原话：`{reason, affected:["integration_tests"], detail}`。
 * ContextCompiler（P10）把它当沙箱事实写进 system，agent 据此跳过集成测试；UI 按 affected
 * 分组显示。压成一句人话之后，这两处都要自己解析文本。
 *
 * 【这里不认识 docker / 不认识 manager】与 `queue.ts` 同一条规矩：真动作（建沙箱 / 灌仓库 /
 * exec）在端口后面（`health-sandbox.ts`），所以"三态判定"这些**行为**可以在没有 docker 的
 * 单测里逐条验证（三个假沙箱 → 三个状态）。
 */

import { Readable } from "node:stream";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { BuildLogStore } from "./build.ts";
import { logTail } from "./build.ts";
import type { EnvironmentCandidate, RepoSignals } from "./types.ts";

// ---------------------------------------------------------------- 类型

/** 体检结论。与 `environments.status` 的 `ready | degraded | failed` 是同一套取值。 */
export const HEALTH_STATUSES = ["ready", "degraded", "failed"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/**
 * 一条结构化事实。**reason 是机器读的、detail 是人读的、affected 是给 agent 的行动范围**
 * （例如 degraded 的 compose 服务 → affected=["integration_tests"]，agent 就不该去跑集成测试）。
 */
export interface SandboxFact {
  reason: string;
  affected: string[];
  detail: string;
}

/** 一步的体检结果。`outputTail` 只留尾部（人在 UI 上看的是这一份；完整日志在 logKey）。 */
export interface HealthStepResult {
  cmd: string;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

/** 一次体检的结论（`environments.health` 列就是它的 JSON）。 */
export interface HealthReport {
  status: HealthStatus;
  /** 一句话原因（failed / degraded 才有值）；`environments.health_reason` 存它。 */
  reason: string | null;
  /** 人话细节（失败的那条命令 + 日志尾部）。 */
  detail: string | null;
  facts: SandboxFact[];
  steps: HealthStepResult[];
  /** 体检日志的对象 key（落点失败时为 null，与构建日志同一条规矩）。 */
  logKey: string | null;
  /** ISO 时刻。**只进 DB / UI，不进 system**（提示词里不许有时间戳，见 `prompt/system.ts`）。 */
  checkedAt: string;
}

/** 一步的**计划**（还没跑）。`purpose` 是给 UI 与日志解释"为什么要跑它"。 */
export interface HealthStepPlan {
  cmd: string;
  required: boolean;
  purpose: string;
}

export interface HealthPlan {
  steps: HealthStepPlan[];
  /** 体检开始前就已经知道的降级风险（构建命令全过时，它们把结论压到 degraded）。 */
  facts: SandboxFact[];
}

// ---------------------------------------------------------------- 计划（纯函数）

/** 体检单步超时。**代码里的常量**：一个 smoke test 不该比一次构建还久。 */
export const DEFAULT_HEALTH_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** 体检日志的尾部行数（与构建日志同一个口径：40 行）。 */
export const HEALTH_LOG_TAIL_LINES = 40;

/**
 * 按语言选"轻量校验"那一步（设计文档 §C.6 的表）。
 *
 * 【为什么与 `buildCommands` 分开】`buildCommands` 是**必过**的（依赖装上了）；这几条是
 * "装完之后还能不能过一遍编译器"——它们失败意味着环境能用但不可信（例如 cgo/系统库缺失），
 * 那正是 degraded 的第二种来源。跑真测试（`verifyCommands` 里的 `npm test`）不行：它可能
 * 要几分钟、要数据库，甚至本来就是这个环境要服务的目标（设计文档只说 health 是 smoke test）。
 */
export function lightCheckFor(kind: string): string | null {
  switch (kind) {
    case "python-dev":
    case "fullstack":
      return "python3 -m compileall -q .";
    case "go-dev":
      return "go build ./...";
    case "rust-dev":
      return "cargo check";
    default:
      // node-dev / ubuntu-dev：node 的语法检查没有"一键"形态（`node --check` 只吃单文件），
      // ubuntu-dev 里没有语言工具链——两者都只靠 `buildCommands`。
      return null;
  }
}

/**
 * 把一条降级风险（`candidate.degradedRisks` 里的人话）归到一个受影响的动作上。
 *
 * 【为什么用关键词而不是结构化】风险文本是 P5 的推断层产出的（那里没有受影响的动作这个概念），
 * 而 M2 只有两类真实的受影响能力：集成测试（要服务）与 e2e（要浏览器）。认不出来就归到
 * `integration_tests`——它是 M2 里最常被 degraded 卡住的那一项，也是 agent 最该跳过的那一项。
 */
function affectedOf(risk: string): string[] {
  return /浏览器|playwright|puppeteer|e2e/i.test(risk) ? ["e2e"] : ["integration_tests"];
}

/**
 * 生成体检计划：先跑 `buildCommands`（required），再跑一条按语言的轻量检查（optional）。
 *
 * 【为什么 required 那批直接取 `buildCommands`】它是 P5 从仓库事实里推出来的"这个仓库怎么装
 * 依赖、怎么构建"（`npm ci` / `poetry install` / `go mod download` + `make build`……），
 * 与设计文档 §C.6 表里那一列是同一件事的两个来源——这里再写一张表就会有两份"怎么装依赖"。
 */
export function healthPlanFor(input: {
  candidate: EnvironmentCandidate;
  signals: RepoSignals;
}): HealthPlan {
  const steps: HealthStepPlan[] = input.candidate.buildCommands.map((cmd) => ({
    cmd,
    required: true,
    purpose: "依赖安装 / 构建（环境能不能用的判据）",
  }));
  const light = lightCheckFor(input.candidate.baseImageKind);
  if (light !== null && !steps.some((step) => step.cmd === light)) {
    steps.push({ cmd: light, required: false, purpose: "轻量校验（失败只降级，不判死）" });
  }
  if (steps.length === 0) {
    // 什么信号都没有的仓库（或"其他语言"）：只验镜像能起。设计文档 §C.6 的表格末行就是这个。
    steps.push({ cmd: "true", required: true, purpose: "只验镜像能起（没有可推断的安装 / 构建命令）" });
  }
  const facts: SandboxFact[] = input.candidate.degradedRisks.map((risk) => ({
    reason: "declared_risk",
    affected: affectedOf(risk),
    detail: risk,
  }));
  // 【为什么还要看 signals.services】`degradedRisks` 是推断层的产出（P5 会把服务依赖写进去），
  // 但环境行的候选也可能来自 promote 或人工给定的那一份——服务清单是**仓库事实**，
  // 它不该因为候选是别处来的就消失。已经在里面提到的服务不重复记一条。
  for (const service of input.signals.services) {
    if (facts.some((fact) => fact.detail.includes(service))) continue;
    facts.push({
      reason: "compose_service_unavailable",
      affected: ["integration_tests"],
      detail: `${service}：compose 里声明了它，而一次性沙箱里没有服务（M2 不跑 compose）——依赖它的集成测试不可用`,
    });
  }
  return { steps, facts };
}

// ---------------------------------------------------------------- 端口

/**
 * 体检端口（P7）。生产实现把"用这个镜像起一次性沙箱 → 灌仓库 → 跑命令"三步藏在这里；
 * 单测与集成测试各给一个替身（一个按脚本给三态，一个真跑）。
 */
export interface EnvironmentHealthChecker {
  check(input: {
    projectKey: string;
    revision: number;
    /** 刚构建出来的镜像 digest（一定是 digest：体检沙箱直接用 `SandboxSpec.image`）。 */
    image: string;
    candidate: EnvironmentCandidate;
    signals: RepoSignals;
  }): Promise<HealthReport>;
}

export interface HealthSandboxHandle {
  sandboxId: string;
  endpoint: string;
  authToken: string;
}

export interface HealthExecInput {
  sandboxId: string;
  endpoint: string;
  authToken: string;
  cmd: string[];
  cwd: string;
  timeoutMs: number;
}

export interface HealthExecResult {
  exitCode: number | null;
  timedOut: boolean;
  /** 合并后的输出尾部（`HEALTH_LOG_TAIL_LINES` 行以内）。 */
  output: string;
  durationMs: number;
}

/**
 * 一次性沙箱的出口。生产实现 = `health-sandbox.ts`（manager 建沙箱 + clone/inject + exec）；
 * 单测的替身按脚本返回三态。**三个方法都必须是"失败是结果"的形态**：open 抛异常表示
 * "连沙箱都没起来"（那也是一条合法的失败结论，见 `runHealthCheck`）。
 */
export interface HealthSandboxPort {
  /** 用这个镜像起沙箱并把仓库灌进去。`runId` 用于 sandboxes 表归属与看门狗。 */
  open(input: { image: string; runId: string }): Promise<HealthSandboxHandle>;
  exec(input: HealthExecInput): Promise<HealthExecResult>;
  /** **幂等**销毁（含归档）。体检沙箱没有产出，失败只记 warn。 */
  destroy(sandboxId: string, reason: string): Promise<void>;
}

// ---------------------------------------------------------------- 体检

export interface RunHealthCheckInput {
  image: string;
  /** 沙箱的归属（sandboxes 表要一个 run id；体检没有 Run，用 `envhealth_<ulid>` 之类）。 */
  runId: string;
  repoDir: string;
  plan: HealthPlan;
  sandbox: HealthSandboxPort;
  /** 日志落点（与构建日志同一个端口）。不给 = 报告里只有输出尾部。 */
  logs?: BuildLogStore | null;
  logKey: string;
  /** 单步超时。缺省 10 分钟（测试会调小）。 */
  timeoutMs?: number;
  now?: () => Date;
  log?: LogFn;
}

/**
 * 跑一次体检。**不抛异常**：连不上沙箱、命令超时、日志传不上去都是一种结论或一条 warn。
 *
 * 调用方（队列 / CLI / 页面）拿到报告之后只做一件事：把结论落到环境行上
 * （`store.setEnvironmentHealth` → 同时推进 status）。
 */
export async function runHealthCheck(input: RunHealthCheckInput): Promise<HealthReport> {
  const log = input.log ?? noopLog;
  const timeoutMs = input.timeoutMs ?? DEFAULT_HEALTH_STEP_TIMEOUT_MS;
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  const sink = openHealthLog(input.logs ?? null, input.logKey, log);
  const steps: HealthStepResult[] = [];

  let handle: HealthSandboxHandle | null = null;
  let status: HealthStatus = "ready";
  let reason: string | null = null;
  let detail: string | null = null;
  const facts: SandboxFact[] = [...input.plan.facts];

  try {
    sink.write(`# 环境体检 ${input.image}\n# 步骤：${input.plan.steps.map((step) => step.cmd).join(" → ")}\n`);
    try {
      handle = await input.sandbox.open({ image: input.image, runId: input.runId });
    } catch (error) {
      // 沙箱都起不来 = 这个镜像用不了。不抛：结论就是 failed（这就是"失败是结果"）。
      status = "failed";
      reason = "sandbox_unavailable";
      detail = error instanceof Error ? error.message : String(error);
      sink.write(`# 沙箱起不来：${detail}\n`);
      log("error", "环境体检的沙箱起不来", { image: input.image, error: detail });
      return { status, reason, detail, facts, steps, logKey: await sink.finish(), checkedAt };
    }

    for (const step of input.plan.steps) {
      const result = await input.sandbox.exec({
        sandboxId: handle.sandboxId,
        endpoint: handle.endpoint,
        authToken: handle.authToken,
        cmd: ["bash", "-lc", step.cmd],
        cwd: input.repoDir,
        timeoutMs,
      });
      const ok = result.exitCode === 0 && !result.timedOut;
      steps.push({
        cmd: step.cmd,
        required: step.required,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTail: logTail(result.output, HEALTH_LOG_TAIL_LINES),
      });
      sink.write(`\n# ---- ${ok ? "ok" : "fail"} · ${step.cmd}（${Math.round(result.durationMs / 1000)}s）\n`);
      sink.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);

      if (!ok && step.required) {
        // 第一条 required 失败就是结论：后面的步骤大概率只是这条的连带错误（att 的 update 挂了，
        // install 必然跟着报错），继续跑只会把真正的原因埋进一屏噪声里。
        status = "failed";
        reason = result.timedOut ? "step_timeout" : "step_failed";
        detail = `\`${step.cmd}\` ${result.timedOut ? `超过 ${Math.round(timeoutMs / 1000)} 秒被杀` : `退出码 ${result.exitCode}`}：${logTail(result.output, 5)}`;
        log("warn", "环境体检失败", { image: input.image, cmd: step.cmd, exitCode: result.exitCode });
        break;
      }
      if (!ok) {
        facts.push({
          reason: "optional_step_failed",
          affected: ["verification"],
          detail: `可选检查 \`${step.cmd}\` 失败（退出码 ${result.exitCode}）：环境能用，但验证类的命令不保证可信`,
        });
      }
    }

    if (status !== "failed" && facts.length > 0) {
      status = "degraded";
      reason = facts[0]!.reason;
      detail = facts.map((fact) => fact.detail).join("；");
    }
    if (status === "ready") {
      log("info", "环境体检通过（ready）", { image: input.image, steps: steps.length });
    } else if (status === "degraded") {
      log("info", "环境体检降级（degraded）", { image: input.image, reason, facts: facts.length });
    }
  } finally {
    if (handle !== null) {
      // 一次性沙箱：**无论如何**都销毁。体检报告已经拿到，留着它只是占资源。
      await input.sandbox
        .destroy(handle.sandboxId, "env_health_checked")
        .catch((error: unknown) =>
          log("warn", "体检沙箱销毁失败（留给 sweeper）", {
            sandboxId: handle!.sandboxId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
    if (status !== "failed") sink.write(`\n# 结论：${status}${detail === null ? "" : ` —— ${detail}`}\n`);
  }

  return { status, reason, detail, facts, steps, logKey: await sink.finish(), checkedAt };
}

// ---------------------------------------------------------------- 读取落库的报告

/**
 * 从 DB（jsonb）/ 内存里读回一份体检报告。没体检过时那一列是 `{}`（008 迁移的默认值）。
 *
 * 【为什么要一个读取器】`environments.health` 的静态类型是“报告或空对象”，而调用方（Run 侧的
 * 解析、UI）只想要“有没有报告”这一个二元事实。判据用 `status` 是不是那三个取值之一——
 * 比检每个字段存在更廉价，也不可能误判（写进去的就是这个形状）。
 */
export function readStoredHealth(value: unknown): HealthReport | null {
  if (value === null || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  return (HEALTH_STATUSES as readonly unknown[]).includes(status) ? (value as HealthReport) : null;
}

// ---------------------------------------------------------------- 事实 → system 一行

/**
 * 把结构化事实拼成 system 里的那一行。**确定性**（顺序即 facts 的顺序）：
 * 它进的是缓存前缀（`prompt/system.ts`），同样的输入必须逐字节相同。
 */
export function healthFactLine(facts: readonly SandboxFact[]): string | null {
  if (facts.length === 0) return null;
  const items = facts.map((fact) => `${fact.detail}（影响：${fact.affected.join("/")}）`);
  return `环境事实：${items.join("；")}。`;
}

// ---------------------------------------------------------------- 日志落点

/** 与 `build.ts` 的 `openLogSink` 同一个契约，只是内容是我们自己写的文本。 */
function openHealthLog(
  store: BuildLogStore | null,
  objectKey: string,
  log: LogFn,
): { write: (chunk: string) => void; finish: () => Promise<string | null> } {
  if (store === null) return { write: () => undefined, finish: async () => null };
  const chunks: string[] = [];
  let failure: string | null = null;
  return {
    write(chunk: string): void {
      chunks.push(chunk);
    },
    async finish(): Promise<string | null> {
      if (failure !== null) return null;
      try {
        await store.put(objectKey, readableOf(chunks.join("")));
        return objectKey;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        log("warn", "环境体检日志上传失败（体检结论不受影响）", { objectKey, error: failure });
        return null;
      }
    },
  };
}

function readableOf(text: string): Readable {
  return Readable.from([Buffer.from(text, "utf8")]);
}
