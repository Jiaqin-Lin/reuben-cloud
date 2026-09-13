/**
 * git 调用层：`clone` / `checkout` / `apply` / `commit` / `push` / `diff` 的唯一出口。
 *
 * 【为什么要有这一层】§J 的红线是"沙箱内零 GitHub 凭据"，而实现这句话的关键是
 * "token 只以一种方式进入 argv"：`-c http.extraHeader=Authorization: Basic …`。
 * 如果 clone / push 各写一遍参数拼装，就一定会出现第二种写法——而最容易滑进去的
 * 那一种（`https://x-access-token:TOKEN@github.com/…`）会把凭据写进 `.git/config`，
 * 再跟着 tar 进沙箱。所以三件事都只在这个文件里发生：
 *   1. token → argv（`tokenAuthArgs`）
 *   2. argv 的打码（`redactArgs`；错误信息与日志里的 `http.extraHeader` 永远是遮蔽的）
 *   3. "URL 不许带 userinfo"的检查（`assertNoUserInfo`）
 *
 * 【为什么每个命令都显式带一串 `-c`】patch 的忠实度校验比较的是"沙箱里的 `git diff`"
 * 与"CP 里的 `git diff`"两份**字节**。diff 的输出受宿主/仓库配置影响（autocrlf、
 * 前缀、rename 检测、上下文行数…），而沙箱里是一个没有 HOME、没有全局配置的干净环境。
 * 把这几项在 CP 侧钉死成 git 的默认值，两边才是在比同一个东西。
 * （`.gitattributes` 是仓库内容，两边天然一致，不需要也不应该钉。）
 *
 * 【为什么不用 shell】与沙箱侧同一条规矩：argv 数组直接 spawn，不做字符串拼接。
 * `args` 里出现的一切（commit、路径、分支名）都只可能是一个参数，不可能变成一条命令。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { RepoError } from "./types.ts";
import type { RepoErrorReason } from "./types.ts";

// ---------------------------------------------------------------- 常量

/** 大多数 git 命令的缺省时限。clone 有自己的（见 `GIT_CLONE_TIMEOUT_MS`）。 */
export const GIT_TIMEOUT_MS = 120_000;

/** clone 的时限：一个中等仓库 + 慢网络，120s 不够。 */
export const GIT_CLONE_TIMEOUT_MS = 300_000;

/** 内联收集 stdout 的上限。超了当错误——调用方要么写文件，要么这条命令本来就不该有这么大输出。 */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** stderr 只留尾部这么多（git 的错误信息在最后几行）。 */
export const GIT_STDERR_TAIL_BYTES = 64 * 1024;

/**
 * 所有 git 调用都带的全局配置。
 *
 *  - `--no-pager`：stdout 是管道时 git 本来不起分页器，但 `pager.diff=true` 之类的
 *    配置能强制它——那会把 patch 污染成导不回去的样子。
 *  - `credential.helper=`（空值 = 清空列表）：**不跑宿主上的凭据助手**。没有它，
 *    macOS 的 osxkeychain 会在 token 过期时"神奇地"用另一份凭据成功，
 *    于是"token 到底有没有被用上"变得不可知，而 401 用例在某些机器上不成立。
 *  - `core.autocrlf=false`：clone / apply / diff 三个环节的行为都不随宿主漂移。
 *  - `commit.gpgsign=false`：CI runner 上没有签名密钥，不该因为宿主的全局配置挂掉。
 *  - `http.lowSpeedLimit` / `http.lowSpeedTime`：弱网（跨国 / 代理）访问 github.com 时连接
 *    会**挂住**——不报错、也不传字节，而 curl 默认没有任何超时，于是唯一的兜底是我们自己
 *    的墙钟 kill（60s–300s 全白等）。这两项让它「1 KB/s 以下持续 20 秒就断开」，
 *    失败才变得可判定——`retryTransientGit` 正是认这个信号重试的。
 *    （真跑 GitHub 的 live 用例踩到的：同一个 token 的 ls-remote 能连续几次卡死 60s，
 *    而匿名请求一秒内就回。窗口一开始写的 60 秒，实测太长了：一个死连接要占满 60 秒，
 *    再乘上 3 次重试，一次 live 跑能拖到 6 分钟——20 秒已经足够区分"慢"与"死"，
 *    真正在传的链路不会低于 1 KB/s。）
 */
export const BASE_GIT_CONFIG: readonly string[] = [
  "--no-pager",
  "-c",
  "credential.helper=",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "http.lowSpeedLimit=1000",
  "-c",
  "http.lowSpeedTime=20",
];

/**
 * 产出 diff 的命令（忠实效验的双方、以及最终生成 patch 的一方）额外带的配置。
 * 每一项都是"宿主的全局配置能改、而沙箱里改不了"的东西。
 */
export const DIFF_GIT_CONFIG: readonly string[] = [
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.renames=true",
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.context=3",
  "-c",
  "diff.interHunkContext=0",
];

/**
 * `git env` 里从宿主透传的键。别的都不继承（理由见 `gitEnv`）。
 *
 * 代理三个变量（大小写都收）是**必须**的：CP 自己也要直连 github.com，而在需要代理的
 * 网络里，没有它们就是"每两三次卡一次、每次卡到墙钟超时"。真跑 GitHub 的 live 用例踩到过：
 * 本机明明有 7890 端口的代理，git 却一直在直连（因为这里把变量滤掉了）。
 * `NO_PROXY` 同样重要——fixture 的 smarthttp 服务器与沙箱都在 127.0.0.1，不能被代理带走。
 * （沙箱自己的出网代理是另一套东西：Phase 6 的 egress-proxy，与这里无关。）
 */
const ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

// ---------------------------------------------------------------- 进程

export interface GitRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 内联 stdout 的上限（只有不写文件时有效）。 */
  maxBufferBytes?: number;
  /** 从 stdin 喂进去的内容。 */
  input?: Buffer | Readable;
  /** stdout 直接写这个文件（大 patch 走这条路，不进内存）。 */
  stdoutFile?: string;
}

export interface GitRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  /** 内联 stdout 超过 `maxBufferBytes`（进程已被杀）。 */
  overflow: boolean;
  /** spawn 失败（典型：宿主没有 git）。 */
  spawnError: Error | null;
  stdoutBytes: number;
  /** `stdoutFile` 模式下流进去的字节的 sha256；非文件模式是 null。 */
  stdoutSha256: string | null;
}

/**
 * 跑一条 git 命令。**不抛**：所有失败都是结果的一部分（调用方用 `gitOrThrow`
 * 或自己分类）。`BASE_GIT_CONFIG` 自动加在最前面，调用方只管子命令。
 *
 * 进程组：`detached` 起，超时/溢出时对**整个组**发 SIGKILL。git 会自己起子进程
 * （ssh、credential helper、fsmonitor），只杀直接子进程会留下孤儿。
 */
export async function runGit(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = options.maxBufferBytes ?? GIT_MAX_BUFFER_BYTES;

  let child: ChildProcess;
  try {
    child = spawn("git", [...BASE_GIT_CONFIG, ...args], {
      cwd: options.cwd,
      env: { ...gitEnv(), ...(options.env ?? {}) },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    return emptyResult({ spawnError: error instanceof Error ? error : new Error(String(error)) });
  }

  let outFile: ReturnType<typeof createWriteStream> | null = null;
  if (options.stdoutFile !== undefined) {
    await mkdir(path.dirname(options.stdoutFile), { recursive: true });
    outFile = createWriteStream(options.stdoutFile);
  }

  const hash = options.stdoutFile === undefined ? null : createHash("sha256");
  const stdoutChunks: Buffer[] = [];
  const stderrTail = new TailBuffer(GIT_STDERR_TAIL_BYTES);
  let stdoutBytes = 0;
  let overflow = false;
  let timedOut = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (outFile !== null) {
      outFile.write(chunk);
      hash?.update(chunk);
      return;
    }
    if (stdoutBytes > maxBytes) {
      overflow = true;
      killProcessTree(child);
      return;
    }
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));

  if (options.input !== undefined) {
    if (Buffer.isBuffer(options.input)) child.stdin?.end(options.input);
    else options.input.pipe(child.stdin!);
  }

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);
  timer.unref();

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: Error | null }>(
    (resolve) => {
      child.once("error", (error: Error) => resolve({ code: null, signal: null, spawnError: error }));
      child.once("close", (code, signal) => resolve({ code, signal, spawnError: null }));
    },
  );
  clearTimeout(timer);
  if (outFile !== null) await new Promise<void>((resolve) => outFile.end(() => resolve()));

  const stdout = Buffer.concat(stdoutChunks);
  return {
    ...outcome,
    stdout,
    stderr: stderrTail.toBuffer(),
    timedOut,
    overflow,
    stdoutBytes,
    stdoutSha256: hash === null ? null : hash.digest("hex"),
  };
}

function emptyResult(overrides: Partial<GitRunResult>): GitRunResult {
  return {
    code: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    timedOut: false,
    overflow: false,
    spawnError: null,
    stdoutBytes: 0,
    stdoutSha256: null,
    ...overrides,
  };
}

/** `retryTransientGit` 的旋钮。 */
export interface TransientRetryOptions {
  /** 总尝试次数（含第一次）。默认 3。 */
  attempts?: number;
  /** 两次尝试之间的等待。默认 1s。 */
  delayMs?: number;
  /** 记日志（重试前记一条 warn）。 */
  log?: LogFn;
  /** 日志里的动作名，例如 `ls-remote reuben-cloud/x`。 */
  describe?: string;
}

/**
 * 弱网读操作的缺省重试次数与间隔。
 *
 * 4 次是实测定的：这台机器到 github.com 的连接大约每 2 次就有 1 次卡在**请求建立阶段**
 * （HTTP/1.1 与 HTTP/2 一样，`http.lowSpeed*` 也拦不到——它只管传输阶段），
 * 单次成功的概率很低；4 次能把“一次发布里每个远端操作都能成功”抬到 90% 以上，
 * 而每次尝试的代价很小（时限在调用方，都是十几秒）。
 */
export const GIT_TRANSIENT_ATTEMPTS = 4;
export const GIT_TRANSIENT_RETRY_DELAY_MS = 1_000;

/**
 * 弱网 / 代理导致的瞬时失败（**可重试**）。
 *
 * 只认这几类字符串：认证失败（401）、仓库不存在（404）、分支保护…… 都是**确定性**的，
 * 重试一百次也一样。把它们和网络抖动分开是重试的前提——不分开的重试只是把错误延后。
 */
export function looksLikeTransientNetworkFailure(stderr: string): boolean {
  return /could not resolve host|failed to connect|connection timed out|couldn't connect|operation timed out|recv failure|empty reply from server|ssl_error|stream error|unexpected eof|hung up unexpectedly|rpc failed|connection reset|too slow|bytes\/sec/i.test(
    stderr,
  );
}

/** 这个错误值不值得重试。`git_timeout` 算（我们的墙钟到点 / lowSpeed 断开），其他看 stderr。 */
export function isTransientGitError(error: unknown): boolean {
  if (!(error instanceof RepoError)) return false;
  if (error.reason === "git_timeout") return true;
  if (error.reason !== "git_failed") return false;
  const stderr = typeof error.details["stderr"] === "string" ? error.details["stderr"] : "";
  return looksLikeTransientNetworkFailure(stderr);
}

/**
 * 把一次**只读的**远端操作重试几次（`ls-remote` / `fetch`）。
 *
 * 【重试的边界】只用于读：`ls-remote`、`fetch`。**push 绝不在这里重试**——
 * 「超时」对写操作有两种含义（请求根本没发出去 / 发出去了但响应丢了），重试可能把一个
 * 已经成功的推送再推一遍、也可能把一个失败的当成成功的。写操作失败了就如实上报，
 * 由人重跑（重跑本来就是幂等的：同一个 Task 同一条分支同一条 PR）。
 */
export async function retryTransientGit<T>(fn: () => Promise<T>, options: TransientRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? GIT_TRANSIENT_ATTEMPTS);
  const delayMs = options.delayMs ?? GIT_TRANSIENT_RETRY_DELAY_MS;
  const log = options.log ?? noopLog;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientGitError(error)) throw error;
      log(
        "warn",
        `${options.describe ?? "git 远端操作"}失败（${(error as RepoError).reason}），${delayMs}ms 后重试（第 ${attempt}/${attempts - 1} 次）`,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

/**
 * 杀掉一个进程的整个进程组。git / tar 都会自己起子进程（ssh、credential helper、
 * fsmonitor），只杀直接子进程会留下孤儿。杀不到组就退回直接子进程（它可能已经死了）。
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退出了。
    }
  }
}

/** 只保留尾部 `limit` 字节的缓冲区。git 的错误信息在最后几行。 */
class TailBuffer {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    if (chunk.length >= this.#limit) {
      this.#chunks.length = 0;
      this.#chunks.push(chunk.subarray(chunk.length - this.#limit));
      this.#bytes = this.#limit;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#bytes > this.#limit && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift()!;
      this.#bytes -= dropped.length;
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

// ---------------------------------------------------------------- 环境与凭据

/**
 * git 的运行环境。**从零构造，不继承 `process.env`**：
 * 继承整个环境的风险是 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` /
 * `GIT_CONFIG_GLOBAL` / `GIT_EXTERNAL_DIFF` 这类变量会把这次调用指到别的地方、
 * 或者改变 patch 的内容——而这几件事的表现都是"偶尔生成一份错的 patch"。
 *
 * `LC_ALL=C`：我们会解析 git 的 stderr 与 `--shortstat` 的措辞，locale 必须是固定的。
 */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LC_ALL: "C",
    LANG: "C",
    // 禁止任何交互式提示：CI 上没有人能回答，等提示就是等超时。
    GIT_TERMINAL_PROMPT: "0",
    // 忽略 /etc/gitconfig：宿主的系统配置不该影响"搬运一个仓库"这件事。
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** `x-access-token:<token>` 的 Basic 头。GitHub App 的 installation token 就是这么用的。 */
export function basicAuthHeader(token: string): string {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}

/**
 * token → argv。**这是 token 进入命令行的唯一方式**：`-c` 形式的配置只作用于
 * 这一次命令，不写入任何文件（GitHub 的文档推荐的就是这个方法）。
 * 没有 token（本地 fixture、file:// 远端）时返回空数组。
 */
export function tokenAuthArgs(token: string | null | undefined): string[] {
  if (token === null || token === undefined || token === "") return [];
  return ["-c", `http.extraHeader=${basicAuthHeader(token)}`];
}

/** 给日志与错误信息用的 argv：`http.extraHeader` 的值永远遮蔽。 */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => (arg.startsWith("http.extraHeader=") ? "http.extraHeader=<redacted>" : arg));
}

/** `git clone …` 这样的一行，可以安全地进日志。 */
export function redactedCommand(args: readonly string[]): string {
  return ["git", ...redactArgs(args)].join(" ");
}

/**
 * URL 里不许带 userinfo（`https://user:pass@host/…` 或 `https://token@host/…`）。
 *
 * 这条不是"风格"：带 userinfo 的 URL 会被 git 写进 `.git/config` 的 remote.origin.url，
 * 而我们马上要把带 `.git` 的整个仓库打成 tar 灌进沙箱。`git@github.com:owner/repo`
 * 这种 scp 形式的 `git@` 是 SSH 用户名、不是秘密，所以只检查 `scheme://` 形式。
 */
export function assertNoUserInfo(url: string, context: string): void {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme === null) return;
  const authority = url.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? "";
  const at = authority.lastIndexOf("@");
  if (at < 0) return;
  throw new RepoError(
    "credentials_in_url",
    `${context} 的 URL 里带了 userinfo；凭据只能通过 -c http.extraHeader 传递`,
    { details: { host: authority.slice(at + 1) } },
  );
}

// ---------------------------------------------------------------- 失败分类

export interface GitThrowOptions extends GitRunOptions {
  /** 非 0 退出时用的 reason（认证失败会被覆盖成 `auth_failed`）。 */
  reason?: RepoErrorReason;
  /** 进 `details` 的上下文（哪一步、哪个仓库）。**不要放 token 或 URL 的凭据部分。** */
  context?: Record<string, unknown>;
}

/**
 * 跑一条 git 命令，成功时返回 stdout（utf8）。失败按 `reason` 抛 `RepoError`。
 *
 * 认证类失败（401/403、"could not read Username"）一律归成 `auth_failed`，
 * 不管调用方给的是什么 reason：这个分类在排障时的价值最高，而 git 的 stderr
 * 是唯一能看出它的地方。
 */
export async function gitOrThrow(args: readonly string[], options: GitThrowOptions = {}): Promise<string> {
  const result = await runGit(args, options);
  if (result.spawnError !== null) {
    throw new RepoError("git_unavailable", `git 起不来：${result.spawnError.message}`, {
      details: { command: redactedCommand(args), ...options.context },
    });
  }
  if (result.timedOut) {
    throw new RepoError("git_timeout", `git 超过 ${options.timeoutMs ?? GIT_TIMEOUT_MS}ms 没有结束`, {
      details: { command: redactedCommand(args), ...options.context },
    });
  }
  if (result.overflow) {
    throw new RepoError("git_overflow", `git 的输出超过内联上限`, {
      details: { command: redactedCommand(args), bytes: result.stdoutBytes, ...options.context },
    });
  }
  if (result.code !== 0) throw gitFailure(args, result, options);
  return result.stdout.toString("utf8");
}

/** 把一次失败的 git 调用翻译成 `RepoError`（`code` / stderr 尾部进 details / 消息）。 */
export function gitFailure(args: readonly string[], result: GitRunResult, options: GitThrowOptions = {}): RepoError {
  const stderrText = result.stderr.toString("utf8");
  const reason = looksLikeAuthFailure(stderrText) ? "auth_failed" : (options.reason ?? "git_failed");
  const summary = firstLines(stderrText);
  return new RepoError(reason, `git ${redactedCommand(args)} 失败（exit ${result.code ?? result.signal}）：${summary}`, {
    details: { command: redactedCommand(args), exitCode: result.code, stderr: summary, ...options.context },
  });
}

/** git 的认证失败长得不统一（HTTP 401/403、凭据助手报错、没有用户名）。 */
export function looksLikeAuthFailure(stderr: string): boolean {
  return [
    /Authentication failed/i,
    /could not read Username/i,
    /could not read Password/i,
    /Invalid username or password/i,
    /terminal prompts disabled/i,
    /The requested URL returned error: 40[13]/i,
    /HTTP 40[13]/i,
  ].some((pattern) => pattern.test(stderr));
}

/** force-with-lease 被拒的 stderr 是 `! [rejected] … (stale info)`。 */
export function looksLikeLeaseRejection(stderr: string): boolean {
  return /stale info/i.test(stderr);
}

/** push 被拒（non-fast-forward / fetch first）。 */
export function looksLikePushRejection(stderr: string): boolean {
  return /non-fast-forward/i.test(stderr) || /fetch first/i.test(stderr) || /\[rejected\]/i.test(stderr);
}

/**
 * 远端因为**分支保护规则**拒了这次 push（Phase 12 的失败模式表）：
 * GitHub 的 `remote: error: GH006: Protected branch update failed`，或语言/版本不同的
 * `protected branch` / `branch protection` 措辞。
 * 它和 lease 被拒是两件事：前者要人去改保护规则，后者说明有人动过分支。
 */
export function looksLikeProtectedBranch(stderr: string): boolean {
  return /GH006/i.test(stderr) || /protected branch/i.test(stderr) || /branch protection/i.test(stderr);
}

function firstLines(text: string): string {
  const lines = text.trim().split("\n").slice(0, 8).join("\n");
  return lines.length > 2_000 ? `${lines.slice(0, 2_000)}…` : lines;
}

// ---------------------------------------------------------------- diff 与 patch

/**
 * `git add -A -N` 之后把「工作区相对 base 的完整 patch」写到文件，返回字节数与 sha256。
 *
 * 命令与沙箱侧 `diff.ts` 的 patch 命令**逐字对齐**：
 * `git --no-pager diff --no-color --no-ext-diff --binary -M <base>`。
 * 它的 sha256 要拿来跟沙箱返回的那份比（`apply.ts` 的忠实效验），
 * 少一个 flag 就是在比两个不同的东西。
 */
export async function writeWorktreeDiff(
  dir: string,
  base: string,
  destFile: string,
): Promise<{ bytes: number; sha256: string }> {
  await gitOrThrow(["-C", dir, "add", "-A", "-N"], { reason: "git_failed", context: { step: "intent-to-add", dir } });
  const args = [...DIFF_GIT_CONFIG, "-C", dir, "diff", "--no-color", "--no-ext-diff", "--binary", "-M", base];
  const result = await runGit(args, { stdoutFile: destFile });
  if (result.spawnError !== null) {
    throw new RepoError("git_unavailable", `git 起不来：${result.spawnError.message}`, {
      details: { command: redactedCommand(args) },
    });
  }
  if (result.timedOut) throw new RepoError("git_timeout", `生成 patch 超时`, { details: { base, dir } });
  if (result.code !== 0) throw gitFailure(args, result, { reason: "git_failed", context: { base } });
  if (result.stdoutSha256 === null) throw new RepoError("git_failed", "patch 文件没有算出 sha256");
  return { bytes: result.stdoutBytes, sha256: result.stdoutSha256 };
}
