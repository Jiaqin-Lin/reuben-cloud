/**
 * `read.ts` —— 按**行**读文件（Phase 11 §3.5 的核心）。
 *
 * 【为什么这一层在 CP，不在沙箱】沙箱的 `GET /files` 是**字节**语义（它还要服务
 * `raw=1` 的 patch/tar/二进制），"行"只对模型有意义。所以"字节 ↔ 行"的翻译只发生在
 * 这里；沙箱不需要知道"行"是什么。
 *
 * 【两条路径】
 *  ① 小文件（≤ 1 MiB，沙箱内联上限）：一次普通 JSON 读拿全文，本地切。
 *     它顺带是"这个文件是不是合法 UTF-8"的权威判断——二进制文件在这里拿到 400
 *     `invalid_utf8`，而不是被解码成一片 U+FFFD 给模型看。
 *  ② 大文件：`raw=1` 的**字节窗口**（1 MiB 一个），CP 侧用 `TextDecoder(stream)` 增量
 *     解码（跨窗口的半个字符由它兜住，和 Phase 1 的输出合并器同一个套路）。
 *     为什么不走默认的 JSON 读：字节窗口会随机切在多字节字符中间，而沙箱的 utf8 读是
 *     **严格校验**的——直接 400。
 *
 * 【续读锚点】大文件的第二次读（`offset=2001`）不该从字节 0 重新扫。锚点记下"这次返回的
 * **最后一行**是第几行、它的起始字节偏移是多少"，下一次 `offset=` 命中就直接从那里接着扫。
 * 没有它，读完一个 10 MB 文件是 O(n²)。
 * （§3.5 写的是"记第一行"；这里记最后一行是同一个契约下的严格改进：同样是行首，
 * 但第一次续读就能跳过整个前缀，而不是把 O(n²) 推迟一轮。见实现备注 3。）
 *
 * 【锚点什么时候失效】沙箱不返回 mtime（`GET /files` 没有这个字段），所以不用时间戳
 * 猜测，而是**穷尽失效时机**：能改文件内容的只有 `write`（失效那一个路径）与 `bash`
 * （清空整张表）。模型的全部写入口就是这两个工具。
 *
 * 【四种收尾形态】（§3.5，测试要点 12–16 逐条验）
 *  1. 行数先到：`[Showing lines 1-2000. Use offset=2001 to continue.]`
 *  2. 字节先到：`[Showing lines 1-742 (50KB limit). Use offset=743 to continue.]`
 *  3. 模型传的 limit 先到、后面还有：`[120 more lines in file. Use offset=321 to continue.]`
 *  4. 第一行本身就超 50 KiB：不返回半行，返回一条能直接跑的命令。
 */

import type { ToolDefinition } from "../model.ts";
import { MAX_TOOL_BYTES, MAX_TOOL_LINES, formatBytes, splitLines, truncateHead } from "./truncate.ts";
import type { ReadAnchor, ToolContext, ToolResult } from "./types.ts";
import { asRecord, fail, ok, optionalInteger, resolveToolPath, toolFailure } from "./types.ts";

/** 大文件的字节窗口（§3.5：一个窗口 1 MiB）。 */
export const READ_WINDOW_BYTES = 1024 * 1024;

/**
 * 单行的长度上限。超过它的行永远装不进 50 KiB 的预算，继续攒着只会白占内存
 * （minified 的 JS 就是一行几十 MB——这不是假想的情况）。
 * 到顶时抛 `LineTooLongError`：调用方要么给出那条 `sed -n` 提示，
 * 要么把这一行当成"放不下"从而停在它前面。
 *
 * 【实际的内存上界是 `MAX_LINE_BYTES + READ_WINDOW_BYTES`】检查在每个窗口之后做一次，
 * 所以一个窗口里的字节会先被吃进来。为了几 MiB 把检查拆到每个 chunk 上不值得——
 * 这个常量的作用是"别把 500 MB 的单行读进内存"，不是精确计量。
 */
export const MAX_LINE_BYTES = 1024 * 1024;

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a text file. Output is truncated to 2000 lines or 50KB, whichever comes first. " +
    "Use offset (1-indexed line number) and limit (max lines) for large files; " +
    "continue with the offset printed in the truncation notice until the file is complete. " +
    "path is relative to the repository root unless it starts with /. " +
    "Do not use read on binary files — use bash for those.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the repository root (or absolute)." },
      offset: { type: "integer", minimum: 1, description: "Line number to start from, 1-indexed (default 1)." },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return (capped at 2000)." },
    },
    required: ["path"],
  },
};

export async function runRead(input: unknown, context: ToolContext): Promise<ToolResult> {
  try {
    const record = asRecord(input);
    const absPath = resolveToolPath(record, context);
    const offset = optionalInteger(record, "offset", { min: 1 }) ?? 1;
    // `limit` 只能往小了调：截断发生在行数上，offset 不是解锁开关（§3.5）。
    const rawLimit = optionalInteger(record, "limit", { min: 1 });
    const limit = Math.min(rawLimit ?? MAX_TOOL_LINES, MAX_TOOL_LINES);
    // 只有"模型自己传的 limit 就是天花板"时，提示才用形态 3（"还有 N 行"）。
    const requestedLimit = rawLimit !== undefined && rawLimit <= MAX_TOOL_LINES ? rawLimit : null;

    const inline = await tryInlineRead(absPath, context);
    if (inline.kind === "error") return fail(inline.message);
    if (inline.kind === "text") return readFromText(absPath, inline.text, offset, limit, requestedLimit);

    return await readPaged(absPath, offset, limit, requestedLimit, context);
  } catch (error) {
    return toolFailure(error);
  }
}

// ---------------------------------------------------------------- 路径 ①：全文

type InlineRead = { kind: "text"; text: string } | { kind: "too_large" } | { kind: "error"; message: string };

/** 一次内联读。`too_large` 是**唯一**会走分片路径的结果（沙箱的 413）。 */
async function tryInlineRead(absPath: string, context: ToolContext): Promise<InlineRead> {
  const { endpoint, authToken } = context.target;
  try {
    const file = await context.api.readFile(endpoint, authToken, absPath, { signal: context.signal });
    return { kind: "text", text: file.content };
  } catch (error) {
    const typed = error as { agentError?: string | null };
    if (typed.agentError === "too_large") return { kind: "too_large" };
    if (typed.agentError === "not_found") return { kind: "error", message: `文件不存在：${absPath}` };
    // 其余错误交给统一的翻译（越界 / 目录 / 二进制 / …）。
    const translated = toolFailure(error);
    return { kind: "error", message: translated.content };
  }
}

/** 全文在手：直接按行切（总行数已知，所以提示里能写"还有 N 行"）。 */
function readFromText(
  absPath: string,
  text: string,
  offset: number,
  limit: number,
  requestedLimit: number | null,
): ToolResult {
  const lines = splitLines(text);
  const total = lines.length;
  if (total === 0) {
    return offset === 1 ? ok(`(empty file: ${absPath})`) : fail(offsetBeyondMessage(offset, 0));
  }
  if (offset > total) return fail(offsetBeyondMessage(offset, total));

  const slice = lines.slice(offset - 1).join("\n");
  const trimmed = truncateHead(slice, { maxLines: limit, maxBytes: MAX_TOOL_BYTES });
  if (trimmed.firstLineExceedsLimit) {
    // 全文在手：这一行的长度是**准确**的（分片路径只能给"超过多少"）。
    return ok(firstLineTooBigNotice(offset, Buffer.byteLength(lines[offset - 1]!), absPath, "exact"));
  }

  const content = trimmed.content;
  if (!trimmed.truncated) return ok(content);

  const from = offset;
  const to = offset + trimmed.outputLines - 1;
  const notice = buildNotice({
    from,
    to,
    truncatedBy: trimmed.truncatedBy,
    requestedLimit,
    totalLines: total,
    absPath,
  });
  if (notice === null) return ok(content);
  return ok(content === "" ? notice : `${content}\n\n${notice}`);
}

// ---------------------------------------------------------------- 路径 ②：分片

async function readPaged(
  absPath: string,
  offset: number,
  limit: number,
  requestedLimit: number | null,
  context: ToolContext,
): Promise<ToolResult> {
  const anchor = context.anchors.get(absPath);
  const usable = anchor !== null && anchor.lineNumber <= offset ? anchor : null;
  const startOffset = usable?.byteOffset ?? 0;
  const startLine = usable?.lineNumber ?? 1;

  const iterator = scanLines(
    windowReader(absPath, context),
    startOffset,
    startLine,
    READ_WINDOW_BYTES,
  );

  const lines: string[] = [];
  let bytes = 0;
  let last: ReadAnchor | null = null;
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
      // 不用把前面的行再扫一遍。记第一行的话，第一次续读仍然要从字节 0 走完整个前缀
      // （spec §3.5 写的是第一行；这里选最后一行是同一个契约下的严格改进，理由见
      // 本文件头“续读锚点”那一段）。
      last = { lineNumber: scanned.number, byteOffset: scanned.byteOffset };
      lines.push(scanned.line);
      bytes += lineBytes;
    }
    reachedEnd = !stoppedByBudget;
  } catch (error) {
    if (isDecodeError(error)) {
      return fail(
        `这个文件不是合法 UTF-8（二进制文件？）：${absPath}。二进制内容请用 bash 处理（head -c / xxd），不要用 read。`,
      );
    }
    if (error instanceof LineTooLongError) {
      // 一行超过 `MAX_LINE_BYTES`。两种收尾，都**不返回半行**：
      //  · 它就是我们要的第一行 → 给那条能直接跑的 `sed -n` 命令；
      //  · 前面已经有内容 → 把它当成"这一行放不下"（它确实不可能装进 50 KiB），
      //    于是提示里的 `offset=N` 正好指向它，下一次读就会走到上面那个分支。
      if (lines.length === 0) {
        firstLineTooBig = error.bytes;
      } else {
        stoppedByBudget = true;
        tooLongLine = error.lineNumber;
      }
      reachedEnd = false;
    } else {
      throw error;
    }
  }

  if (firstLineTooBig !== null) {
    // 分片路径：长度是扫描器攒到上限时的字节数，行可能长得多——所以措辞是"over"。
    return ok(firstLineTooBigNotice(offset, firstLineTooBig, absPath, "at-least"));
  }

  // 一行都没读到 = 这次扫描一路走到了文件尾：要么 offset 超出行数，要么文件是空的。
  if (lines.length === 0) {
    return offset === 1 ? ok(`(empty file: ${absPath})`) : fail(offsetBeyondMessage(offset, lastLineNumber));
  }

  if (last !== null) context.anchors.set(absPath, last);

  const content = lines.join("\n");
  const from = offset;
  const to = offset + lines.length - 1;
  // **总行数只在这次已经读到文件尾时才写**（§3.5）：否则要为了一个数字把全文数一遍。
  const totalLines = reachedEnd ? lastLineNumber : null;
  const notice = buildNotice({
    from,
    to,
    // 行数上限、或者"下一行本身就长到装不下"→ 形态 1（措辞是中性的）；
    // 只有真的撞上 50 KiB 预算时才用形态 2 的 `(50KB limit)`。
    truncatedBy: reachedEnd ? null : lines.length >= limit || tooLongLine !== null ? "lines" : "bytes",
    requestedLimit,
    totalLines,
    absPath,
  });
  return ok(notice === null ? content : `${content}\n\n${notice}`);
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

/** 读一个字节窗口。`eof` = 这个窗口就是文件的结尾（HTTP 分片读的短读即 EOF）。 */
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

/** 沙箱的 raw 读 → `WindowReader`。短读（返回字节数 < 请求的）就是 EOF。 */
function windowReader(absPath: string, context: ToolContext): WindowReader {
  return async (offset, limit) => {
    const { endpoint, authToken } = context.target;
    const stream = await context.api.readRaw(endpoint, authToken, absPath, {
      offset,
      limit,
      signal: context.signal,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      chunks.push(buffer);
      total += buffer.length;
    }
    return { bytes: Buffer.concat(chunks), eof: total < limit };
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
