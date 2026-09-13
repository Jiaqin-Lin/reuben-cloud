/**
 * `environment/build.ts` —— 环境镜像的构建：docker build 调用、日志采集、错误分类（spec Phase 6 §2/§3）。
 *
 * 【这个文件在整条管线里的位置】它只管一件事：**把一份 Dockerfile 变成一个镜像，并如实报告
 * 发生了什么**。它不认识模型、不认识数据库、也不决定要不要重试——那些是 `queue.ts` 的事。
 * 这条边界让"构建"这一层可以在没有 PG、没有模型的情况下被完整测试（单测里把那三件事都换掉）。
 *
 * 【构建上下文里为什么只有 Dockerfile】设计文档 §C.7 的边界：构建是在 CP 宿主机上执行
 * **不可信内容**，而仓库内容（`.env`、私钥、用户代码）在环境构建期根本还没进沙箱。所以
 * `prepareBuildContext()` 造一个只含 Dockerfile 的临时目录，构建结束就删；生成的 Dockerfile
 * 里出现 COPY/ADD 一律在生成阶段被拒（`infer.ts` 的 `checkDockerfileConstraints`）。
 *
 * 【错误分类为什么值一个函数】自愈循环的收敛性全在这里：把 2000 行日志压成"一句可行动的
 * 诊断"，模型才可能改对。分类是**纯函数**（日志 → 分类 + 细节 + 建议），所以它的测试不需要
 * docker：`test/fixtures/build-logs/*.log` 是真日志样本，逐条断言分类结果。
 *
 * 【分类的优先级为什么不是表里的书写顺序】两条会同时出现的组合里，错的顺序会把模型带偏：
 *  apt 的 `update` 因 DNS 失败之后，`install` 必然跟着报 `E: Unable to locate package`——
 *  先报 network_timeout 是对的（包很可能存在，只是没查着）；报 apt_package_missing 会让模型
 *  换包名，越改越远。同理 syntax_error 必须最先判（解析都没过，日志里其余内容全是噪声）。
 *
 * 【日志为什么要边跑边写对象存储】一次失败构建的日志是自愈的唯一输入，也是事后唯一能解释
 * "这镜像为什么长这样"的证据。10 分钟的构建可能吐出几十 MB，先攒在内存里再上传是不可行的；
 * `BuildLogStore` 的契约就是"没有 content-length 也能流式写"。内存里另留一份**有上限**的
 * 尾部副本给分类与 prompt 用（见 `MAX_BUILD_LOG_CHARS`）。
 *
 * 【超时为什么要杀进程组】`docker build` 会拉起一串子进程（buildkit 前端、RUN 里的 shell）。
 * 只杀 CLI 会留下一堆孤儿在后台继续吃 CPU/网络；`detached: true` 让子进程自成进程组，
 * 然后 `kill(-pid)` 一次收掉整组。注意：杀的是**客户端**，daemon 侧在连接断开后会自己取消构建。
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { artifactStoreFromEnv } from "../artifacts/store.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { baseImageRef, ENV_BASE_KINDS } from "./base-images.ts";

// ---------------------------------------------------------------- 常量

/** 单轮构建的超时（spec：10 分钟）。**代码里的常量，不是运维约定**。 */
export const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** 读完 iidfile / 兜底 inspect 的短超时（这不是构建，只是取一个 ID）。 */
const DIGEST_READ_TIMEOUT_MS = 30 * 1000;

/** prompt 与分类要用日志的尾部；40 行是 spec §3 给 `unknown` 兜底定的口径。 */
export const LOG_TAIL_LINES = 40;

/** 内存里保留的日志上限（分类只读尾部；完整日志在对象存储里）。 */
export const MAX_BUILD_LOG_CHARS = 256 * 1024;

/** 日志在对象存储里的顶层前缀。**P7 的只读代理只允许这个前缀**，所以它是契约的一部分。 */
export const ENV_LOG_PREFIX = "env-logs";

/** 本地镜像 tag 的后缀（spec §2：`reuben-cloud/env-<project_key>-<revision>:build`）。 */
const ENV_IMAGE_SUFFIX = ":build";

/**
 * 传给 docker CLI 的环境变量白名单。
 *
 * 【为什么不是 `process.env`】spec P6 的技术边界：构建进程的 env 里**没有** GitHub token /
 * 模型 key。docker CLI 其实不会把客户端 env 塞进构建（构建参数只来自 `--build-arg`，而我们的
 * 白名单为空），但"构建进程里不存在凭据"是能检查、也能被审计的一句话——那就别让它们存在。
 *
 * 代理变量在名单里：构建要出网，而公司/CI 环境经常只能走代理；它们带的是**代理自己的**凭据，
 * 不是我们的模型 key / GitHub token（那两样在 CP 进程里，名下有 TOKEN / KEY 的都不在名单里）。
 */
const BUILD_PROCESS_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "LANG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/** 只有 `repo@sha256:<64 hex>` 与本地镜像 ID `sha256:<64 hex>` 是 provider 认的引用。 */
const DIGEST_RE = /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------- 端口

/** 一次构建请求。**只有 Dockerfile + 落点**：仓库内容、凭据都不在这里，也不该在这里。 */
export interface BuildRequest {
  /** Dockerfile 全文（就是本次尝试要构建的文本）。 */
  dockerfile: string;
  /** 镜像 tag（`envImageTag()` 生成）。 */
  tag: string;
  /** 日志落点（对象存储 key；`envBuildLogKey()` 生成）。 */
  logKey: string;
  /** 单轮超时。缺省 10 分钟（测试与 CLI 可以给更小的值）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 一次构建的结果。**失败是结果，不是异常**（build 返回 ok:false；抛异常只留给出基础设施错误）。 */
export interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  /** 超时被杀（分类为 build_timeout）。 */
  timedOut: boolean;
  /** 被 signal 取消（用户 / 上层放弃）。 */
  aborted: boolean;
  /** 合并后的日志**尾部**（`MAX_BUILD_LOG_CHARS` 上限内的完整尾部；分类与 prompt 用）。 */
  log: string;
  /** 日志在对象存储里的 key；写日志失败时是 null（构建照跑，只是少一份证据）。 */
  logKey: string | null;
  durationMs: number;
  /** 成功时的镜像 digest（`sha256:<64 hex>`）。 */
  imageDigest: string | null;
  /** spawn 层面的失败（可执行文件不在、权限不足）——不是"构建失败"，是"没能开始构建"。 */
  errorMessage: string | null;
}

/**
 * 构建器端口。真实现是 `DockerBuildRunner`；`test/environment-fakes.ts` 的假实现按脚本
 * 返回失败/成功，让自愈循环的每一条分支都能在没有 docker 的环境里被验证。
 */
export interface BuildRunner {
  readonly name: string;
  build(request: BuildRequest): Promise<BuildResult>;
}

/** 日志的落点。`S3ArtifactStore` 天然满足它（`put` 流式、`get` 流式）。 */
export interface BuildLogStore {
  /** 流式上传。返回上传过程中算出的字节数与 sha256（不需要 content-length）。 */
  put(objectKey: string, body: Readable): Promise<{ sizeBytes: number; sha256: string }>;
  get(objectKey: string): Promise<Readable>;
}

// ---------------------------------------------------------------- 错误分类

/** 从**日志**里读出来的分类（`classifyBuildFailure` 的返回值域）。 */
export const BUILD_LOG_CLASSES = [
  "unknown_base_image",
  "apt_package_missing",
  "npm_404",
  "pypi_404",
  "network_timeout",
  "build_context_error",
  "permission_denied",
  "syntax_error",
  "build_timeout",
  "unknown",
] as const;
export type BuildLogClass = (typeof BUILD_LOG_CLASSES)[number];

/**
 * `env_builds.error_class` 的完整取值域：日志分类 + 两个**生成阶段**的分类。
 *
 * 【为什么后两个也要在这里】对自愈循环来说"这一轮为什么没成"是同一类问题：
 * 模型给的文本违反了硬约束（`constraint_violation`，没进 build）、模型压根没给出代码块或
 * 调用失败（`generation_failed`）。它们进同一列，UI 与排障才只需要看一处。
 */
export const ENV_BUILD_ERROR_CLASSES = [
  ...BUILD_LOG_CLASSES,
  "constraint_violation",
  "generation_failed",
] as const;
export type EnvBuildErrorClass = (typeof ENV_BUILD_ERROR_CLASSES)[number];

/** 一次失败的结构化诊断：分类 + 从日志里抽出来的具体东西 + 喂回模型的那句话。 */
export interface BuildFailure {
  /**
   * 分类。**日志分类只会给出 `BUILD_LOG_CLASSES` 里的值**；`constraint_violation` 与
   * `generation_failed` 由自愈循环自己填（它们没进过构建）。三者共用一种形状，是因为
   * 对下一轮生成来说"上一轮为什么没成"是同一个问题。
   */
  klass: EnvBuildErrorClass;
  /** 包名 / 行号 / 镜像名 / 域名——能抽出来就抽，抽不出来是 null。 */
  detail: string | null;
  /** 一句可行动的建议（进 prompt，也进 UI 的失败说明）。 */
  advice: string;
}

interface ClassRule {
  klass: BuildLogClass;
  /** 命中即用（顺序 = 优先级，见文件头）。 */
  pattern: RegExp;
  /** 从日志里抽"那个具体的东西"。 */
  detail?: (log: string, match: RegExpExecArray) => string | null;
  advice: (detail: string | null) => string;
}

/** Layer 1 的可选清单（`unknown_base_image` 的建议里要写出来）。 */
function layerOneList(): string {
  return ENV_BASE_KINDS.map((kind) => baseImageRef(kind)).join(", ");
}

/**
 * 分类表。**顺序就是优先级**（见文件头的两条理由）。
 *
 * 每条规则的 pattern 都对着真实日志样本（`test/fixtures/build-logs/`）写过一遍：
 * 样本里同时含新老两代 docker 的措辞（`pull access denied` / `manifest unknown`、
 * `COPY failed` / `failed to compute cache key`），因为 CI 与本地可能不是同一代。
 */
const CLASS_RULES: readonly ClassRule[] = [
  {
    klass: "syntax_error",
    pattern: /dockerfile parse error on line (\d+)|unknown instruction:\s*(\S+)/i,
    detail: (_log, match) => (match[1] !== undefined ? `第 ${match[1]} 行` : (match[2] ?? null)),
    advice: (detail) => `${detail ?? "Dockerfile"} 语法错（docker 在解析阶段就拒绝了）：按报错改那一行`,
  },
  {
    klass: "unknown_base_image",
    pattern:
      /pull access denied|manifest unknown|repository does not exist or may require authorization|failed to resolve source metadata|not found: manifest/i,
    detail: (log) =>
      /load metadata for (\S+)/i.exec(log)?.[1] ??
      /failed to resolve source metadata for (\S+)/i.exec(log)?.[1] ??
      null,
    advice: (detail) =>
      `基础镜像不存在${detail === null ? "" : `（${detail}）`}：FROM 只能从 Layer 1 矩阵里选——${layerOneList()}`,
  },
  {
    klass: "build_context_error",
    pattern: /COPY failed|not found in build context|failed to compute cache key|failed to calculate checksum/i,
    detail: (log) => /"?(\/[^"\s:]+)"?: not found/i.exec(log)?.[1] ?? null,
    advice: (detail) =>
      `不要 COPY/ADD 仓库内容${detail === null ? "" : `（找不到 ${detail}）`}：构建上下文里只有 Dockerfile，仓库内容不在那里`,
  },
  {
    klass: "npm_404",
    pattern: /404 Not Found - GET https:\/\/registry\.npmjs\.org|npm error code E404|is not in this registry/i,
    detail: (log) =>
      /registry\.npmjs\.org\/([^\s]+)/.exec(log)?.[1] ??
      /'([^']+)' is not in this registry/i.exec(log)?.[1] ??
      null,
    advice: (detail) => `npm registry 里没有这个包/版本${detail === null ? "" : `（${detail}）`}：换一个，或者去掉它`,
  },
  {
    klass: "pypi_404",
    pattern: /No matching distribution found|Could not find a version that satisfies the requirement|404 Client Error: Not Found.*pypi/i,
    detail: (log) =>
      /(?:No matching distribution found for|Could not find a version that satisfies the requirement)\s+([^\s(]+)/i.exec(log)?.[1] ??
      /pypi\.org\/(?:simple|project)\/([^/\s]+)/i.exec(log)?.[1] ??
      null,
    advice: (detail) => `PyPI 里没有这个包/版本${detail === null ? "" : `（${detail}）`}：换一个，或者去掉它`,
  },
  {
    klass: "network_timeout",
    pattern:
      /Temporary failure resolving|i\/o timeout|Could not resolve host|Connection timed out|TLS handshake timeout|network is unreachable|dial tcp [^\s]*: connect: connection refused/i,
    detail: (log) =>
      /Temporary failure resolving '([^']+)'/i.exec(log)?.[1] ??
      /Could not resolve host:?\s*(\S+)/i.exec(log)?.[1] ??
      null,
    advice: (detail) =>
      `网络问题（DNS / 超时${detail === null ? "" : `：${detail}`}）：重试一次可能有效——这一类最多重试 1 次`,
  },
  {
    klass: "apt_package_missing",
    pattern: /E: Unable to locate package\s+(\S+)/,
    detail: (_log, match) => match[1] ?? null,
    advice: (detail) => `这个包在基础镜像的发行版里不存在${detail === null ? "" : `（${detail}）`}：换成存在的包名或换一种装法`,
  },
  {
    klass: "permission_denied",
    pattern: /permission denied|EACCES|Operation not permitted/i,
    detail: (log) => {
      const line = /^.*(?:permission denied|EACCES|Operation not permitted).*$/im.exec(log)?.[0] ?? null;
      return line === null ? null : line.trim().slice(0, 160);
    },
    advice: (detail) =>
      `权限不足${detail === null ? "" : `（${detail}）`}：需要 root 的步骤要写 USER root，并在装完立刻 USER 1000:1000`,
  },
];

/** `unknown` 的兜底细节：日志里最后一行非空内容（整段 40 行在 prompt 的 log tail 里）。 */
function lastMeaningfulLine(log: string): string | null {
  const lines = log.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line !== "") return line.slice(0, 200);
  }
  return null;
}

/**
 * 分类一次失败：超时 / 被取消优先（它们不是日志内容能表达的状态），然后按 `CLASS_RULES`
 * 的顺序找第一条命中的规则。
 */
export function classifyBuildFailure(input: {
  log: string;
  timedOut?: boolean;
  aborted?: boolean;
}): BuildFailure {
  if (input.timedOut === true) {
    return {
      klass: "build_timeout",
      detail: null,
      advice: `构建超过 ${Math.round(DEFAULT_BUILD_TIMEOUT_MS / 60_000)} 分钟被杀：少装一点东西，或者换更小的镜像`,
    };
  }
  if (input.aborted === true) {
    return { klass: "unknown", detail: null, advice: "构建被取消（不是构建本身失败）" };
  }
  for (const rule of CLASS_RULES) {
    const match = rule.pattern.exec(input.log);
    if (match === null) continue;
    const detail = rule.detail?.(input.log, match) ?? null;
    return { klass: rule.klass, detail, advice: rule.advice(detail) };
  }
  return {
    klass: "unknown",
    detail: lastMeaningfulLine(input.log),
    advice: "没能归类：按 Dockerfile 与日志尾部自己判断",
  };
}

/**
 * 日志尾部 n 行（默认 40：spec 给 unknown 定的口径，也是喂回模型的量）。
 * 空行从**头部**裁掉（日志末尾的空行没有信息量，占的是 prompt 的位置）。
 */
export function logTail(log: string, lines: number = LOG_TAIL_LINES): string {
  const all = log.replace(/\s+$/, "").split("\n");
  return all.slice(-lines).join("\n");
}

// ---------------------------------------------------------------- 命名

/** tag 里不能有 `/`：`owner/name` → `owner__name`（可逆地表达分隔，而不是静默丢掉）。 */
function slugifyProjectKey(projectKey: string): string {
  const slug = projectKey
    .split("/")
    .flatMap((segment) => segment.split(/[^A-Za-z0-9._-]+/))
    .filter((segment) => segment !== "")
    .join("__");
  return slug === "" ? "unknown" : slug;
}

/** `reuben-cloud/env-<slug>-r<revision>:build`（spec §2 的 tag 形状，project_key 已 slug 化）。 */
export function envImageTag(projectKey: string, revision: number): string {
  return `reuben-cloud/env-${slugifyProjectKey(projectKey)}-r${revision}${ENV_IMAGE_SUFFIX}`;
}

/**
 * 日志的对象 key：`env-logs/<owner>/<name>/<revision>/<build_id>.log`。
 *
 * 【为什么每段都过一遍 slug】它不仅进 S3，也进文件系统（没有对象存储时的退路）。
 * 一个 `../` 就能让文件实现写到根目录外面去——路径拼接里没有"反正不会有人这么传"。
 */
export function envBuildLogKey(projectKey: string, revision: number, buildId: string): string {
  return [ENV_LOG_PREFIX, slugifyProjectKey(projectKey), String(revision), `${buildId}.log`].join("/");
}

// ---------------------------------------------------------------- 构建上下文

/**
 * 造构建上下文：一个**只含 Dockerfile** 的临时目录（spec 测试要点 8）。
 *
 * 调用方负责删（`DockerBuildRunner` 在 finally 里删）。文件名固定 `Dockerfile`：
 * `docker build -f` 显式指到它，不依赖目录里还有别的东西。
 */
export async function prepareBuildContext(dockerfile: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-env-ctx-"));
  await writeFile(path.join(dir, "Dockerfile"), dockerfile, "utf8");
  return dir;
}

// ---------------------------------------------------------------- 进程

export interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  spawnError: Error | null;
}

/**
 * 跑一条子进程，带超时与取消。**每读到一段就回调**（stdout/stderr 合并）。
 *
 * 导出是为了让"超时真的会杀掉整个进程组"这一条能在单测里验证（把 `docker` 换成一个
 * sleep 脚本就行）——那个行为用真 docker 测要 10 分钟，用假命令测只要毫秒。
 */
export function runProcess(
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  },
): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: Error | null = null;

    // 已经取消的请求不该再起进程（信号可能在调用之前就 abort 了）。
    if (options.signal?.aborted === true) {
      resolve({ code: null, signal: null, timedOut: false, aborted: true, durationMs: 0, spawnError: null });
      return;
    }

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      // detached：子进程自成进程组，超时时能一次收掉它拉起的整串进程（见文件头）。
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程已经没了：什么都不用做。
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, timedOut, aborted, durationMs: Date.now() - startedAt, spawnError });
    };

    child.stdout?.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8")));
    child.on("error", (error: Error) => {
      spawnError = error;
      killGroup();
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** 构建进程的 env：白名单（见 `BUILD_PROCESS_ENV_KEYS`）。 */
export function buildProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of BUILD_PROCESS_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------- 内存日志尾部

/** 内存里的日志副本：超过 `MAX_BUILD_LOG_CHARS` 只留尾部，并从行边界开始（分类要能正则匹配）。 */
class LogTailBuffer {
  #text = "";

  push(chunk: string): void {
    this.#text += chunk;
    const overflow = this.#text.length - MAX_BUILD_LOG_CHARS;
    if (overflow <= 0) return;
    const tail = this.#text.slice(overflow);
    const newline = tail.indexOf("\n");
    // 只去掉被截断的那半行；一整段没有换行时（超长单行）原样留着。
    this.#text = newline === -1 ? tail : tail.slice(newline + 1);
  }

  get text(): string {
    return this.#text;
  }
}

/**
 * 打开日志落点：把 docker 的输出边写边传。
 *
 * 【上传失败为什么不让构建失败】日志是证据，不是产物。MinIO 抖动时"构建成功但没日志"
 * 远好过"因为日志传不上去而丢掉一次成功的构建"；失败会记一条 warn 并把 log_key 置空。
 * 上传失败后 `write` 直接丢弃后续数据——否则一个没人读的流会把整个构建日志攒在内存里。
 */
function openLogSink(
  store: BuildLogStore | null,
  objectKey: string,
  log: LogFn,
): { write: (chunk: string) => void; finish: () => Promise<string | null> } {
  if (store === null) return { write: () => undefined, finish: async () => null };
  const stream = new PassThrough();
  // 流的 error 必须有人接：没人接的 error 会把进程带走（与 store 的 put 失败是两回事）。
  stream.on("error", () => undefined);
  let failure: string | null = null;
  const done = store
    .put(objectKey, stream)
    .then(() => undefined)
    .catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
    });
  return {
    write(chunk: string): void {
      if (failure !== null || stream.destroyed) return;
      stream.write(chunk);
    },
    async finish(): Promise<string | null> {
      stream.end();
      await done;
      if (failure === null) return objectKey;
      log("warn", "环境构建日志上传失败（构建结果不受影响）", { objectKey, error: failure });
      return null;
    },
  };
}

// ---------------------------------------------------------------- 真构建器

export interface DockerBuildRunnerOptions {
  /** docker 可执行文件。单测换成一个假脚本（超时与杀进程组就是这么测的）。 */
  docker?: string;
  /** 日志落点。不给 = 日志只在内存里留尾部（没有对象存储的部署形态）。 */
  logStore?: BuildLogStore | null;
  log?: LogFn;
}

/** 生产路径的构建器：`docker build` + 日志 + 超时 + digest。 */
export class DockerBuildRunner implements BuildRunner {
  readonly name = "docker";
  readonly #docker: string;
  readonly #logs: BuildLogStore | null;
  readonly #log: LogFn;

  constructor(options: DockerBuildRunnerOptions = {}) {
    this.#docker = options.docker ?? "docker";
    this.#logs = options.logStore ?? null;
    this.#log = options.log ?? noopLog;
  }

  async build(request: BuildRequest): Promise<BuildResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const contextDir = await prepareBuildContext(request.dockerfile);
    // iidfile 不能放在上下文目录里：那个目录必须**只含 Dockerfile**（测试要点 8）。
    const iidDir = await mkdtemp(path.join(os.tmpdir(), "rc-env-iid-"));
    const iidFile = path.join(iidDir, "iid");
    const tail = new LogTailBuffer();
    const sink = openLogSink(this.#logs, request.logKey, this.#log);

    try {
      const outcome = await runProcess(
        [this.#docker, "build", "--progress=plain", "--iidfile", iidFile, "-f", path.join(contextDir, "Dockerfile"), "-t", request.tag, contextDir],
        {
          env: buildProcessEnv(),
          timeoutMs,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          onOutput: (chunk) => {
            tail.push(chunk);
            sink.write(chunk);
          },
        },
      );
      const logKey = await sink.finish();
      const ok = outcome.code === 0 && !outcome.timedOut && !outcome.aborted && outcome.spawnError === null;
      const imageDigest = ok ? await this.#readDigest(iidFile, request.tag) : null;
      if (!ok) {
        this.#log("info", "环境镜像构建失败", {
          tag: request.tag,
          exitCode: outcome.code,
          timedOut: outcome.timedOut,
          durationMs: outcome.durationMs,
        });
      }
      return {
        ok,
        exitCode: outcome.code,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        log: tail.text,
        logKey,
        durationMs: outcome.durationMs,
        imageDigest,
        errorMessage: outcome.spawnError?.message ?? null,
      };
    } finally {
      await rm(contextDir, { recursive: true, force: true });
      await rm(iidDir, { recursive: true, force: true });
    }
  }

  /** 先读 `--iidfile`，读不到再问 `docker image inspect`（`--progress=auto` 时的老路）。 */
  async #readDigest(iidFile: string, tag: string): Promise<string | null> {
    try {
      const text = (await readFile(iidFile, "utf8")).trim();
      if (DIGEST_RE.test(text)) return text;
    } catch {
      // 文件不在（老 docker / 构建输出被截）：走下面的兜底。
    }
    let stdout = "";
    const outcome = await runProcess([this.#docker, "image", "inspect", "--format", "{{.Id}}", tag], {
      env: buildProcessEnv(),
      timeoutMs: DIGEST_READ_TIMEOUT_MS,
      onOutput: (chunk) => {
        stdout += chunk;
      },
    });
    const id = stdout.trim();
    return outcome.code === 0 && DIGEST_RE.test(id) ? id : null;
  }
}

// ---------------------------------------------------------------- 日志落点：本地文件

/**
 * 本地文件实现：没有对象存储时的退路（开发、单测、`env:build` 裸跑）。
 *
 * 【为什么不是"没 S3 就没有日志"】验收标准里有一条"构建日志可取回并人类可读"。
 * 本地形态下它的等价物就是磁盘上的一个文件——P7 的只读代理只管 S3，但排障的人
 * （和集成测试）用 `get()` 读到的是同一份字节。
 */
export class FileBuildLogStore implements BuildLogStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** 日志根目录（CLI 要把"日志在哪"告诉人，而不是只打印一个 key）。 */
  get root(): string {
    return this.#root;
  }

  async put(objectKey: string, body: Readable): Promise<{ sizeBytes: number; sha256: string }> {
    const file = this.#resolve(objectKey);
    await mkdir(path.dirname(file), { recursive: true });
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new PassThrough();
    meter.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });
    await pipeline(body, meter, createWriteStream(file));
    return { sizeBytes, sha256: hash.digest("hex") };
  }

  get(objectKey: string): Promise<Readable> {
    return Promise.resolve(createReadStream(this.#resolve(objectKey)));
  }

  /** key → 文件路径。**越界的 key 直接抛**：它是路径拼接，不能有"反正不会这么传"。 */
  #resolve(objectKey: string): string {
    const file = path.resolve(this.#root, objectKey);
    if (file !== this.#root && !file.startsWith(`${this.#root}${path.sep}`)) {
      throw new Error(`日志 key 越出了日志根目录：${objectKey}`);
    }
    return file;
  }
}

/** 日志目录的缺省位置（`REUBEN_CLOUD_ENV_LOG_DIR` 可覆盖）。 */
export function envBuildLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["REUBEN_CLOUD_ENV_LOG_DIR"];
  if (override !== undefined && override !== "") return override;
  return path.join(os.tmpdir(), "reuben-cloud-env-logs");
}

/**
 * 生产与 CLI 的日志落点：配了对象存储就用它，否则落本地文件。
 *
 * 【为什么两条都留着】对象存储是**部署形态**（归档、UI 回看），本地文件是**开发形态**。
 * 让"没配 S3 就不能构建环境"成为事实，只会让人在本地把四个 S3 变量编出来。
 */
export function envBuildLogStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BuildLogStore {
  return artifactStoreFromEnv(env) ?? new FileBuildLogStore(envBuildLogDir(env));
}
