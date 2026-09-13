/**
 * `bash.ts` —— 在沙箱里跑一条命令（Phase 11 §3 的第一行）。
 *
 * 【工具结果从哪来】不是事件流，是**沙箱自己的 exec 日志**（`/tmp/reuben-cloud/exec/<id>.log`）。
 * 三个理由：
 *  ① 事件流把 stdout / stderr 分成两类事件，拼起来会把"终端里看到的样子"还原错；
 *     日志文件本来就是交错写的（Phase 1 定的）。
 *  ② 事件流有 1 MiB 的内联上限（`maxOutputBytes`），超了就没有正文了；日志文件有完整的。
 *  ③ 我们只要**结尾**（报错和最终结果在结尾），而"读一个文件的最后一段"可以精确做到。
 *
 * 【只读尾部怎么保证够用】预算上限是 50 KiB（§3.5），窗口取它的 5 倍（256 KiB）。
 * 于是"窗口里的内容按行切完还剩不到 50 KiB"这件事只会在**最后一行本身超过 256 KiB**
 * 时发生——那时 `truncateTail` 的 `lastLinePartial` 分支会从行尾取够 50 KiB，
 * 结果仍然是"最后 50 KiB"。换句话说：窗口大小不影响正确性，只影响能不能报出绝对行号。
 *
 * 【绝对行号 vs 相对行号】日志整个落在窗口里（`windowStart === 0`）时能报
 * `Showing lines 1001-3000 of 3000`；否则只报 `Showing the last N lines`——
 * 报绝对行号需要把整个日志数一遍，那与"不为了一个数字去扫全文"（§3.5）冲突。
 *
 * 【非 0 退出不是 is_error】Phase 1 §7 的规矩：退出码的语义属于调用方。这里是模型，
 * 所以让它自己判断；工具只在**根本没跑起来**（`failed`）时给 `is_error:true`，
 * 非 0 退出在结尾加一行 `[exit 1]`。
 */

import { MAX_TOOL_BYTES, MAX_TOOL_LINES, formatBytes, truncateTail } from "./truncate.ts";
import path from "node:path";
import type { ToolContext, ToolExecResult, ToolResult } from "./types.ts";
import { asRecord, fail, ok, optionalInteger, optionalString, requireStringArray, toolFailure } from "./types.ts";
import type { ToolDefinition } from "../model.ts";

/** `bash` 的默认时限与沙箱侧一致（Phase 1 §4）。 */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** 读日志尾部的字节窗口：50 KiB 预算的 5 倍，理由见文件头。 */
export const TAIL_WINDOW_BYTES = 256 * 1024;

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a command in the sandbox and return the tail of its output (stdout and stderr interleaved). " +
    'cmd is an argv array, NOT a shell string: use ["npm","test"] directly, and only wrap in ' +
    '["bash","-lc","…"] when you need pipes, redirection, globs or &&. There is no interactive ' +
    "stdin: commands that wait for input (npm init, an editor, git commit without -m) fail immediately — " +
    "pass -y or the equivalent flag. A non-zero exit code is NOT an error, it is reported as [exit N]. " +
    "At most the last 2000 lines / 50KB come back; when output is cut, the notice carries the path of " +
    "the full log so you can continue with the read tool.",
  input_schema: {
    type: "object",
    properties: {
      cmd: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: 'Command as an argv array, e.g. ["npm","test"] or ["bash","-lc","npm test 2>&1 | tail -50"].',
      },
      cwd: {
        type: "string",
        description: "Working directory. Relative paths are resolved against the repository root.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 600_000,
        description: "Timeout in milliseconds (default 120000, hard maximum 600000).",
      },
    },
    required: ["cmd"],
  },
};

export async function runBash(input: unknown, context: ToolContext): Promise<ToolResult> {
  try {
    const record = asRecord(input);
    const cmd = requireStringArray(record, "cmd");
    const cwd = optionalString(record, "cwd");
    const timeoutMs = optionalInteger(record, "timeoutMs", { min: 1, max: 600_000 });
    if (cmd[0] !== undefined && cmd[0].includes("=")) {
      // `FOO=1 cmd` 是 shell 语法。argv 模式下它会去找一个叫 "FOO=1" 的可执行文件，
      // 报出来的是 ENOENT——跟真正的原因隔了一层。提前说清楚。
      return fail(
        `cmd 的第一项是 ${JSON.stringify(cmd[0])}，看起来像 shell 的 "VAR=value cmd" 写法。` +
          `argv 模式下请用 ["bash","-lc","${cmd.join(" ").replaceAll('"', '\\"')}"]，` +
          `或者在命令里显式 export。`,
      );
    }

    const result = await context.exec.execInSandbox(context.sandboxId, {
      cmd,
      // **cwd 一律显式给**：沙箱的默认 cwd 是 workspace 根（`/workspace`），而模型
      // 心里的工作目录是仓库根（`/workspace/repo`）。不给的话 `node test.js` 会在
      // `/workspace` 里找不到文件——报出来的 ENOENT 与真正的原因隔着一层。
      cwd: cwd === undefined ? context.repoDir : resolveCwd(cwd, context),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    // bash 能改任何文件——续读锚点必须整表失效（见 `read.ts` 的文件头）。
    context.anchors.clear();

    if (result.state === "failed") {
      // 命令根本没起来（ENOENT / 权限 / cwd 不存在）。这是**工具失败**，不是"退出码非 0"。
      const detail = tailOf(collectEvents(result));
      return fail(`沙箱没能启动这条命令（${cmd[0] ?? ""}）：${detail === "" ? "没有更多信息" : detail}`);
    }

    const body = await readOutputTail(result, context);
    return ok(composeBashResult(result, body, timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS));
  } catch (error) {
    return toolFailure(error);
  }
}

/** 相对 cwd 按仓库根解析（与 path 参数同一条规矩）。 */
function resolveCwd(cwd: string, context: ToolContext): string {
  return path.resolve(context.repoDir, cwd);
}

interface OutputTail {
  content: string;
  /** 展示的内容被切过（不等于沙箱侧的输出被截断）。 */
  truncated: boolean;
  /** 读到的窗口起始字节偏移（0 = 整个日志都在窗口里）。 */
  windowStart: number;
  /** 日志总字节数（拿不到就是 null）。 */
  logBytes: number | null;
  /** 读到文件尾时才有值：日志总行数。 */
  totalLines: number | null;
  /** 最后一行本身超预算，内容是从行尾截的。 */
  lastLinePartial: boolean;
  outputLines: number;
  /** 日志读不回来时的原因（此时 content 来自事件流）。 */
  logError: string | null;
}

/**
 * 取输出的尾部。**优先读日志文件**（交错、完整）；读不回来才退回事件流
 * （`logPath` 为 null，或日志已经不在了——agent 重启会清 tmpfs）。
 */
async function readOutputTail(result: ToolExecResult, context: ToolContext): Promise<OutputTail> {
  const logPath = result.logPath;
  if (logPath === null || logPath === "") {
    return { ...fromEvents(result.events), logError: null };
  }
  try {
    return await readLogTail(logPath, context);
  } catch (error) {
    // 日志读不回来不是命令失败：事件流里仍然有前 1 MiB。降级并把原因写进结果，
    // 让模型知道"这段可能不完整"，而不是把一次成功的命令报成失败。
    const reason = error instanceof Error ? error.message : String(error);
    context.log("warn", `bash 读不回执行日志，退回事件流内容`, { logPath, error: reason });
    return { ...fromEvents(result.events), logError: reason };
  }
}

async function readLogTail(logPath: string, context: ToolContext): Promise<OutputTail> {
  const { endpoint, authToken } = context.target;
  // ① 先要长度：`readFile` 的响应带文件总字节数（只读 1 个字节，白拿 size）。
  const probe = await context.api.readFile(endpoint, authToken, logPath, {
    offset: 0,
    limit: 1,
    signal: context.signal,
  });
  const size = probe.size;
  // **空日志直接返回**：命令一行输出都没产生时 `size = 0`，而 `limit` 必须是正数
  // （Phase 2 的 `invalid_range`）——不去发那次一定失败的请求，也就不会凭空把一次成功的
  // 命令降到事件流路径上（真跑 agent 时这条 warning 挂过一次：`git status` 输出为空的那种命令）。
  if (size === 0) {
    return {
      content: "",
      truncated: false,
      windowStart: 0,
      logBytes: 0,
      totalLines: 0,
      lastLinePartial: false,
      outputLines: 0,
      logError: null,
    };
  }
  const windowStart = Math.max(0, size - TAIL_WINDOW_BYTES);

  // ② 再读窗口。`raw=1` 不校验编码，也不会因为日志里有二进制字节而 400。
  const stream = await context.api.readRaw(endpoint, authToken, logPath, {
    offset: windowStart,
    limit: size - windowStart,
    signal: context.signal,
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

  const trimmed = truncateTail(text, { maxLines: MAX_TOOL_LINES, maxBytes: MAX_TOOL_BYTES });
  return {
    content: trimmed.content,
    truncated: windowStart > 0 || trimmed.truncated,
    windowStart,
    logBytes: size,
    // 只有从文件头开始读的窗口才知道绝对行号（见文件头）。
    totalLines: windowStart > 0 ? null : trimmed.totalLines,
    lastLinePartial: trimmed.lastLinePartial,
    outputLines: trimmed.outputLines,
    logError: null,
  };
}

/** 日志读不回来时的降级：用事件流里收到的内容（stdout 与 stderr 分开拼，时序不保证）。 */
function fromEvents(events: ToolExecResult["events"]): Omit<OutputTail, "logError"> {
  let stdout = "";
  let stderr = "";
  for (const event of events) {
    if (event.event !== "stdout" && event.event !== "stderr") continue;
    const chunk = parseChunk(event.data);
    if (chunk === null) continue;
    if (event.event === "stdout") stdout += chunk;
    else stderr += chunk;
  }
  const trimmed = truncateTail(`${stdout}${stderr}`, { maxLines: MAX_TOOL_LINES, maxBytes: MAX_TOOL_BYTES });
  // 事件流本来就只留前 1 MiB（`maxOutputBytes`），所以这里的"窗口起点 0"语义与
  // "读整个文件"一致：行号可以按绝对行号报。
  return {
    content: trimmed.content,
    truncated: trimmed.truncated,
    windowStart: 0,
    logBytes: null,
    totalLines: trimmed.totalLines,
    lastLinePartial: trimmed.lastLinePartial,
    outputLines: trimmed.outputLines,
  } satisfies Omit<OutputTail, "logError">;
}

function parseChunk(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const chunk = (parsed as Record<string, unknown>)["chunk"];
      if (typeof chunk === "string") return chunk;
    }
  } catch {
    // 半个 JSON 帧（连接断在中间）：忽略。日志文件才是权威来源。
  }
  return null;
}

/** 事件流里的文字（`failed` 的说明就在这里）。 */
function collectEvents(result: ToolExecResult): string {
  return result.events
    .filter((event) => event.event === "stdout" || event.event === "stderr")
    .map((event) => parseChunk(event.data) ?? "")
    .join("")
    .trim();
}

function tailOf(text: string, limit = 500): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`;
}

/**
 * 拼最终内容：正文 + 状态行 + 截断提示。
 *
 * 顺序是有意的：正文在最上面（模型要读的是它），状态与提示在结尾——**提示文字本身
 * 不计入 50 KiB 预算**（§3.5），而 tail 语义下"最后看到的东西"最重要。
 */
function composeBashResult(result: ToolExecResult, body: OutputTail, timeoutMs: number): string {
  const parts: string[] = [];
  parts.push(body.content.trimEnd() === "" ? "(no output)" : body.content.replace(/\s+$/, ""));

  const status = statusLine(result, timeoutMs);
  if (status !== null) parts.push(status);

  const notice = tailNotice(result, body);
  if (notice !== null) parts.push(notice);
  return parts.join("\n\n");
}

function statusLine(result: ToolExecResult, timeoutMs: number): string | null {
  if (result.state === "timeout") return `[timeout after ${timeoutMs}ms]`;
  if (result.state === "killed") return `[killed${result.signal === null ? "" : ` (${result.signal})`}]`;
  if (result.signal !== null) return `[signal ${result.signal}]`;
  if (result.exitCode !== null && result.exitCode !== 0) return `[exit ${result.exitCode}]`;
  return null;
}

/** 截断提示。三条分支：能报绝对行号 / 只能报相对行号 / 日志根本读不回来。 */
function tailNotice(result: ToolExecResult, body: OutputTail): string | null {
  if (body.logError !== null) {
    return `[Full output unavailable (${body.logError}). What you see is what the event stream kept.]`;
  }
  const logPath = result.logPath;
  const flags: string[] = [];
  if (body.lastLinePartial) flags.push(`last line truncated to ${formatBytes(MAX_TOOL_BYTES)}`);
  if (result.logTruncated === true) flags.push("log file hit the sandbox's size cap");

  if (!body.truncated) {
    // 没切，但可能有"日志到顶了"这件事要说。
    return flags.length === 0 ? null : `[${flags.join("; ")}${logPath === null ? "" : `. Full output: ${logPath}`}]`;
  }

  const scope =
    body.windowStart === 0 && body.totalLines !== null
      ? `Showing lines ${body.totalLines - body.outputLines + 1}-${body.totalLines} of ${body.totalLines}`
      : `Showing the last ${body.outputLines} lines of a ${body.logBytes === null ? "truncated" : formatBytes(body.logBytes)} log`;
  const suffix = logPath === null || logPath === "" ? "" : `. Full output: ${logPath}`;
  const flagsPart = flags.length === 0 ? "" : ` (${flags.join("; ")})`;
  return `[${scope}${flagsPart}${suffix}]`;
}
