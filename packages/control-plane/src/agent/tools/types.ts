/**
 * `tools/types.ts` —— 四个工具共用的契约：沙箱出口（port）、上下文、参数校验。
 *
 * 【为什么单独一个文件（不在 spec 的交付物清单里）】四个工具要共用三样东西：
 *  ① 两个 port（`ExecPort` / `SandboxFilesPort`）——**沙箱出口只有一个**，
 *     不允许 bash 自己 fetch、read 自己 fetch；
 *  ② 参数校验与错误翻译——四个工具的参数形状几乎一样，校验失败必须是
 *     `is_error:true` 的 tool_result 而不是异常（§3：让模型自己改）；
 *  ③ 大文件续读的锚点缓存——`read` 写它、`write`/`bash` 失效它。
 * 塞进任何一个工具都会让剩下三个 import 那个工具（并且迟早互相 import）。
 * 先例：Phase 1 的 `config.ts` / `paths.ts` 也是"清单里没有但必须有"的文件。
 *
 * 【port 为什么是窄接口而不是直接写 `SandboxManager`】`SandboxManager` 结构上就满足
 * `ExecPort`（不需要 `implements`），`SandboxApiClient` 结构上就满足 `SandboxFilesPort`。
 * 定义这两个 port 不是为了可插拔，是为了让工具层的单测能在**没有 Docker、没有 DB**
 * 的情况下跑（`repo/types.ts` 的 `RepoApi` 是同一个做法、同一个理由）。
 */

import type { Readable } from "node:stream";
import path from "node:path";
import type { AgentFileList, AgentFileRead, AgentFileWrite, SandboxApiError } from "../../client/sandbox-api.ts";
import type { SseEvent } from "../../client/sse.ts";
import type { LogFn } from "../../log.ts";
import type { SandboxTarget } from "../../repo/types.ts";

// ---------------------------------------------------------------- 沙箱出口

/** `bash` 的出口：跑一条命令并等终态。字段与 `SandboxManager.execInSandbox` 的请求一致。 */
export interface ToolExecRequest {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * 执行结果里工具层真正用到的字段。**与 `ExecInSandboxResult` 是同一份事实**，
 * 这里再写一遍是为了不把 manager 拖进工具层的类型依赖里（结构上兼容）。
 */
export interface ToolExecResult {
  executionId: string;
  /** completed / failed / timeout / killed。 */
  state: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  /** 事件流里丢了内容（完整输出在 `logPath`）。 */
  truncated: boolean;
  /** 连日志文件都到顶了（256 MiB），`logPath` 也不是完整输出。 */
  logTruncated?: boolean;
  logPath: string | null;
  events: SseEvent[];
}

export interface ExecPort {
  execInSandbox(sandboxId: string, request: ToolExecRequest): Promise<ToolExecResult>;
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
  ): Promise<Readable>;
}

// ---------------------------------------------------------------- 续读锚点

/**
 * 大文件按行续读的锚点：**某一行在文件里的起始字节偏移**。
 *
 * 【它解决什么】`read(path, {offset: 5000})` 如果每次都从 0 开始扫，那么读完一个
 * 10 MB 文件会变成 O(n²)（读第 5 片要把前 4 片再扫一遍）。锚点让我们从"上次返回的
 * 第一行"直接跳到对应字节，只数剩下的行。
 *
 * 【为什么没有 mtime】沙箱的 `GET /files` 不返回 mtime（只有 `/files/list` 有），
 * 而为了取 mtime 多打一次请求，比"失效时机明确"更不划算。失效规则是**穷尽的**：
 * 能够改动文件内容的只有 `write`（失效那一个路径）与 `bash`（清空整张表）——
 * 模型的全部写入口就是这两个。这个约定写在 `write.ts` 与 `bash.ts` 里。
 */
export interface ReadAnchor {
  /** 锚点行是第几行（1 起）。 */
  lineNumber: number;
  /** 这一行在文件里的起始字节偏移。 */
  byteOffset: number;
}

export interface ReadAnchors {
  get(path: string): ReadAnchor | null;
  set(path: string, anchor: ReadAnchor): void;
  invalidate(path: string): void;
  clear(): void;
}

/** LRU 锚点表（一个 Run 一份，默认 8 个文件）。 */
export function createReadAnchors(limit = 8): ReadAnchors {
  const entries = new Map<string, ReadAnchor>();
  return {
    get(path) {
      const found = entries.get(path);
      if (found === undefined) return null;
      // 命中就挪到队尾（Map 保持插入序 = LRU 顺序）。
      entries.delete(path);
      entries.set(path, found);
      return found;
    },
    set(path, anchor) {
      entries.delete(path);
      entries.set(path, anchor);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    invalidate(path) {
      entries.delete(path);
    },
    clear() {
      entries.clear();
    },
  };
}

// ---------------------------------------------------------------- 上下文

/**
 * 工具运行时拿到的一切。**`repoDir` 与 `anchors` 由 `createToolkit` 补齐**，
 * 所以工具实现里它们一定存在（不用写 `?.`，也就不会漏掉）。
 */
export interface ToolContext {
  sandboxId: string;
  exec: ExecPort;
  api: SandboxFilesPort;
  target: SandboxTarget;
  /** 模型心里的工作目录。四个工具的 path 都按它解成绝对路径。 */
  repoDir: string;
  anchors: ReadAnchors;
  signal?: AbortSignal;
  log: LogFn;
}

// ---------------------------------------------------------------- 结果与错误

/** tool_result 的内容。`isError` 会被翻译成 Anthropic 的 `is_error`。 */
export interface ToolResult {
  content: string;
  isError: boolean;
}

export function ok(content: string): ToolResult {
  return { content, isError: false };
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * 参数校验失败。**不是异常路径**：工具层把它翻译成 `is_error:true` 的 tool_result，
 * 让模型自己改参数（§3 的原话：校验失败不要抛异常）。
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError(`参数必须是一个对象，收到的是 ${describeType(input)}`);
  }
  return input as Record<string, unknown>;
}

export interface StringOptions {
  allowEmpty?: boolean;
  maxLength?: number;
}

export function requireString(record: Record<string, unknown>, field: string, options: StringOptions = {}): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new ToolInputError(`参数 ${field} 必填，且必须是字符串（收到 ${describeType(value)}）`);
  }
  if (value === "" && options.allowEmpty !== true) {
    throw new ToolInputError(`参数 ${field} 不能是空字符串`);
  }
  const maxLength = options.maxLength ?? 16 * 1024 * 1024;
  if (value.length > maxLength) {
    throw new ToolInputError(`参数 ${field} 太长（${value.length} 字符，上限 ${maxLength}）`);
  }
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  field: string,
  options: StringOptions = {},
): string | undefined {
  if (record[field] === undefined || record[field] === null) return undefined;
  return requireString(record, field, options);
}

export interface IntegerOptions {
  min?: number;
  max?: number;
}

export function optionalInteger(
  record: Record<string, unknown>,
  field: string,
  options: IntegerOptions = {},
): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolInputError(`参数 ${field} 必须是整数（收到 ${describeType(value)}）`);
  }
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    throw new ToolInputError(`参数 ${field} 必须在 ${min}..${max} 之间（收到 ${value}）`);
  }
  return value;
}

/**
 * `cmd` 校验：非空字符串数组，每项不含 NUL。**不接受字符串**——"cmd 是 argv 数组
 * 不是 shell 字符串"是提示词里的一条规矩，这里是它的执行点。写错时给出可执行的
 * 转写建议（模型最常见的错误是把 `ls -la` 当一个字符串传进来）。
 */
export function requireStringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (typeof value === "string") {
    throw new ToolInputError(
      `参数 ${field} 是 argv 数组，不是 shell 字符串。要跑 "${value}" 请写 ["bash","-lc","${value.replaceAll('"', '\\"')}"]`,
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolInputError(`参数 ${field} 必须是非空字符串数组（收到 ${describeType(value)}）`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ToolInputError(`参数 ${field} 的每一项都必须是字符串（收到 ${describeType(item)}）`);
    }
    if (item.includes("\0")) {
      throw new ToolInputError(`参数 ${field} 不能含 NUL 字节`);
    }
  }
  return [...value];
}

/**
 * 把模型给的 path 解成绝对路径。
 *
 * 【为什么必须做】沙箱的路径校验以 **workspace 根**（`/workspace`）为相对基准，
 * 而模型心里的 cwd 是 `REPO_DIR`（`/workspace/repo`）。不翻译的话
 * `read("src/a.ts")` 会静默变成 `/workspace/src/a.ts`——一个"读了另一个文件"
 * 的 bug，而且它不会报错。绝对路径原样通过（沙箱那边还要再校验一次越界）。
 */
export function resolveToolPath(record: Record<string, unknown>, context: { repoDir: string }): string {
  const raw = requireString(record, "path", { allowEmpty: false });
  // path.resolve 在第二个参数是绝对路径时会忽略第一个——这正是要的语义。
  // 沙箱侧还会再校验一次越界（这里只是把模型心里的 cwd 翻译成沙箱的 cwd）。
  return path.resolve(context.repoDir, raw);
}

/**
 * 异常 → 工具结果。**沙箱的结构化错误码在这里变成人话**——模型看到
 * `path_out_of_bounds` 只会瞎猜，看到"path 只能落在 /workspace 之下"才知道怎么改。
 */
export function toolFailure(error: unknown): ToolResult {
  if (error instanceof ToolInputError) return fail(error.message);
  const hint = sandboxErrorHint(error);
  if (hint !== null) return fail(hint);
  return fail(error instanceof Error ? error.message : String(error));
}

/** 沙箱错误码 → 可执行的提示。认不出就返回 null（交给调用方给原始信息）。 */
export function sandboxErrorHint(error: unknown): string | null {
  const typed = error as Partial<SandboxApiError> & { message?: string };
  const agentError = typed.agentError ?? null;
  if (agentError === null) return null;
  const details = typed.details ?? {};
  switch (agentError) {
    case "path_out_of_bounds":
      return "路径越界：读只能落在 /workspace 与 /tmp/reuben-cloud 之下，写只能落在 /workspace 之下。相对路径按工作目录解析。";
    case "not_found":
      return `文件不存在：${String(details["path"] ?? "")}`.trim();
    case "is_directory":
      return "这是一个目录，用 list 工具列它，或者 read 一个具体文件。";
    case "not_directory":
      return "这不是一个目录（list 只能列目录）。";
    case "invalid_utf8":
      return "这个文件不是合法 UTF-8（二进制文件？）。二进制内容请用 bash 处理（例如 xxd / head -c），不要用 read。";
    case "too_large":
      return "文件太大，超过沙箱的内联读上限。用 offset/limit 分片读。";
    case "invalid_range":
      return "offset/limit 不合法（offset 不能是负数，limit 必须是正数）。";
    case "busy":
      return "沙箱正忙：同一个沙箱同一时间只允许一条命令。等这一条结束再试。";
    case "invalid_cwd":
    case "timeout_exceeds_max":
    case "invalid_timeout":
    case "invalid_max_output_bytes":
    case "invalid_cmd":
    case "body_too_large":
      return typed.message ?? `沙箱拒绝了这次请求（${agentError}）`;
    default:
      return typed.message ?? `沙箱返回错误：${agentError}`;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}
