/**
 * P8 · 解析编排的主进程侧：文件发现、语言映射、预算，以及与 worker 子进程的 NDJSON 协议。
 *
 * 【为什么解析必须在一个子进程里】spec Phase 8 §2 的原话：WASM 模块崩溃 / OOM 会带走整个进程，
 * 而索引是"随时可以重来"的派生物，不该有任何机会影响正在跑的 Run。所以这里的形态不是"try/catch
 * 包一下 parse"，而是**进程边界**：CP 主进程 `spawn` 一个 worker，一批文件一次，跑完退出
 * （不做常驻池——M2 的索引频次低，常驻池换来的是"一个坏状态活到下一批"的风险）。
 *
 * 【为什么协议是 NDJSON 而不是一个 JSON 文档】一批文件的结果可能几十 MB，而"边解析边发"让
 * 主进程能在 worker 卡死之前就拿到已完成的部分（总预算到了就 kill，已解析的部分仍然可用——
 * spec §6 的"降级"就是这么来的）。一行一条消息也让排障时可以直接 `tail` 那份 stdout。
 *
 * 【三处预算都是代码，不是运维约定】（spec §6）
 *  - 单文件 200ms：**只能在文件解析完之后**判断（WASM 的 parse 是同步的、不可中断），
 *    超了就丢掉这个文件的结果——"跳过该文件"这句在实现上就是这个意思；
 *  - 总预算 90s：主进程用墙钟硬杀（worker 自己也会在每两个文件之间看一次表，能优雅收尾）；
 *  - 内存 1 GiB：worker 的 `--max-old-space-size=1024`。JS 堆超了是 worker 崩，CP 不受影响。
 *
 * 【最容易写错的一处】`spawn` 的 env。worker 只需要 PATH/HOME/TMPDIR——它的输入是仓库文本，
 * 与凭据无关。把 CP 的完整环境传下去等于把 GitHub token / 模型 key 送进一个"解析别人代码"的进程，
 * 那是 M0 红线（零凭据泄漏）里最容易自己踩进去的一条缝。
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../environment/signals.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { extractRefs } from "./refs.ts";
import { VENDOR_TREE_SITTER_DIR } from "./vendor.ts";
import { extractSymbols, languageOfPath, openParserPool } from "./symbols.ts";
import type { LanguageId, SymbolRecord } from "./symbols.ts";

// ---------------------------------------------------------------- 预算常量

/** 单文件预算（spec §6）。超时的文件跳过——见文件头。 */
export const PER_FILE_BUDGET_MS = 200;

/** 全量索引的总预算。到点主进程硬杀 worker，已解析的部分照常可用（`partial_timeout`）。 */
export const TOTAL_BUDGET_MS = 90_000;

/** 超过这个体积的文件直接跳过（spec §3：跳过超大文件）。1 MiB 是"没被生成的代码"的量级。 */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * 文件数上限。比 `environment/signals.ts` 的 5000 大一档：索引要多服务一层
 * （地图要按排名挑文件，5000 个文件的中位仓库正好会被砍在边界上），但也不能无上限——
 * 一次目录遍历的内存与时间是线性的，索引是随 Run 触发的后台动作。
 */
export const MAX_INDEX_FILES = 20_000;

/** worker 的堆上限（spec §6）。 */
export const WORKER_MAX_OLD_SPACE_MB = 1024;

/** 硬杀之前留给 worker 收尾的时间（它自己也会看表，这只是兜底）。 */
export const DEFAULT_KILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------- 文件发现

export interface DiscoveredFile {
  /** 仓库相对路径，`/` 分隔。 */
  path: string;
  lang: LanguageId;
}

export interface Discovery {
  /** 扫描到的全部文件（含不支持的语言；`repo_indexes.files` 就是它的长度）。 */
  all: string[];
  /** 可解析的文件（有语法文件的那九种）。 */
  indexable: DiscoveredFile[];
  /** 语言 → 文件数（`repo_indexes.languages`）。 */
  byLanguage: Record<string, number>;
  /** 目录遍历被 `maxFiles` 截断了（结果仍然可用，只是不完整）。 */
  truncated: boolean;
}

/**
 * 找这个仓库里"值得解析"的文件。
 *
 * 跳过目录的规则**复用** `environment/signals.ts` 的 `scanRepo`：`node_modules` / `vendor` /
 * `dist` / `.git` 这些目录在一处定义、两处使用，比两个模块各自维护一份"什么算仓库文件"更不容易漂
 * （P5 的推断与 P8 的索引对"这个仓库有哪些文件"必须给出同一个答案，否则地图里的文件
 * 与环境里装依赖的文件会是两份清单）。
 */
export async function discoverFiles(root: string, options: { maxFiles?: number } = {}): Promise<Discovery> {
  const scan = await scanRepo(root, { maxFiles: options.maxFiles ?? MAX_INDEX_FILES });
  const indexable: DiscoveredFile[] = [];
  const byLanguage: Record<string, number> = {};
  for (const file of scan.files) {
    const lang = languageOfPath(file);
    if (lang === null) continue;
    indexable.push({ path: file, lang });
    byLanguage[lang] = (byLanguage[lang] ?? 0) + 1;
  }
  return { all: scan.files, indexable, byLanguage, truncated: scan.truncated };
}

// ---------------------------------------------------------------- 协议

/** 一个文件的解析结果状态。`unsupported` 只可能出现在"整批是空的"这种情况下的兜底。 */
export type ParseFileStatus = "ok" | "too_large" | "unreadable" | "timeout" | "error";

export interface ParsedFile {
  path: string;
  lang: LanguageId;
  status: ParseFileStatus;
  symbols: SymbolRecord[];
  identifiers: string[];
  imports: string[];
  durationMs: number;
  bytes: number;
  /** 失败时的一句话原因（写进 worker 的日志，不进数据库）。 */
  error: string | null;
}

export interface ParseOutcome {
  files: ParsedFile[];
  /** 总预算到了（已解析的部分在 `files` 里，状态是 ready + partial_timeout 的来源）。 */
  timedOut: boolean;
  /** worker 非正常结束（崩了 / 被打 / 协议坏了）。`files` 里是同批已收到的部分。 */
  crashed: boolean;
  exitCode: number | null;
  /** stderr 的尾部（WASM 的崩溃信息通常在这里）。 */
  stderr: string;
  /** 本批所有文件的解析耗时之和与墙钟耗时。 */
  parseMs: number;
  wallMs: number;
  /** 超过单文件预算被丢掉的符号——只影响这些文件（spec §6）。 */
  timedOutFiles: string[];
}

/** worker → 主进程的消息。 */
type WorkerMessage =
  | ({ type: "file"; path: string; lang: LanguageId } & Omit<ParsedFile, "path" | "lang">)
  | { type: "done"; files: number; symbols: number; timedOut: boolean; wallMs: number }
  | { type: "log"; level: "info" | "warn"; message: string; path?: string }
  | { type: "fatal"; message: string };

/** 主进程 → worker 的消息（一批一次）。 */
interface WorkerRequest {
  type: "batch";
  root: string;
  files: string[];
}

// ---------------------------------------------------------------- 主进程侧

export interface ParseBatchOptions {
  root: string;
  files: readonly DiscoveredFile[];
  /** 语法文件目录（缺省就是仓库里的 `vendor/tree-sitter/`，见 `vendor.ts`）。 */
  vendorDir?: string;
  perFileBudgetMs?: number;
  totalBudgetMs?: number;
  maxFileBytes?: number;
  /** 总预算之后还留给 worker 多久收尾（默认 5s；测试里调小以免让单测跑 5 秒）。 */
  killGraceMs?: number;
  log?: LogFn;
  /** 换一个 worker 命令（测试用；默认是 `node worker.ts`）。 */
  workerPath?: string;
}

/** worker 的执行环境：只有这三样，见文件头最后一段。 */
export function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function defaultWorkerPath(): string {
  return fileURLToPath(new URL("./worker.ts", import.meta.url));
}

/**
 * 一批文件交给一个 worker，收完结果它就退出。
 *
 * 失败**不抛异常**：崩了 / 超时都是"这次索引不完整"这一类结果（spec §6 的降级），
 * 由调用方决定落 failed 还是 partial。抛异常会让"索引失败不阻塞 Run"变成一个 try/catch 约定，
 * 而约定是会被人忘记的。
 */
export async function parseBatch(options: ParseBatchOptions): Promise<ParseOutcome> {
  const perFileBudgetMs = options.perFileBudgetMs ?? PER_FILE_BUDGET_MS;
  const totalBudgetMs = options.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const log = options.log ?? noopLog;
  const workerPath = options.workerPath ?? defaultWorkerPath();
  const startedAt = Date.now();

  const argv = [
    `--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`,
    workerPath,
    "--vendor",
    options.vendorDir ?? VENDOR_TREE_SITTER_DIR,
    "--per-file-ms",
    String(perFileBudgetMs),
    "--max-file-bytes",
    String(maxFileBytes),
    "--timeout-ms",
    String(totalBudgetMs),
  ];
  const child = spawn(process.execPath, argv, {
    cwd: options.root,
    env: workerEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const files: ParsedFile[] = [];
  let done = false;
  let timedOut = false;
  let fatal: string | null = null;
  let stderr = "";
  let protocolErrors = 0;

  const hardKill = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, totalBudgetMs + (options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));

  const lines = createInterface({ input: child.stdout });
  const pump = (async () => {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch {
        protocolErrors += 1;
        continue;
      }
      switch (message.type) {
        case "file":
          files.push({
            path: message.path,
            lang: message.lang,
            status: message.status,
            symbols: message.symbols,
            identifiers: message.identifiers,
            imports: message.imports,
            durationMs: message.durationMs,
            bytes: message.bytes,
            error: message.error,
          });
          break;
        case "done":
          done = true;
          timedOut = message.timedOut;
          break;
        case "log":
          log(message.level, `索引 worker：${message.message}`, message.path === undefined ? {} : { path: message.path });
          break;
        case "fatal":
          fatal = message.message;
          break;
        default:
          protocolErrors += 1;
      }
    }
  })();

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  // worker 可能在我们写完之前就死了（启动即崩）。那种情况下的 EPIPE 由 `exitCode` 与
  // `crashed` 表达，不该变成一条未捕获的异常把 CP 带走——这里只把它吞掉。
  child.stdin.on("error", () => undefined);
  child.stdin.write(`${JSON.stringify({ type: "batch", root: options.root, files: options.files.map((f) => f.path) } satisfies WorkerRequest)}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      fatal = error.message;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(hardKill);
  await pump;

  const crashed = fatal !== null || protocolErrors > 0 || (!done && !timedOut) || (exitCode !== 0 && !timedOut);
  if (crashed) {
    log("warn", "索引 worker 非正常结束", {
      exitCode,
      fatal,
      protocolErrors,
      received: files.length,
      stderr: stderr.trim().split("\n").slice(-3).join(" | "),
    });
  }

  const timedOutFiles = files.filter((file) => file.status === "timeout").map((file) => file.path);
  return {
    files,
    timedOut,
    crashed,
    exitCode,
    stderr,
    parseMs: files.reduce((sum, file) => sum + file.durationMs, 0),
    wallMs: Date.now() - startedAt,
    timedOutFiles,
  };
}

// ---------------------------------------------------------------- worker 侧

export interface WorkerOptions {
  vendorDir: string;
  perFileBudgetMs: number;
  maxFileBytes: number;
  timeoutMs: number;
}

/** 从 argv 解析 worker 的参数。缺参数就抛——worker 是被我们自己 spawn 的，缺了就是 bug。 */
export function parseWorkerArgs(argv: readonly string[]): WorkerOptions {
  const read = (name: string, fallback: number): number => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  };
  const vendorIndex = argv.indexOf("--vendor");
  return {
    vendorDir: vendorIndex >= 0 ? argv[vendorIndex + 1]! : VENDOR_TREE_SITTER_DIR,
    perFileBudgetMs: read("--per-file-ms", PER_FILE_BUDGET_MS),
    maxFileBytes: read("--max-file-bytes", MAX_FILE_BYTES),
    timeoutMs: read("--timeout-ms", TOTAL_BUDGET_MS),
  };
}

/** 读 stdin 的第一行（那一条批请求）。空输入返回 null（交互式跑出来的空跑）。 */
async function readRequest(): Promise<WorkerRequest | null> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  const first = chunks.join("").split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return null;
  return JSON.parse(first) as WorkerRequest;
}

/**
 * worker 的主循环。**这是 worker.ts 的全部内容**——单测可以直接 import 它跑一个微型批，
 * 不必经过 spawn（协议本身的测试才需要真子进程，见 `index-parse.test.ts`）。
 */
export async function runWorkerMain(options: WorkerOptions = parseWorkerArgs(process.argv.slice(2))): Promise<number> {
  const request = await readRequest();
  if (request === null) return 0;

  const emit = (message: WorkerMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const pool = await openParserPool(options.vendorDir);
  let symbols = 0;
  let processed = 0;
  let timedOut = false;

  try {
    for (const relative of request.files) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      const absolute = path.join(request.root, relative);
      const lang = languageOfPath(relative);
      const fileStartedAt = Date.now();
      if (lang === null) continue;

      let bytes = 0;
      try {
        const info = await stat(absolute);
        bytes = info.size;
        if (info.size > options.maxFileBytes) {
          emit({
            type: "file",
            path: relative,
            lang,
            status: "too_large",
            symbols: [],
            identifiers: [],
            imports: [],
            durationMs: Date.now() - fileStartedAt,
            bytes,
            error: `文件超过 ${options.maxFileBytes} 字节`,
          });
          processed += 1;
          continue;
        }
        const text = await readFile(absolute, "utf8");
        const tree = await pool.parse(lang, text);
        try {
          const extracted = extractSymbols(tree, lang);
          const refs = extractRefs(tree, lang);
          const durationMs = Date.now() - fileStartedAt;
          // 单文件预算只能**事后**判断（WASM 的 parse 不可中断，见文件头）。
          const status: ParseFileStatus = durationMs > options.perFileBudgetMs ? "timeout" : "ok";
          const kept = status === "ok" ? extracted : [];
          if (status === "ok") symbols += kept.length;
          emit({
            type: "file",
            path: relative,
            lang,
            status,
            symbols: kept,
            identifiers: status === "ok" ? refs.identifiers : [],
            imports: status === "ok" ? refs.imports : [],
            durationMs,
            bytes,
            error: status === "timeout" ? `解析超过单文件预算 ${options.perFileBudgetMs}ms` : null,
          });
        } finally {
          tree.delete();
        }
      } catch (error) {
        // 一个文件读不动 / 解析器抛异常，只影响这个文件（spec §3 的"不报错、不中断"）。
        emit({
          type: "file",
          path: relative,
          lang,
          status: bytes > 0 ? "error" : "unreadable",
          symbols: [],
          identifiers: [],
          imports: [],
          durationMs: Date.now() - fileStartedAt,
          bytes,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      processed += 1;
    }
  } finally {
    pool.close();
  }

  emit({
    type: "done",
    files: processed,
    symbols,
    timedOut,
    wallMs: Date.now() - startedAt,
  });
  return 0;
}
