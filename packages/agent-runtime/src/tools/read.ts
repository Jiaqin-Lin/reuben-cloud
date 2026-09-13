/**
 * `read.ts` —— 按**行**读文件（Phase 11 §3.5 的核心；Phase 1 迁入并 Operations 化）。
 *
 * 【为什么这一层在 runtime，不在执行后端】沙箱的 `GET /files` 是**字节**语义（它还要
 * 服务 `raw=1` 的 patch/tar/二进制），"行"只对模型有意义。所以"字节 ↔ 行"的翻译只发生在
 * 这里；沙箱不需要知道"行"是什么。Phase 1 把"文件从哪来"抽成 `ReadOperations`：
 * 换执行后端（远程沙箱 M1、本地裸跑测试）时这一层一个字不用改。
 *
 * 【两条路径】
 *  ① 小文件（不超过后端内联上限）：一次普通读拿全文，本地切。
 *     它顺带是"这个文件是不是合法 UTF-8"的权威判断——二进制文件在这里拿到
 *     `invalid_utf8`，而不是被解码成一片 U+FFFD 给模型看。
 *  ② 大文件：`readBytes` 的**字节窗口**（1 MiB 一个），本地用 `TextDecoder(stream)` 增量
 *     解码（跨窗口的半个字符由它兜住，和沙箱的输出合并器同一个套路）。
 *     为什么不走 ①：字节窗口会随机切在多字节字符中间，而严格校验的读会直接报错。
 *
 * 【续读锚点】大文件的第二次读（`offset=2001`）不该从字节 0 重新扫。锚点记下"这次返回的
 * **最后一行**是第几行、它的起始字节偏移是多少"，下一次 `offset=` 命中就直接从那里接着扫。
 * 没有它，读完一个 10 MB 文件是 O(n²)。（§3.5 写的是"记第一行"；这里记最后一行是同一个
 * 契约下的严格改进：同样是行首，但第一次续读就能跳过整个前缀。见 `anchors.ts`。）
 *
 * 【四种收尾形态】（§3.5，测试要点 12–16 逐条验）
 *  1. 行数先到：`[Showing lines 1-2000. Use offset=2001 to continue.]`
 *  2. 字节先到：`[Showing lines 1-742 (50KB limit). Use offset=743 to continue.]`
 *  3. 模型传的 limit 先到、后面还有：`[120 more lines in file. Use offset=321 to continue.]`
 *  4. 第一行本身就超 50 KiB：不返回半行，返回一条能直接跑的命令。
 */

import { Type, type Static } from "typebox";
import type { AgentTool, Content } from "../types.ts";
import type { ReadAnchors } from "./anchors.ts";
import { FileOperationError, ToolInputError } from "./errors.ts";
import { resolveToolPath } from "./paths.ts";
import { MAX_TOOL_BYTES, MAX_TOOL_LINES, formatBytes, splitLines, truncateHead } from "./truncate.ts";

/**
 * 文件读取出口。**窄接口**：只有这两个方法，换后端不动工具逻辑。
 *
 * `readFile` 读不出（不存在 / 越界 / 二进制 / 太大）时抛 `FileOperationError`；
 * `readBytes` 只按偏移取字节，不做任何解码。
 */
export interface ReadOperations {
  /** 读整个文件（UTF-8）。 */
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<string>;
  /** 读一个字节窗口。返回的字节数 < limit = 读到了文件尾。 */
  readBytes(path: string, offset: number, limit: number, options?: { signal?: AbortSignal }): Promise<Buffer>;
}

/** 大文件的字节窗口（§3.5：一个窗口 1 MiB）。 */
export const READ_WINDOW_BYTES = 1024 * 1024;

/**
 * 单行的长度上限。超过它的行永远装不进 50 KiB 的预算，继续攒着只会白占内存
 * （minified 的 JS 就是一行几十 MB——这不是假想的情况）。
 * 到顶时抛 `LineTooLongError`：调用方要么给出那条 `sed -n` 提示，
 * 要么把这一行当成"放不下"从而停在它前面。
 */
export const MAX_LINE_BYTES = 1024 * 1024;

const readSchema = Type.Object(
  {
    path: Type.String({ description: "File path, relative to the repository root (or absolute)." }),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start from, 1-indexed (default 1)." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to return (capped at 2000)." })),
  },
  { additionalProperties: false },
);

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolOptions {
  /** 模型心里的工作目录（相对路径按它解析）。 */
  cwd: string;
  operations: ReadOperations;
  /** 续读锚点表。缺省每个工具一个（一个 Run 一份）。 */
  anchors?: ReadAnchors;
}

export function createReadTool(options: ReadToolOptions): AgentTool<typeof readSchema, undefined> {
  return {
    name: "read",
    label: "read",
    description:
      "Read a text file. Output is truncated to 2000 lines or 50KB, whichever comes first. " +
      "Use offset (1-indexed line number) and limit (max lines) for large files; " +
      "continue with the offset printed in the truncation notice until the file is complete. " +
      "path is relative to the repository root unless it starts with /. " +
      "Do not use read on binary files — use bash for those.",
    parameters: readSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal): Promise<{ content: Content[]; details: undefined }> {
      // 失败**抛异常**：循环把它转成 isError 结果（工具不自己编码错误，见 `AgentTool.execute`）。
      const text = await runRead(params, options, signal);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

/** 读的实现（从 M0 的 `runRead` 迁入；返回给模型的文本，失败抛异常）。 */
export async function runRead(
  input: ReadToolInput,
  options: ReadToolOptions,
  signal?: AbortSignal,
): Promise<string> {
  const absPath = resolveToolPath(input.path, options.cwd);
  const offset = input.offset ?? 1;
  // `limit` 只能往小了调：截断发生在行数上，offset 不是解锁开关（§3.5）。
  const rawLimit = input.limit;
  const limit = Math.min(rawLimit ?? MAX_TOOL_LINES, MAX_TOOL_LINES);
  // 只有"模型自己传的 limit 就是天花板"时，提示才用形态 3（"还有 N 行"）。
  const requestedLimit = rawLimit !== undefined && rawLimit <= MAX_TOOL_LINES ? rawLimit : null;

  const inline = await readInline(absPath, options.operations, signal);
  if (inline !== null) return readFromText(absPath, inline, offset, limit, requestedLimit);
  return await readPaged(absPath, offset, limit, requestedLimit, options, signal);
}

// ---------------------------------------------------------------- 路径 ①：全文

/** 返回 null = 文件太大（走分片路径）；其余错误原样抛给调用方翻译。 */
async function readInline(
  absPath: string,
  operations: ReadOperations,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  try {
    return await operations.readFile(absPath, signal === undefined ? {} : { signal });
  } catch (error) {
    if (error instanceof FileOperationError && error.code === "too_large") return null;
    throw error;
  }
}

/** 全文在手：直接按行切（总行数已知，所以提示里能写"还有 N 行"）。 */
function readFromText(
  absPath: string,
  text: string,
  offset: number,
  limit: number,
  requestedLimit: number | null,
): string {
  const lines = splitLines(text);
  const total = lines.length;
  if (total === 0) {
    if (offset === 1) return `(empty file: ${absPath})`;
    throw new ToolInputError(offsetBeyondMessage(offset, 0));
  }
  if (offset > total) throw new ToolInputError(offsetBeyondMessage(offset, total));

  const slice = lines.slice(offset - 1).join("\n");
  const trimmed = truncateHead(slice, { maxLines: limit, maxBytes: MAX_TOOL_BYTES });
  if (trimmed.firstLineExceedsLimit) {
    // 全文在手：这一行的长度是**准确**的（分片路径只能给"超过多少"）。
    return firstLineTooBigNotice(offset, Buffer.byteLength(lines[offset - 1]!), absPath, "exact");
  }

  const content = trimmed.content;
  if (!trimmed.truncated) return content;

  const from = offset;
  const to = offset + trimmed.outputLines - 1;
  const notice = buildNotice({ from, to, truncatedBy: trimmed.truncatedBy, requestedLimit, totalLines: total, absPath });
  if (notice === null) return content;
  return content === "" ? notice : `${content}\n\n${notice}`;
}

// ---------------------------------------------------------------- 路径 ②：分片

interface PagedOptions {
  cwd: string;
  operations: ReadOperations;
  anchors?: ReadAnchors;
}

async function readPaged(
  absPath: string,
  offset: number,
  limit: number,
  requestedLimit: number | null,
  options: PagedOptions,
  signal: AbortSignal | undefined,
): Promise<string> {
  const anchor = options.anchors?.get(absPath) ?? null;
  const usable = anchor !== null && anchor.lineNumber <= offset ? anchor : null;
  const startOffset = usable?.byteOffset ?? 0;
  const startLine = usable?.lineNumber ?? 1;

  const iterator = scanLines(windowReader(absPath, options.operations, signal), startOffset, startLine, READ_WINDOW_BYTES);

  const lines: string[] = [];
  let bytes = 0;
  let last: { lineNumber: number; byteOffset: number } | null = null;
  let stoppedByBudget = false;
  let firstLineTooBig: number | null = null;
  let tooLongLine: number | null = null;
  let lastLineNumber = startLine - 1;
  let reachedEnd = false;

  try {
    for await (const scanned of iterator) {
      lastLineNumber = scanned.number;
      if (scanned.number < offset) continue; // 锚点之后的跳行
      const lineBytes = Buffer.byteLength(scanned.line) + (lines.length === 0 ? 0 : 1);
      if (lines.length === 0 && lineBytes > MAX_TOOL_BYTES) {
        firstLineTooBig = lineBytes;
        break;
      }
      if (lines.length >= limit || bytes + lineBytes > MAX_TOOL_BYTES) {
        // 这一行放不下了：它**存在**，所以"后面还有内容"是确定的。
        stoppedByBudget = true;
        break;
      }
      // 锚点记**最后一行**：下一次 offset 续读（最典型的读法）直接跳到那里，
      // 不用把前面的行再扫一遍。
      last = { lineNumber: scanned.number, byteOffset: scanned.byteOffset };
      lines.push(scanned.line);
      bytes += lineBytes;
    }
    reachedEnd = !stoppedByBudget;
  } catch (error) {
    if (isDecodeError(error)) {
      throw new FileOperationError(
        "invalid_utf8",
        `这个文件不是合法 UTF-8（二进制文件？）：${absPath}。二进制内容请用 bash 处理（head -c / xxd），不要用 read。`,
      );
    }
    if (error instanceof LineTooLongError) {
      // 一行超过 `MAX_LINE_BYTES`。两种收尾，都**不返回半行**：
      //  · 它就是我们要的第一行 → 给那条能直接跑的 `sed -n` 命令；
      //  · 前面已经有内容 → 把它当成"这一行放不下"（它确实不可能装进 50 KiB），
      //    于是提示里的 `offset=N` 正好指向它，下一次读就会走到上面那个分支。
      if (lines.length === 0) firstLineTooBig = error.bytes;
      else {
        stoppedByBudget = true;
        tooLongLine = error.lineNumber;
      }
      reachedEnd = false;
    } else {
      throw error;
    }
  }

  if (firstLineTooBig !== null) {
    return firstLineTooBigNotice(offset, firstLineTooBig, absPath, "at-least");
  }

  // 一行都没读到 = 这次扫描一路走到了文件尾：要么 offset 超出行数，要么文件是空的。
  if (lines.length === 0) {
    if (offset === 1) return `(empty file: ${absPath})`;
    throw new ToolInputError(offsetBeyondMessage(offset, lastLineNumber));
  }

  if (last !== null) options.anchors?.set(absPath, last);

  const content = lines.join("\n");
  const from = offset;
  const to = offset + lines.length - 1;
  // **总行数只在这次已经读到文件尾时才写**（§3.5）：否则要为了一个数字把全文数一遍。
  const totalLines = reachedEnd ? lastLineNumber : null;
  const notice = buildNotice({
    from,
    to,
    // 行数上限、或者"下一行本身就长到装不下" → 形态 1（措辞是中性的）；
    // 只有真的撞上 50 KiB 预算时才用形态 2 的 `(50KB limit)`。
    truncatedBy: reachedEnd ? null : lines.length >= limit || tooLongLine !== null ? "lines" : "bytes",
    requestedLimit,
    totalLines,
    absPath,
  });
  return notice === null ? content : `${content}\n\n${notice}`;
}

// ---------------------------------------------------------------- 逐行扫描

export interface ScannedLine {
  /** 行内容（不含换行符）。 */
  line: string;
  /** 行号（1 起）。 */
  number: number;
  /** 这一行的第一个字节在文件里的偏移（续读锚点用它）。 */
  byteOffset: number;
}

/** 读一个字节窗口。`eof` = 这个窗口就是文件的结尾（短读即 EOF）。 */
export type WindowReader = (offset: number, limit: number) => Promise<{ bytes: Buffer; eof: boolean }>;

/**
 * 从 `startOffset` 开始按行走，逐行 yield。**编码用 `fatal: true`**：
 * 不是合法 UTF-8 时直接抛（调用方翻译成"这是二进制文件"），而不是给模型看一片 U+FFFD。
 * 跨窗口的半个字符由 `{stream:true}` 兜住；窗口总是从一个行首（或文件头）开始，
 * 所以不存在"开头是半个字符"的问题——续读锚点记的就是行首。
 *
 * 单行超过 `maxLineBytes` 时抛 `LineTooLongError`（内存上限，见 `MAX_LINE_BYTES`）。
 */
export async function* scanLines(
  read: WindowReader,
  startOffset: number,
  startLine: number,
  windowBytes: number,
  options: { maxLineBytes?: number } = {},
): AsyncGenerator<ScannedLine, void, undefined> {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "";
  let lineNumber = startLine;
  let lineStart = startOffset;
  let offset = startOffset;

  for (;;) {
    const window = await read(offset, windowBytes);
    if (window.bytes.length > 0) {
      offset += window.bytes.length;
      const text = decoder.decode(window.bytes, { stream: !window.eof });
      let consumed = 0;
      for (;;) {
        const newline = text.indexOf("\n", consumed);
        if (newline < 0) break;
        const line = carry + text.slice(consumed, newline);
        yield { line, number: lineNumber, byteOffset: lineStart };
        lineNumber += 1;
        lineStart += Buffer.byteLength(line) + 1; // +1 = 换行符本身
        consumed = newline + 1;
        carry = "";
      }
      carry += text.slice(consumed);
      if (Buffer.byteLength(carry) > maxLineBytes) {
        throw new LineTooLongError(lineNumber, lineStart, Buffer.byteLength(carry));
      }
    }
    if (window.eof || window.bytes.length === 0) break;
  }

  if (carry !== "") yield { line: carry, number: lineNumber, byteOffset: lineStart };
}

/** `ReadOperations.readBytes` → `WindowReader`。短读（返回字节数 < 请求的）就是 EOF。 */
function windowReader(absPath: string, operations: ReadOperations, signal: AbortSignal | undefined): WindowReader {
  return async (offset, limit) => {
    const bytes = await operations.readBytes(absPath, offset, limit, signal === undefined ? {} : { signal });
    return { bytes, eof: bytes.length < limit };
  };
}

/** TextDecoder(fatal) 的非法字节 → TypeError。 */
function isDecodeError(error: unknown): boolean {
  return error instanceof TypeError;
}

/** 一行的字节数超过了扫描器的内存上限（`MAX_LINE_BYTES`）。 */
export class LineTooLongError extends Error {
  readonly lineNumber: number;
  readonly byteOffset: number;
  /** 已经攒到（至少）多少字节。**不是这一行的真实长度**——真实长度可能大得多。 */
  readonly bytes: number;

  constructor(lineNumber: number, byteOffset: number, bytes: number) {
    super(`第 ${lineNumber} 行超过扫描上限`);
    this.name = "LineTooLongError";
    this.lineNumber = lineNumber;
    this.byteOffset = byteOffset;
    this.bytes = bytes;
  }
}

// ---------------------------------------------------------------- 提示

interface NoticeInput {
  from: number;
  to: number;
  /** `null` = 没被切（这次读到了文件尾，或刚好读完）。 */
  truncatedBy: "lines" | "bytes" | null;
  /** 模型自己传的 limit（没传是 null）。 */
  requestedLimit: number | null;
  /** 读到文件尾时才知道总行数（不知道就是 null）。 */
  totalLines: number | null;
  absPath: string;
}

/** 四种形态里除"第一行超预算"之外的三种。返回 null = 没有截断，不需要提示。 */
function buildNotice(input: NoticeInput): string | null {
  if (input.truncatedBy === null) return null;
  const next = input.to + 1;
  // 形态 3：模型自己传的 limit 先到。总行数已知时给出"还剩多少行"，不知道就用通用说法。
  if (input.requestedLimit !== null && input.truncatedBy === "lines") {
    const more = input.totalLines === null ? null : input.totalLines - input.to;
    return more === null
      ? `[More lines available. Use offset=${next} to continue.]`
      : `[${more} more lines in file. Use offset=${next} to continue.]`;
  }
  if (input.truncatedBy === "bytes") {
    return `[Showing lines ${input.from}-${input.to} (${formatBytes(MAX_TOOL_BYTES)} limit). Use offset=${next} to continue.]`;
  }
  return `[Showing lines ${input.from}-${input.to}. Use offset=${next} to continue.]`;
}

/**
 * 形态 4：一行本身就超预算。**不返回半行**，返回一条可以直接跑的命令
 * （`bash` 工具本来就在，不需要为这个分支发明新机制——§3.5 的原话）。
 */
function firstLineTooBigNotice(
  lineNumber: number,
  bytes: number,
  absPath: string,
  precision: "exact" | "at-least",
): string {
  const file = shellQuote(absPath);
  const size = precision === "exact" ? `is ${formatBytes(bytes)}` : `is over ${formatBytes(bytes)}`;
  return (
    `[Line ${lineNumber} ${size}, exceeds ${formatBytes(MAX_TOOL_BYTES)} limit. ` +
    `Use bash: sed -n '${lineNumber}p' ${file} | head -c ${MAX_TOOL_BYTES}]`
  );
}

function offsetBeyondMessage(offset: number, totalLines: number): string {
  return `Offset ${offset} is beyond end of file (${totalLines} lines total)`;
}

/** 提示里回显的路径要能直接粘进 shell：用单引号并在内部转义单引号。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
