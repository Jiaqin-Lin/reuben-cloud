/**
 * `GET /diff` —— 相对 base commit 的 patch + 结构化文件列表。
 *
 * 两条输出一条都不能少：CP 要拿 patch 去 `git apply --binary`，也要拿 `files` 存库、
 * 在 UI 上渲染行级视图、算影响面（§C.2「为什么 diff 和 archive 不通过 exec 实现」）。
 * patch 是流式产出的，但端点本身返回 JSON——超限的 patch 落到 `diffRoot`，
 * CP 用 `GET /files?raw=1` 取回；和 exec 的大输出外置只有一份思路，内容不截断。
 *
 * 四条不能忘的事实：
 *  - **base 由调用方传入**（附录 A-3）：沙箱不持有业务状态，它随时可能死掉重建。
 *  - **`git add -A -N` 会改 index**：这是让未跟踪新文件出现在 diff 里的标准做法，
 *    副作用是之后 `git status` 把它们显示成 intent-to-add。接受，写进注释。
 *  - **`--binary` 不能省**：没有它，二进制文件的改动会变成一句 "Binary files differ"，
 *    patch 应用不回去。
 *  - **`/diff` 占 exec 的 BUSY 槽**（附录 A-5）：它和 exec 共享 workspace 的读写语义，
 *    边跑测试边取 diff 会得到一份撕裂的 patch。CP 的流程本来就是顺序的。
 *
 * 【在链路中的位置】server.ts 把 `GET /diff` 转交进来；本文件自己负责
 * 「校验参数 → 占槽 → 跑一串 git → 组装 JSON → 还槽」，异常路径由 finally 兜住。
 * 起进程、超时、断线杀进程组这些公共部分在 stream.ts。
 */

import { open, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { Config } from "./config.ts";
import type { ExecutionRegistry } from "./exec/registry.ts";
import { sendError, sendJson } from "./http.ts";
import { resolveFailureError, type RootResolver } from "./paths.ts";
import { beginJob, spawnManaged, type JobGuard } from "./stream.ts";
import type { DiffFileEntry, DiffFileStatus, DiffResponse } from "./types.ts";

/**
 * 元数据命令（name-status / numstat）的 stdout 上限。
 * 防的是"50 万文件的仓库"把内存吃光；真到那个量级，CP 本来就该走 archive 回退。
 */
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

/**
 * `base` 参数的长度上限。sha 是 40/64 个字符，ref 名 git 自己限到 1024；
 * 这里取 256 只为了不让一个超长字符串进 argv。
 */
const MAX_BASE_CHARS = 256;

/**
 * 处理一条 `GET /diff`。响应完全由本函数发出（成功/失败都是），
 * server.ts 只负责把 URL 转交过来。
 */
export async function handleDiff(
  res: ServerResponse,
  url: URL,
  roots: RootResolver,
  registry: ExecutionRegistry,
  config: Config,
): Promise<void> {
  // ---- 参数先校验完再占槽：一个必然 400 的请求不该去碰 BUSY 槽。
  // 仓库路径可选，默认就是 workspace 根。为什么给 path 参数：沙箱不猜 CP 把仓库放在哪儿
  // （Phase 9 把仓库解到 /workspace，Phase 11 的 REPO_DIR 又写着 /workspace/repo），
  // 让调用方说出来比自己试探干净。按写校验——`git add -A -N` 会改这个目录下的 .git/index。
  let repoPath = roots.realWriteRoot;
  const requestedPath = url.searchParams.get("path");
  if (requestedPath !== null) {
    const resolved = roots.resolve(requestedPath, { forWrite: true });
    if (!resolved.ok) {
      sendJson(res, 400, resolveFailureError(resolved.reason, roots, true));
      return;
    }
    repoPath = resolved.abs;
  }

  // base 可选，缺省 HEAD。先做一次便宜的合法性检查：git 会把以 `-` 开头的东西当选项，
  // 而 base 是调用方给的，不能让它变成 git 的命令行开关。
  let base = "HEAD";
  const requestedBase = url.searchParams.get("base");
  if (requestedBase !== null) {
    if (
      requestedBase === "" ||
      requestedBase.includes("\0") ||
      requestedBase.startsWith("-") ||
      requestedBase.length > MAX_BASE_CHARS
    ) {
      sendError(res, 400, "invalid_base", "base must be a non-empty commit-ish that does not start with `-`");
      return;
    }
    base = requestedBase;
  }

  const job = beginJob(registry, config, res, "diff");
  if (!job.ok) {
    sendJson(res, job.status, job.body);
    return;
  }
  const guard = job.guard;
  // 外置 patch 的落点：文件名用占槽 id（`diff_01H….patch`），和日志文件是同一套命名思路。
  // diffRoot 在启动时就被 createRootResolver mkdir 过（它在读集合里，见 config.ts）。
  const patchPath = path.join(config.diffRoot, `${guard.id}.patch`);

  try {
    await runDiff(res, guard, roots, config, repoPath, base, patchPath);
  } catch (error) {
    // 兜底：runDiff 每一步都自己处理错误，正常不该走到这里。
    // 但真出了没预料到的异常，也绝不能让 BUSY 槽跟着一起漏掉——那是沙箱永久 409。
    sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
  } finally {
    guard.finish();
  }
}

/**
 * diff 的正文：一条条跑 git，最后组装 JSON。每一步之后都查一次中止（超时/断线）。
 *
 * 顺序是设计的一部分：`add -A -N` 必须在所有 `diff` 之前，否则未跟踪的新文件
 * 根本不在 diff 里；`head` 在 `add` 前后取都一样（intent-to-add 不产生 commit）。
 */
async function runDiff(
  res: ServerResponse,
  guard: JobGuard,
  roots: RootResolver,
  config: Config,
  repoPath: string,
  base: string,
  patchPath: string,
): Promise<void> {
  // ---- 1. 这是个 git 仓库吗？--show-toplevel 顺手给出仓库根：
  // 后续命令都用仓库根跑，这样 path 指向子目录时行为也一致（`git diff` 本来就覆盖整仓）。
  const top = await runGit(guard, config, repoPath, ["rev-parse", "--show-toplevel"]);
  if (stopIfAborted(res, guard)) return;
  if (top.spawnError !== null) {
    sendError(res, 500, "spawn_failed", `git could not be started: ${top.spawnError.message}`);
    return;
  }
  if (top.code !== 0) {
    sendError(res, 400, "not_a_git_repository", gitMessage(top));
    return;
  }
  const repo = top.stdout.toString("utf8").trim();
  // 仓库根必须还在写根之内：后面要改它的 index，越界的仓库不能碰。
  if (!roots.contains(repo, { forWrite: true })) {
    sendError(res, 400, "path_out_of_bounds", `git repository root ${repo} is outside the workspace`);
    return;
  }

  // ---- 2. base → 完整 sha。不认识就 400 unknown_base，把 git 的 stderr 带上——
  // CP 要靠这句话区分"传错了 commit"和"仓库不对"。
  const baseRev = await runGit(guard, config, repo, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (stopIfAborted(res, guard)) return;
  if (baseRev.spawnError !== null) {
    sendError(res, 500, "spawn_failed", `git could not be started: ${baseRev.spawnError.message}`);
    return;
  }
  if (baseRev.code !== 0) {
    sendError(res, 400, "unknown_base", gitMessage(baseRev));
    return;
  }
  const baseSha = baseRev.stdout.toString("utf8").trim();

  // ---- 3. head。base 是 HEAD 时这一步必然成功；base 是旧 sha 时，HEAD 理论上也可能是
  // 一个未出生的分支（git checkout --orphan），所以还是要判。
  const headRev = await runGit(guard, config, repo, ["rev-parse", "HEAD"]);
  if (stopIfAborted(res, guard)) return;
  if (headRev.code !== 0) {
    sendError(res, 400, "unknown_base", "HEAD does not resolve to a commit");
    return;
  }
  const headSha = headRev.stdout.toString("utf8").trim();

  // ---- 4. intent-to-add：让未跟踪的新文件出现在 diff 里。
  // 这一步会写 .git/index（见文件头注释），失败一般是 index.lock 之类，归 500。
  const staged = await runGit(guard, config, repo, ["add", "-A", "-N"]);
  if (stopIfAborted(res, guard)) return;
  if (failed(staged)) {
    sendError(res, 500, "git_error", `git add -A -N failed: ${gitMessage(staged)}`);
    return;
  }

  // ---- 5. 文件列表：name-status 给状态与重命名，numstat 给增删行数与二进制标记。
  // 两条命令都带 -z（NUL 分隔），这样带空格/换行的路径不会被引号或换行搞乱。
  const statusRun = await runGit(guard, config, repo, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--name-status",
    "-M",
    "-z",
    baseSha,
  ]);
  if (stopIfAborted(res, guard)) return;
  if (failed(statusRun)) {
    sendError(res, 500, "git_error", `git diff --name-status failed: ${failureMessage(statusRun)}`);
    return;
  }
  const statRun = await runGit(guard, config, repo, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--numstat",
    "-M",
    "-z",
    baseSha,
  ]);
  if (stopIfAborted(res, guard)) return;
  if (failed(statRun)) {
    sendError(res, 500, "git_error", `git diff --numstat failed: ${failureMessage(statRun)}`);
    return;
  }
  const files = mergeFiles(parseNameStatusZ(statusRun.stdout), parseNumStatZ(statRun.stdout));

  // ---- 6. patch 本体。它可能很大，所以不经过 `runGit` 的内联 buffer，直接交给 collector：
  // 小的话留在内存里内联，大了就转写文件，非 UTF-8 也转写文件（理由见 PatchCollector）。
  const collector = new PatchCollector(patchPath, {
    inlineLimit: config.maxPatchBytes,
    spillLimit: config.maxPatchSpillBytes,
  });
  const patchRun = await runProcess(guard, {
    cmd: ["git", "--no-pager", "diff", "--no-color", "--no-ext-diff", "--binary", "-M", baseSha],
    cwd: repo,
    config,
    onChunk: (buf) => collector.push(buf),
  });
  if (stopIfAborted(res, guard)) {
    await collector.discard();
    return;
  }
  if (patchRun.spawnError !== null) {
    await collector.discard();
    sendError(res, 500, "spawn_failed", `git could not be started: ${patchRun.spawnError.message}`);
    return;
  }
  if (patchRun.streamError instanceof PatchTooLargeError) {
    // 超上限：patch 已经写到一半了，删掉半成品再回 413。完整内容拿不到，但 CP 有 archive 回退。
    await collector.discard();
    sendError(
      res,
      413,
      "patch_too_large",
      `patch exceeds ${config.maxPatchSpillBytes} bytes; use GET /archive for the full workspace instead`,
      { limit: config.maxPatchSpillBytes },
    );
    return;
  }
  if (failed(patchRun)) {
    await collector.discard();
    sendError(res, 500, "git_error", `git diff --binary failed: ${failureMessage(patchRun)}`);
    return;
  }
  const patch = await collector.finish();

  const body: DiffResponse = {
    base: baseSha,
    head: headSha,
    files,
    patch: patch.patch,
    patch_bytes: patch.bytes,
    // "有没有内联"和"内容有没有被截断"是两件事：外置的 patch 一定是完整的。
    truncated: patch.path !== null,
    patch_log_path: patch.path,
  };
  sendJson(res, 200, body);
}

// ---------------------------------------------------------------- 跑进程

/** `runProcess()` 的结果。 */
interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** 进程根本没起来（ENOENT / 同步参数错）。 */
  spawnError: Error | null;
  /** 读 stdout 时出的错；`onChunk` 抛的错也归这里。 */
  streamError: Error | null;
}

/**
 * 起一个受管子进程，把 stdout 一块块交给 `onChunk`（可以 async，用作背压），
 * 然后等它退出。超时/断线由 `guard` 负责杀进程组。
 *
 * 为什么要有这个函数：元数据命令和 patch 命令对 stdout 的处理完全不同
 * （一个攒内存、一个写文件），但"起进程 → 读 stdout → 等退出"的生命周期只有一套。
 */
async function runProcess(
  guard: JobGuard,
  options: {
    cmd: string[];
    cwd: string;
    config: Config;
    onChunk?: (chunk: Buffer) => void | Promise<void>;
  },
): Promise<ProcessOutcome> {
  const spawned = await spawnManaged(guard, {
    cmd: options.cmd,
    cwd: options.cwd,
    config: options.config,
  });
  if (!spawned.ok) {
    return { code: null, signal: null, stderr: "", spawnError: spawned.error, streamError: null };
  }
  const proc = spawned.proc;

  let streamError: Error | null = null;
  try {
    for await (const chunk of proc.stdout) {
      // 已经超时/断线：不必再读（进程已经被 guard 杀掉，读下去也只有残片）。
      if (guard.abortReason !== null) break;
      if (options.onChunk !== undefined) await options.onChunk(chunk as Buffer);
    }
  } catch (error) {
    streamError = error as Error;
    // 出错说明我们不打算再要这个进程的输出了：补一刀，免得它继续产数据/占着进程组。
    guard.killAll();
  }

  const exit = await proc.exited;
  return {
    code: exit.code,
    signal: exit.signal,
    stderr: proc.stderrText(),
    spawnError: exit.spawnError,
    streamError,
  };
}

/** `runGit()` 的结果：除了 stdout 直接给 Buffer（`-z` 输出的不是文本）。 */
interface GitRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  spawnError: Error | null;
  streamError: Error | null;
}

/** 跑一条 git 命令并把 stdout 读进内存（带上限）。元数据命令走这条。 */
async function runGit(
  guard: JobGuard,
  config: Config,
  cwd: string,
  args: string[],
  maxStdoutBytes = MAX_METADATA_BYTES,
): Promise<GitRun> {
  const chunks: Buffer[] = [];
  let size = 0;
  const outcome = await runProcess(guard, {
    // --no-pager：stdout 是管道时 git 本来就不会起分页器，但配置能强制它。
    cmd: ["git", "--no-pager", ...args],
    cwd,
    config,
    onChunk: (buf) => {
      size += buf.length;
      if (size > maxStdoutBytes) {
        throw new Error(`git output exceeded ${maxStdoutBytes} bytes (git ${args.join(" ")})`);
      }
      chunks.push(buf);
    },
  });
  return {
    code: outcome.code,
    stdout: Buffer.concat(chunks),
    stderr: outcome.stderr,
    spawnError: outcome.spawnError,
    streamError: outcome.streamError,
  };
}

/** 命令是不是没跑成（spawn 失败或读到一半出错）。 */
function failed(run: { code: number | null; spawnError: Error | null; streamError: Error | null }): boolean {
  return run.spawnError !== null || run.streamError !== null || run.code !== 0;
}

/** git 的失败原因：优先用 stderr 的第一行，没有就说退出码。 */
function gitMessage(run: { code: number | null; stderr: string }): string {
  const line = run.stderr.trim().split("\n")[0]?.trim();
  return line !== undefined && line !== "" ? line : `git exited with code ${run.code ?? "null"}`;
}

/**
 * 失败原因的统一措辞：优先 streamError（那是我们自己抛的，比如输出超限、外置 patch 写不下去），
 * 其次是 spawnError，最后才去看 git 的 stderr。反过来写会把 ENOSPC 报成一句毫无信息的
 * "git exited with code null"。
 */
function failureMessage(run: {
  code: number | null;
  stderr: string;
  streamError: Error | null;
  spawnError: Error | null;
}): string {
  if (run.streamError !== null) return run.streamError.message;
  if (run.spawnError !== null) return run.spawnError.message;
  return gitMessage(run);
}

/** 每一步之后查一次中止：超时 → 504；客户端断开 → 什么都不发（对端已经不在了）。 */
function stopIfAborted(res: ServerResponse, guard: JobGuard): boolean {
  const reason = guard.abortReason;
  if (reason === null) return false;
  if (reason === "timeout") {
    sendError(res, 504, "stream_timeout", `git did not finish within ${guard.timeoutMs}ms`);
  }
  return true;
}

// ---------------------------------------------------------------- patch 的去处

/**
 * patch 外置的体积上限被撞到时抛这个。调用方（runDiff）靠它区分
 * "git 坏了"（500）和"patch 太大了"（413 + 建议走 archive）。
 */
class PatchTooLargeError extends Error {}

/** `PatchCollector.finish()` 的结果。 */
interface PatchResult {
  /** 内联文本；外置时是 null。 */
  patch: string | null;
  /** 外置文件路径；内联时是 null。 */
  path: string | null;
  /** patch 的真实字节数。 */
  bytes: number;
}

/**
 * patch 的去处。默认在内联 buffer 里攒到 `inlineLimit` 字节；一超就转写文件
 * （`diffRoot/{id}.patch`），CP 用 `GET /files?raw=1` 取回。内容不截断，只是换个地方放。
 *
 * 还有**第二种**转写原因，和体积无关：patch 不是合法 UTF-8。JSON 字符串装不下任意字节，
 * `Buffer.toString("utf8")` 会把它们替换成 U+FFFD——对一份要 `git apply` 的补丁来说，
 * 那就等于"apply 出来的代码和沙箱里验证过的不是同一份"。所以这时也落文件。
 * （绝大多数 patch 是 UTF-8 或 ASCII 的 base85 二进制块，只有非 UTF-8 的文本文件会踩到。）
 *
 * 写入用 `FileHandle.write` 串行 await：既不在内存里再攒一份，也天然形成背压——
 * 一个 100 MiB 的 patch 不会变成 Node 写缓冲里的 100 MiB。
 */
class PatchCollector {
  /** 外置落点。只有真的转写文件时才存在。 */
  readonly path: string;

  #inlineLimit: number;
  #spillLimit: number;
  /** 还没转写文件时攒在这里。 */
  #chunks: Buffer[] = [];
  /** 收到的总字节数。 */
  #total = 0;
  /** 非 null = 已经在写文件。 */
  #handle: FileHandle | null = null;
  /** 文件是否被创建过（discard 靠它决定要不要 unlink）。 */
  #fileWritten = false;

  constructor(target: string, options: { inlineLimit: number; spillLimit: number }) {
    this.path = target;
    this.#inlineLimit = options.inlineLimit;
    this.#spillLimit = options.spillLimit;
  }

  /**
   * 收到一块 patch 字节。
   * @throws PatchTooLargeError 超过 `spillLimit`（调用方转 413）
   */
  async push(buf: Buffer): Promise<void> {
    this.#total += buf.length;
    if (this.#total > this.#spillLimit) throw new PatchTooLargeError(`patch exceeds ${this.#spillLimit} bytes`);
    if (this.#handle === null && this.#total > this.#inlineLimit) await this.#startSpill();
    if (this.#handle !== null) {
      await this.#handle.write(buf);
      return;
    }
    this.#chunks.push(buf);
  }

  /** 收尾：要么给出内联文本，要么给出外置文件路径。 */
  async finish(): Promise<PatchResult> {
    if (this.#handle !== null) {
      await this.#handle.close();
      this.#handle = null;
      return { patch: null, path: this.path, bytes: this.#total };
    }

    const buffer = Buffer.concat(this.#chunks);
    this.#chunks = [];
    const text = decodeUtf8Strict(buffer);
    if (text !== null) return { patch: text, path: null, bytes: this.#total };

    // 非法 UTF-8：落盘，理由见类头注释。
    await writeFile(this.path, buffer);
    this.#fileWritten = true;
    return { patch: null, path: this.path, bytes: this.#total };
  }

  /** 失败路径：关掉句柄、把半成品删掉。绝不能留下一个"看起来能读"的半个 patch。 */
  async discard(): Promise<void> {
    if (this.#handle !== null) {
      await this.#handle.close().catch(() => {});
      this.#handle = null;
    }
    if (this.#fileWritten) await unlink(this.path).catch(() => {});
  }

  /** 打开文件，并把已经攒在内存里的那几块先倒进去。 */
  async #startSpill(): Promise<void> {
    this.#handle = await open(this.path, "w");
    this.#fileWritten = true;
    for (const old of this.#chunks) await this.#handle.write(old);
    this.#chunks = [];
  }
}

/** 严格 UTF-8 解码：非法字节返回 null（而不是 U+FFFD）。和 files/read.ts 同一条规矩。 */
function decodeUtf8Strict(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 解析 git 的输出
//
// 下面两个解析器（以及 mergeFiles）是导出的，但生产路径只有 handleDiff 一个入口；
// 导出纯粹是为了单测能直接喂字节进去——用真实仓库造"带换行的路径"太重。

/** `git diff --name-status -z` 解出来的一项。 */
export interface DiffNameStatus {
  status: DiffFileStatus;
  /** 变更后的路径。 */
  path: string;
  /** 仅 renamed / copied。 */
  oldPath?: string;
}

/** `git diff --numstat -z` 解出来的一项（按变更后的路径索引）。 */
export interface DiffStat {
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * 解析 `git diff --name-status -M -z`。
 *
 * 线上格式是一串 NUL 分隔的字段：
 *   普通项：`<字母>\0<path>\0`
 *   重命名：`R<相似度>\0<旧路径>\0<新路径>\0`
 * 用 `-z` 而不是按行解析：路径里可以有空格和换行，引号转义规则（core.quotePath）
 * 又会随配置漂移，NUL 分隔是唯一稳的读法。
 */
export function parseNameStatusZ(buffer: Buffer): DiffNameStatus[] {
  const fields = splitNul(buffer);
  const out: DiffNameStatus[] = [];

  for (let index = 0; index < fields.length; ) {
    const code = fields[index++]!;
    const letter = code.slice(0, 1);
    if (letter === "R" || letter === "C") {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (oldPath === undefined || newPath === undefined) break; // 输出被截断：能解多少算多少
      out.push({ status: letter === "R" ? "renamed" : "copied", path: newPath, oldPath });
      continue;
    }
    const target = fields[index++];
    if (target === undefined) break;
    out.push({ status: mapStatus(letter), path: target });
  }
  return out;
}

/**
 * 解析 `git diff --numstat -M -z`。
 *
 * 线上格式（每项一个字段，字段内前两段用 TAB 分隔）：
 *   普通项：`<加行数|->\t<删行数|->\t<path>\0`
 *   重命名：`<加行数|->\t<删行数|->\t\0<旧路径>\0<新路径>\0`
 *
 * 重命名那种"第三个字段是空的，后面再跟两个 NUL 字段"的形状是 git 的既有行为，
 * 单测里锁着一份真实输出的字节。二进制文件用 `-` 表示，这里翻译成 0 行 + `binary:true`
 * （0/0 本身也是普通变更的合法值，所以必须靠 binary 标志区分）。
 */
export function parseNumStatZ(buffer: Buffer): Map<string, DiffStat> {
  const fields = splitNul(buffer);
  const out = new Map<string, DiffStat>();

  for (let index = 0; index < fields.length; index++) {
    const record = fields[index]!;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;

    const rawAdditions = record.slice(0, firstTab);
    const rawDeletions = record.slice(firstTab + 1, secondTab);
    const stat: DiffStat = {
      additions: rawAdditions === "-" ? 0 : Number(rawAdditions),
      deletions: rawDeletions === "-" ? 0 : Number(rawDeletions),
      binary: rawAdditions === "-" || rawDeletions === "-",
    };

    let target = record.slice(secondTab + 1);
    if (target === "") {
      // 重命名：下一个字段是旧路径、再下一个是新路径（都可能是空串？不可能，路径非空）。
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      if (oldPath === undefined || newPath === undefined) continue;
      index += 2;
      target = newPath;
    }
    out.set(target, stat);
  }
  return out;
}

/**
 * 把 name-status 与 numstat 配成 `files[]`。
 * 以 name-status 为准（它有状态和重命名），numstat 只补增删行数；
 * 配不上（理论上不会）就退化成 0 行而不是丢掉这个文件。
 */
function mergeFiles(changes: DiffNameStatus[], stats: Map<string, DiffStat>): DiffFileEntry[] {
  return changes.map((change) => {
    const stat = stats.get(change.path) ?? { additions: 0, deletions: 0, binary: false };
    const entry: DiffFileEntry = {
      path: change.path,
      status: change.status,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
    };
    if (change.oldPath !== undefined) entry.old_path = change.oldPath;
    return entry;
  });
}

/** git 的单字母状态 → 合同里的词。认不出来的（U/X 之类）给 `unknown`，不猜。 */
function mapStatus(letter: string): DiffFileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechanged";
    default:
      return "unknown";
  }
}

/**
 * 按 NUL 切开，丢掉最后一个空字段（git 的输出以 NUL 结尾，切开后必然多一个空串）。
 * 空路径不可能出现在 diff 里，所以顺手把中间的空字段也滤掉是安全的。
 */
function splitNul(buffer: Buffer): string[] {
  const fields = buffer.toString("utf8").split("\0");
  while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  return fields;
}
