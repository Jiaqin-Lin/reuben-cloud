/**
 * `bash.ts` —— 执行一条 shell 命令（Phase 11 §3 的第一行；Phase 1 迁入并 Operations 化）。
 *
 * 【入参从 argv 数组改成 shell 字符串（spec 附录 A-1 的偏差，这里落地）】沙箱的
 * `POST /exec` 契约**一个字没改**（仍然是 argv 数组、无隐式 shell）——这是它的红线，
 * 消灭了命令拼接注入这一整类问题。变的是**工具层**：模型给一个 shell 字符串，
 * 适配器把它包成 `["bash","-lc", command]` 再发下去。
 * 理由是模型在"shell 字符串"上的先验极强（所有主流 coding agent 都是这个形状），
 * 而 M0 的系统提示词里专门写了一条"cmd 是 argv 数组"——那是在跟模型的先验对抗，
 * 代价是大量失败的调用。安全性没有实质变化：agent 本来就能在沙箱里执行任意代码，
 * "能否用管道/重定向"不是安全边界（设计文档 §F.2 第 1 条）。
 *
 * 【工具结果从哪来】不是事件流，是后端给的**日志尾部窗口**。三个理由：
 *  ① 事件流把 stdout / stderr 分成两类事件，拼起来会把"终端里看到的样子"还原错；
 *     日志文件本来就是交错写的。
 *  ② 事件流有内联上限（沙箱是 1 MiB），超了就没有正文了；日志文件有完整的。
 *  ③ 我们只要**结尾**（报错和最终结果在结尾），而"读一个文件的最后一段"可以精确做到。
 * 读窗口的动作收在适配器里（它才知道后端的 API），工具只负责按 50 KiB 预算再切一次。
 *
 * 【绝对行号 vs 相对行号】日志整个落在窗口里（`windowStart === 0`）时能报
 * `Showing lines 1001-3000 of 3000`；否则只报 `Showing the last N lines`——
 * 报绝对行号需要把整个日志数一遍，那与"不为了一个数字去扫全文"（§3.5）冲突。
 *
 * 【非 0 退出不是 isError】退出码的语义属于调用方。这里是模型，所以让它自己判断；
 * 工具只在**根本没跑起来**（`state === "failed"`）时抛异常（→ isError 结果），
 * 非 0 退出在结尾加一行 `[exit 1]`。
 */

import { Type, type Static } from "typebox";
import type { AgentTool, Content } from "../types.ts";
import { resolveToolPath } from "./paths.ts";
import { MAX_TOOL_BYTES, MAX_TOOL_LINES, formatBytes, truncateTail } from "./truncate.ts";

/** `bash` 的默认时限与沙箱侧一致（Phase 1 §4）。 */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** 沙箱的硬上限（`POST /exec` 的 `timeoutMs` 校验）。 */
export const MAX_BASH_TIMEOUT_MS = 600_000;

/** 失败时从事件流里留的正文上限（只为一句可读的报错，不留整份输出）。 */
export const FAILURE_TAIL_BYTES = 2_000;

/** 执行出口的参数。`command` 已经是 shell 字符串（适配器负责包成 `bash -lc`）。 */
export interface BashExecOptions {
  /** 边跑边给的输出块。`stream` 保留 stdout/stderr 的类别（给 UI 上色）。 */
  onData(data: Buffer, stream: "stdout" | "stderr"): void;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** 一次执行的结果。日志窗口的读取已经由适配器做完（见文件头）。 */
export interface BashExecResult {
  exitCode: number | null;
  /** `failed` = 命令根本没起来（ENOENT / 权限 / cwd 不存在），与"退出码非 0"是两件事。 */
  state: "completed" | "failed" | "timeout" | "killed";
  signal: string | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  /** 输出尾部窗口的文本（窗口从**行首**开始；交错）。 */
  output: string;
  /** 窗口在完整日志里的起始字节偏移（> 0 表示前面的内容没看到）。 */
  windowStart: number;
  /** 完整日志的字节数（拿不到就是 null）。 */
  totalBytes: number | null;
  /** 从文件头读到尾时才知道的总行数（否则为 null）。 */
  totalLines: number | null;
  /** 完整日志的路径（写进"Full output: …"提示）。 */
  logPath: string | null;
  /** 日志文件本身到了后端的体积上限，`logPath` 也不是完整输出。 */
  logTruncated: boolean;
  /** 事件流里丢了内容。 */
  truncated: boolean;
  /** 日志读不回来时的原因（此时 `output` 来自事件流，可能不完整）。 */
  logError: string | null;
}

/**
 * 命令执行出口。**一个方法**：适配器把"发命令 + 收流 + 读日志窗口 + 翻译终态"
 * 全部收在自己那边；工具只看到最终事实与一个"尾部文本"。
 * 这样换执行后端（远程沙箱 / 本地裸跑）时工具一行不改。
 */
export interface BashOperations {
  exec(command: string, cwd: string, options: BashExecOptions): Promise<BashExecResult>;
}

const bashSchema = Type.Object(
  {
    command: Type.String({
      description:
        "Shell command to run in the repository (runs via bash -lc). " +
        'Pipes, redirection, globs and && work as usual, e.g. "npm test 2>&1 | tail -50".',
    }),
    cwd: Type.Optional(
      Type.String({ description: "Working directory, relative to the repository root (default: the root)." }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_BASH_TIMEOUT_MS,
        description: `Timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, hard maximum ${MAX_BASH_TIMEOUT_MS}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type BashToolInput = Static<typeof bashSchema>;

/** 工具结果里的结构化事实（给 UI / 日志 / P2 的 `tool_invocations.details` 用）。 */
export interface BashToolDetails {
  /** 这批内容来自哪条流（`onUpdate` 的增量用得上）。 */
  stream?: "stdout" | "stderr";
  exitCode?: number | null;
  state?: BashExecResult["state"];
  logPath?: string | null;
}

export interface BashToolOptions {
  /** 模型心里的工作目录（相对 cwd 与默认 cwd 都按它解析）。 */
  cwd: string;
  operations: BashOperations;
}

export function createBashTool(options: BashToolOptions): AgentTool<typeof bashSchema, BashToolDetails> {
  return {
    name: "bash",
    label: "bash",
    description:
      "Run a shell command in the sandbox and return the tail of its output (stdout and stderr interleaved). " +
      "There is no interactive stdin: commands that wait for input (npm init, an editor, git commit without -m) " +
      "fail immediately — pass -y or the equivalent flag. A non-zero exit code is NOT an error, it is reported " +
      "as [exit N]. At most the last 2000 lines / 50KB come back; when output is cut, the notice carries the " +
      "path of the full log so you can continue with the read tool.",
    parameters: bashSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate): Promise<{ content: Content[]; details: BashToolDetails }> {
      const result = await runBash(
        params,
        options,
        signal,
        onUpdate === undefined
          ? undefined
          : (chunk, stream) => onUpdate({ content: [{ type: "text", text: chunk }], details: { stream } }),
      );
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  };
}

/** 跑命令的实现（从 M0 的 `runBash` 改造：cmd → command，日志窗口由适配器读）。 */
export async function runBash(
  input: BashToolInput,
  options: BashToolOptions,
  signal?: AbortSignal,
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void,
): Promise<{ text: string; details: BashToolDetails }> {
  const cwd = input.cwd === undefined ? options.cwd : resolveToolPath(input.cwd, options.cwd);
  const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;

  // 失败时用得上：把事件流里的最后一段留一份（后端没给日志或日志读不回来时）。
  const recent: Buffer[] = [];
  let recentBytes = 0;
  const keepRecent = (chunk: Buffer): void => {
    recent.push(chunk);
    recentBytes += chunk.length;
    while (recentBytes > FAILURE_TAIL_BYTES && recent.length > 1) {
      recentBytes -= recent.shift()!.length;
    }
  };

  const result = await options.operations.exec(input.command, cwd, {
    onData: (data, stream) => {
      keepRecent(data);
      onOutput?.(data.toString("utf8"), stream);
    },
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });

  if (result.state === "failed") {
    const detail = Buffer.concat(recent).toString("utf8").trim();
    throw new Error(
      `沙箱没能启动这条命令：${detail === "" ? "没有更多信息" : detail.slice(-FAILURE_TAIL_BYTES)}`,
    );
  }

  const body = tailOf(result);
  return {
    text: composeBashResult(result, body, timeoutMs),
    details: { exitCode: result.exitCode, state: result.state, logPath: result.logPath },
  };
}

// ---------------------------------------------------------------- 截断与提示

interface OutputTail {
  content: string;
  /** 展示的内容被切过（不等于后端侧的输出被截断）。 */
  truncated: boolean;
  lastLinePartial: boolean;
  outputLines: number;
}

/** 按 50 KiB / 2000 行再切一次（后端给的窗口可能比这个大）。 */
function tailOf(result: BashExecResult): OutputTail {
  const trimmed = truncateTail(result.output, { maxLines: MAX_TOOL_LINES, maxBytes: MAX_TOOL_BYTES });
  return {
    content: trimmed.content,
    truncated: result.windowStart > 0 || trimmed.truncated,
    lastLinePartial: trimmed.lastLinePartial,
    outputLines: trimmed.outputLines,
  };
}

/**
 * 拼最终内容：正文 + 状态行 + 截断提示。
 *
 * 顺序是有意的：正文在最上面（模型要读的是它），状态与提示在结尾——**提示文字本身
 * 不计入 50 KiB 预算**（§3.5），而 tail 语义下"最后看到的东西"最重要。
 */
function composeBashResult(result: BashExecResult, body: OutputTail, timeoutMs: number): string {
  const parts: string[] = [];
  parts.push(body.content.trimEnd() === "" ? "(no output)" : body.content.replace(/\s+$/, ""));

  const status = statusLine(result, timeoutMs);
  if (status !== null) parts.push(status);

  const notice = tailNotice(result, body);
  if (notice !== null) parts.push(notice);
  return parts.join("\n\n");
}

function statusLine(result: BashExecResult, timeoutMs: number): string | null {
  if (result.state === "timeout") return `[timeout after ${timeoutMs}ms]`;
  if (result.state === "killed") return `[killed${result.signal === null ? "" : ` (${result.signal})`}]`;
  if (result.signal !== null) return `[signal ${result.signal}]`;
  if (result.exitCode !== null && result.exitCode !== 0) return `[exit ${result.exitCode}]`;
  return null;
}

/** 截断提示。三条分支：能报绝对行号 / 只能报相对行号 / 日志根本读不回来。 */
function tailNotice(result: BashExecResult, body: OutputTail): string | null {
  if (result.logError !== null) {
    return `[Full output unavailable (${result.logError}). What you see is what the event stream kept.]`;
  }
  const logPath = result.logPath;
  const flags: string[] = [];
  if (body.lastLinePartial) flags.push(`last line truncated to ${formatBytes(MAX_TOOL_BYTES)}`);
  if (result.logTruncated) flags.push("log file hit the sandbox's size cap");

  if (!body.truncated) {
    // 没切，但可能有"日志到顶了"这件事要说。
    return flags.length === 0 ? null : `[${flags.join("; ")}${logPath === null ? "" : `. Full output: ${logPath}`}]`;
  }

  const scope =
    result.windowStart === 0 && result.totalLines !== null
      ? `Showing lines ${result.totalLines - body.outputLines + 1}-${result.totalLines} of ${result.totalLines}`
      : `Showing the last ${body.outputLines} lines of a ${
          result.totalBytes === null ? "truncated" : formatBytes(result.totalBytes)
        } log`;
  const suffix = logPath === null || logPath === "" ? "" : `. Full output: ${logPath}`;
  const flagsPart = flags.length === 0 ? "" : ` (${flags.join("; ")})`;
  return `[${scope}${flagsPart}${suffix}]`;
}
