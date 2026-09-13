/**
 * `sandbox-operations.ts` —— 把沙箱 API 适配成 agent-runtime 的工具出口（Operations）。
 *
 * 【为什么要有这一层】`agent-runtime` 的硬约束是"纯决策层 + 窄口注入"（设计文档 §0.3）：
 * 它不知道 Docker、不知道 HTTP、更不知道我们的 9 个端点。工具拿到的是四个窄接口
 * （`ReadOperations` / `WriteOperations` / `LsOperations` / `BashOperations`），
 * 这一层就是"沙箱实现"。换执行后端（本地裸跑、远程沙箱）时只换这一个文件。
 *
 * 【依赖方向】CP → agent-runtime。这个文件 import agent-runtime 的类型，反过来不成立
 * （有一条读 import 图的单测兜着，见 `agent-runtime/test/dependency.test.ts`）。
 *
 * 【bash 的命令形态】沙箱的 `POST /exec` 只收 argv（`sandbox.md` §C.2 的红线，不能破）；
 * 工具层给的是 shell 字符串，所以**包一层 `["bash","-lc", command]` 的动作在这里做**——
 * 这是有意的偏差 A-1（模型先验 vs 红线不受影响，设计文档 §F.2 第 1 条）。
 *
 * 【日志尾部窗口的读取也在这里】工具只要"输出尾部的一段文本 + 一段提示所需的元数据"，
 * 而"怎么从沙箱取文件的最后 256 KiB"是沙箱特有的动作（探长度 → 分片读 → 丢掉半行）。
 * 收在适配器里，工具那边就是纯字符串处理，可以在没有 Docker 的情况下完整测到。
 */

import { Readable } from "node:stream";
import type {
  AgentTool,
  BashExecOptions,
  BashExecResult,
  BuiltinToolOperations,
  FileErrorCode,
  LsResult,
  ReadAnchors,
  ReadOperations,
  WriteOperations,
} from "@reuben-cloud/agent-runtime";
import { FileOperationError, createBuiltinTools, createReadAnchors, splitLines } from "@reuben-cloud/agent-runtime";
import type { AgentFileList, AgentFileRead, AgentFileWrite } from "../client/sandbox-api.ts";
import type { SseEvent } from "../client/sse.ts";
import type { Readable as NodeReadable } from "node:stream";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { SandboxTarget } from "../repo/types.ts";
import type { ExecEventSink } from "./events.ts";
import { createExecEventMapper, emitEvent } from "./events.ts";

// ---------------------------------------------------------------- 沙箱出口（窄接口）

/** `bash` 的出口：跑一条命令并等终态。字段与 `SandboxManager.execInSandbox` 的请求一致。 */
export interface ExecPort {
  execInSandbox(sandboxId: string, request: ToolExecRequest): Promise<ToolExecResult>;
}

export interface ToolExecRequest {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 边收边转发（观察窗的 exec_start / exec_output / exec_end 用它）。 */
  onEvent?: (event: SseEvent) => void;
}

/** 执行结果里适配器真正用到的字段（与 `ExecInSandboxResult` 结构上兼容）。 */
export interface ToolExecResult {
  executionId: string;
  state: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  logTruncated?: boolean;
  logPath: string | null;
  events: SseEvent[];
}

/** 文件三件套的出口。`SandboxApiClient` 结构上满足它。 */
export interface SandboxFilesPort {
  readFile(
    endpoint: string,
    token: string,
    path: string,
    options?: { offset?: number; limit?: number; encoding?: "utf8" | "base64"; signal?: AbortSignal },
  ): Promise<AgentFileRead>;
  listFiles(
    endpoint: string,
    token: string,
    path: string,
    options?: { depth?: number; signal?: AbortSignal },
  ): Promise<AgentFileList>;
  putFile(
    endpoint: string,
    token: string,
    path: string,
    body: Readable,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AgentFileWrite>;
  readRaw(
    endpoint: string,
    token: string,
    path: string,
    options?: { offset?: number; limit?: number; signal?: AbortSignal },
  ): Promise<NodeReadable>;
  /** `POST /exec/{id}/kill`：取消在跑的命令（abort 时用）。 */
  kill(endpoint: string, token: string, executionId: string): Promise<unknown>;
}

// ---------------------------------------------------------------- 装配

export interface SandboxToolkitOptions {
  sandboxId: string;
  exec: ExecPort;
  api: SandboxFilesPort;
  target: SandboxTarget;
  /** 模型心里的工作目录，默认 `/workspace/repo`。 */
  repoDir: string;
  /** 观察窗出口（exec 事件的映射在这里做）。 */
  events?: ExecEventSink;
  log?: LogFn;
}

export interface SandboxToolkit {
  /** 这套工具绑定的沙箱（一个 Run 一个实例；续读锚点是 Run 级状态）。 */
  sandboxId: string;
  /** 交给 `AgentContext.tools` 的冻结快照（按名字排序）。 */
  tools: AgentTool[];
  /** 四个出口的实现（测试与将来别的装配点可以直接用）。 */
  operations: BuiltinToolOperations;
  anchors: ReadAnchors;
}

/**
 * 建一个 Run 的工具集。**一个 Run 一个实例**（续读锚点是 Run 级状态，
 * 文件被 write/bash 改过之后必须失效，见 agent-runtime 的 `tools/anchors.ts`）。
 */
export function createSandboxToolkit(options: SandboxToolkitOptions): SandboxToolkit {
  const log = options.log ?? noopLog;
  const anchors = createReadAnchors();
  const operations = createSandboxOperations(options);
  const tools = createBuiltinTools({ cwd: options.repoDir, operations, anchors });
  log("info", `工具集已装配（${tools.map((tool) => tool.name).join(", ")}）`, {
    sandboxId: options.sandboxId,
    repoDir: options.repoDir,
  });
  return { sandboxId: options.sandboxId, tools, operations, anchors };
}

/** 四个 Operations 的沙箱实现。单独导出是为了让测试能只换其中一个（例如假 bash）。 */
export function createSandboxOperations(options: SandboxToolkitOptions): BuiltinToolOperations {
  return {
    bash: createBashOperations(options),
    read: createReadOperations(options),
    write: createWriteOperations(options),
    ls: createLsOperations(options),
  };
}

// ---------------------------------------------------------------- 懒建沙箱的工具集（会话层用）

export interface LazySandboxToolkitOptions {
  /**
   * 拿一个可用沙箱。**每次工具调用都会调它**——它同时是"续时"的入口
   * （租约里的 `acquire` 会把 `sandbox_last_used_at` 推到当前时间）。
   */
  acquire: () => Promise<{ sandboxId: string; endpoint: string; authToken: string }>;
  exec: ExecPort;
  api: SandboxFilesPort;
  /** 模型心里的工作目录，默认 `/workspace/repo`。 */
  repoDir: string;
  events?: ExecEventSink;
  log?: LogFn;
}

/**
 * **用到才建**的工具集（Phase 2 §6 的核心接线）。
 *
 * 【为什么工具要能先建好、沙箱后到】模型每轮都要看到工具清单（工具定义进缓存前缀），
 * 所以 `tools` 必须在一开始就有；而沙箱要到第一次真的读写/跑命令时才该建。
 * 两者的桥梁就是四个 Operations 的代理：它们的每个方法先 `await acquire()`，
 * 再转给对应沙箱的真实现。一个只说话的 Run 从头到尾不会触发任何一次 `acquire`。
 *
 * 【为什么按 sandboxId 缓存而不是每次重建】回收 / 换容器（寿命到点）之后 sandboxId 会变，
 * 那时必须重建（endpoint 与 token 都变了）。同一个 id 期间复用，则 `createSandboxToolkit`
 * 里的 read 锚点表也一起复用——它本来就是 Run 级状态。
 */
export interface LazySandboxToolkit extends Omit<SandboxToolkit, "sandboxId"> {
  /** 当前实际绑定的沙箱（还没被用到时是 null）。 */
  readonly sandboxId: string | null;
}

export function createLazySandboxToolkit(options: LazySandboxToolkitOptions): LazySandboxToolkit {
  const log = options.log ?? noopLog;
  const anchors = createReadAnchors();
  let current: SandboxToolkit | null = null;

  const toolkit = async (): Promise<SandboxToolkit> => {
    const target = await options.acquire();
    if (current !== null && current.sandboxId === target.sandboxId) return current;
    const built = createSandboxToolkit({
      sandboxId: target.sandboxId,
      exec: options.exec,
      api: options.api,
      target,
      repoDir: options.repoDir,
      ...(options.events === undefined ? {} : { events: options.events }),
      log,
    });
    current = built;
    return built;
  };

  // 代理四个出口：方法签名与真实现逐字一致，只是多一次 `await toolkit()`。
  const operations: BuiltinToolOperations = {
    bash: {
      exec: async (command, cwd, execOptions) => (await toolkit()).operations.bash.exec(command, cwd, execOptions),
    },
    read: {
      readFile: async (path, readOptions) => (await toolkit()).operations.read.readFile(path, readOptions),
      readBytes: async (path, offset, limit, readOptions) =>
        (await toolkit()).operations.read.readBytes(path, offset, limit, readOptions),
    },
    write: {
      writeFile: async (path, content, writeOptions) =>
        (await toolkit()).operations.write.writeFile(path, content, writeOptions),
    },
    ls: {
      list: async (path, listOptions) => (await toolkit()).operations.ls.list(path, listOptions),
    },
  };
  const tools = createBuiltinTools({ cwd: options.repoDir, operations, anchors });
  return {
    tools,
    operations,
    anchors,
    // 测试与排障要看"现在到底用着哪台沙箱"（懒建之后它只在内部状态里）。
    get sandboxId() {
      return current?.sandboxId ?? null;
    },
  };
}

// ---------------------------------------------------------------- bash

/** 读日志尾部的字节窗口：50 KiB 预算的 5 倍（窗口够大，行号才报得准）。 */
export const TAIL_WINDOW_BYTES = 256 * 1024;

function createBashOperations(options: SandboxToolkitOptions): BuiltinToolOperations["bash"] {
  const { exec, api, target, sandboxId } = options;
  const log = options.log ?? noopLog;

  return {
    async exec(command: string, cwd: string, execOptions: BashExecOptions): Promise<BashExecResult> {
      // 观察窗：沙箱的原始事件在这里翻成观察窗事件（前端不认识沙箱的词汇）。
      const mapExecEvent = createExecEventMapper();
      /** 沙箱的 started 事件带来 executionId；abort 时用它去 kill。 */
      let executionId: string | null = null;

      const onAbort = (): void => {
        if (executionId === null) return;
        // 沙箱契约里没有"取消 exec"的隐式语义，但有显式的 kill 端点。
        // 只请求杀、不等结果：命令的终态（killed）会从事件流里回来。
        void api.kill(target.endpoint, target.authToken, executionId).catch((error: unknown) => {
          log("warn", "abort 时 kill 沙箱命令失败（命令会自己超时）", {
            executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };
      execOptions.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const result = await exec.execInSandbox(sandboxId, {
          // 沙箱只收 argv：shell 字符串在这里变成 `bash -lc`（偏差 A-1）。
          cmd: ["bash", "-lc", command],
          cwd,
          ...(execOptions.timeoutMs === undefined ? {} : { timeoutMs: execOptions.timeoutMs }),
          ...(execOptions.env === undefined ? {} : { env: execOptions.env }),
          onEvent: (event) => {
            // ① 观察窗：沙箱事件 → exec 事件（认不出的变成一条 note）。
            for (const mapped of mapExecEvent(event)) emitEvent(options.events, mapped, log);
            // ② abort 时要用的 executionId（started 事件里带来）。
            const data = parseData(event);
            if (data !== null && typeof data["execution_id"] === "string") executionId = data["execution_id"];
            // ③ 给工具的增量（bash 的 onUpdate 与失败信息用）。
            const chunk = parseExecChunk(event);
            if (chunk !== null) execOptions.onData(Buffer.from(chunk.chunk, "utf8"), chunk.stream);
          },
        });

        const tail = await readLogTail(result, options);
        return {
          exitCode: result.exitCode,
          state: normalizeExecState(result.state),
          signal: result.signal,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          output: tail.output,
          windowStart: tail.windowStart,
          totalBytes: tail.totalBytes,
          totalLines: tail.totalLines,
          logPath: result.logPath,
          logTruncated: result.logTruncated === true,
          truncated: result.truncated,
          logError: tail.logError,
        };
      } finally {
        execOptions.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** 沙箱的四种终态 + 一个兜底（认不出时按"跑完了"处理，退出码仍然会如实带出去）。 */
function normalizeExecState(state: string): BashExecResult["state"] {
  switch (state) {
    case "completed":
    case "failed":
    case "timeout":
    case "killed":
      return state;
    default:
      return "completed";
  }
}

interface OutputTail {
  output: string;
  windowStart: number;
  totalBytes: number | null;
  totalLines: number | null;
  logError: string | null;
}

/**
 * 取命令输出的尾部窗口。**优先读日志文件**（交错、完整）；读不回来才退回事件流
 * （`logPath` 为 null，或日志已经不在了——CP 重启会清 tmpfs）。
 */
async function readLogTail(result: ToolExecResult, options: SandboxToolkitOptions): Promise<OutputTail> {
  const logPath = result.logPath;
  if (logPath === null || logPath === "") {
    return { ...fromEvents(result.events), logError: null };
  }
  try {
    return { ...(await readLogWindow(logPath, options)), logError: null };
  } catch (error) {
    // 日志读不回来不是命令失败：事件流里仍然有前 1 MiB。降级并把原因写进结果，
    // 让模型知道"这段可能不完整"，而不是把一次成功的命令报成失败。
    const reason = error instanceof Error ? error.message : String(error);
    (options.log ?? noopLog)("warn", "bash 读不回执行日志，退回事件流内容", { logPath, error: reason });
    return { ...fromEvents(result.events), logError: reason };
  }
}

async function readLogWindow(
  logPath: string,
  options: SandboxToolkitOptions,
): Promise<Omit<OutputTail, "logError">> {
  const { api, target } = options;
  // ① 先要长度：`readFile` 的响应带文件总字节数（只读 1 个字节，白拿 size）。
  const probe = await api.readFile(target.endpoint, target.authToken, logPath, { offset: 0, limit: 1 });
  const size = probe.size;
  // **空日志直接返回**：命令一行输出都没产生时 `size = 0`，而 `limit` 必须是正数
  // （沙箱的 `invalid_range`）——不去发那次一定失败的请求。
  if (size === 0) return { output: "", windowStart: 0, totalBytes: 0, totalLines: 0 };

  const windowStart = Math.max(0, size - TAIL_WINDOW_BYTES);
  // ② 再读窗口。`raw=1` 不校验编码，也不会因为日志里有二进制字节而 400。
  const stream = await api.readRaw(target.endpoint, target.authToken, logPath, {
    offset: windowStart,
    limit: size - windowStart,
  });
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk as Buffer, { stream: true });
  text += decoder.decode();

  // 窗口不是从文件头开始的：第一行可能是半行，丢掉它（它属于更早的内容）。
  if (windowStart > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
  }
  // **截断只发生在工具层**（spec P11："工具输出截断只在一处发生"）。这一层只负责
  // 取回窗口原文；trim 放在这里的话，工具再 trim 一次就看不到"到底切没切"这件事了
  // （它只拿到已经切好的文本，`truncated` 永远是 false——这是 P1 真跑集成测试抓到的一个 bug）。
  return {
    output: text,
    windowStart,
    totalBytes: size,
    // 只有从文件头开始读的窗口才知道绝对行号。
    totalLines: windowStart > 0 ? null : splitLines(text).length,
  };
}

/** 日志读不回来时的降级：用事件流里收到的内容（stdout 与 stderr 分开拼，时序不保证）。 */
function fromEvents(events: readonly SseEvent[]): Omit<OutputTail, "logError"> {
  let stdout = "";
  let stderr = "";
  for (const event of events) {
    const chunk = parseExecChunk(event);
    if (chunk === null) continue;
    if (chunk.stream === "stdout") stdout += chunk.chunk;
    else stderr += chunk.chunk;
  }
  const text = `${stdout}${stderr}`;
  // 事件流本来就只留前 1 MiB，所以"窗口起点 0"的语义与"读整个文件"一致：可以报绝对行号。
  return { output: text, windowStart: 0, totalBytes: null, totalLines: splitLines(text).length };
}

/** `stdout` / `stderr` 事件里的 chunk。其他事件返回 null。 */
function parseExecChunk(event: SseEvent): { stream: "stdout" | "stderr"; chunk: string } | null {
  if (event.event !== "stdout" && event.event !== "stderr") return null;
  const data = parseData(event);
  const chunk = data === null ? null : data["chunk"];
  if (typeof chunk !== "string") return null;
  return { stream: event.event, chunk };
}

function parseData(event: SseEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- read / write / ls

function createReadOperations(options: SandboxToolkitOptions): ReadOperations {
  const { api, target } = options;
  return {
    async readFile(path, readOptions) {
      try {
        const file = await api.readFile(
          target.endpoint,
          target.authToken,
          path,
          readOptions?.signal === undefined ? {} : { signal: readOptions.signal },
        );
        return file.content;
      } catch (error) {
        throw toFileOperationError(error, path);
      }
    },
    async readBytes(path, offset, limit, readOptions) {
      try {
        const stream = await api.readRaw(target.endpoint, target.authToken, path, {
          offset,
          limit,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        });
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      } catch (error) {
        throw toFileOperationError(error, path);
      }
    },
  };
}

function createWriteOperations(options: SandboxToolkitOptions): WriteOperations {
  const { api, target } = options;
  return {
    async writeFile(path, content, writeOptions) {
      try {
        const written = await api.putFile(
          target.endpoint,
          target.authToken,
          path,
          Readable.from([Buffer.from(content, "utf8")]),
          writeOptions?.signal === undefined ? {} : { signal: writeOptions.signal },
        );
        return { bytes: written.size, sha256: written.sha256, path: written.path };
      } catch (error) {
        throw toFileOperationError(error, path);
      }
    },
  };
}

function createLsOperations(options: SandboxToolkitOptions): BuiltinToolOperations["ls"] {
  const { api, target } = options;
  return {
    async list(path, listOptions): Promise<LsResult> {
      try {
        const listing = await api.listFiles(target.endpoint, target.authToken, path, {
          depth: listOptions.depth,
          ...(listOptions.signal === undefined ? {} : { signal: listOptions.signal }),
        });
        return { path: listing.path, entries: listing.entries, truncated: listing.truncated };
      } catch (error) {
        throw toFileOperationError(error, path);
      }
    },
  };
}

// ---------------------------------------------------------------- 错误翻译

/** 沙箱错误码 → runtime 的错误码。**这是两个系统之间的词汇表**（唯一一处）。 */
const FILE_ERROR_CODES: Record<string, FileErrorCode> = {
  path_out_of_bounds: "path_out_of_bounds",
  not_found: "not_found",
  is_directory: "is_directory",
  not_directory: "not_directory",
  invalid_utf8: "invalid_utf8",
  too_large: "too_large",
  invalid_range: "invalid_range",
  busy: "busy",
  permission_denied: "denied",
};

/**
 * 沙箱的结构化错误 → `FileOperationError`。
 * **认不出的错误也带 path**：工具层的提示要能指出是哪个文件出的事。
 */
export function toFileOperationError(error: unknown, path: string): FileOperationError {
  const typed = error as { agentError?: string | null; message?: string };
  const agentError = typeof typed.agentError === "string" ? typed.agentError : null;
  const message = typeof typed.message === "string" ? typed.message : String(error);
  const code = agentError === null ? "unknown" : (FILE_ERROR_CODES[agentError] ?? "unknown");
  return new FileOperationError(code, message, { details: { path }, cause: error });
}
