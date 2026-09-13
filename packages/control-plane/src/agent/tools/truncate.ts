/**
 * `truncate.ts` —— 工具输出的硬预算（Phase 11 §3.5）。
 *
 * 【为什么单独一个文件、而不是每个工具各切各的】"任何 tool_result 都不会超过
 * 2000 行 / 50 KiB"是一条**全局**性质：四个工具、以及将来加的工具都必须满足它。
 * 各写一份的结果是某天 `write` 的返回值里多了一行没被切掉的 diff，而那条性质
 * 只有在某个模型的上下文爆掉时才有人察觉。
 *
 * 【两条上限，先到先算】
 *  2000 行 —— 模型单次能看到的最大行数；
 *  50 KiB —— 防"一行 1 MB"（压缩过的 JS、minified 日志、base64）。
 * 两者独立，任何一个先到就停。**提示文字本身不计入预算**：它只有一行，
 * 而且必须让模型看见，算进去只会多一个边界 bug。
 *
 * 【行号契约】（与 `read.ts` 的 schema 描述同一份口径）
 *  按 `\n` 分隔；`\r\n` 里的 `\r` 不算新的一行；文件末尾没有换行符也照算最后一行。
 *  所以 `"a\nb"` 是 2 行，`"a\nb\n"` 也是 2 行，`""` 是 0 行，`"\n"` 是 1 行。
 *
 * 【不返回半行】切就切在换行符上。唯一的例外是 `truncateTail` 遇到"最后一行本身
 * 超过 50 KiB"——那时从行尾往左取够字节，并把 `lastLinePartial` 标出来，
 * 由调用方在提示里说明（`read` 那条分支干脆不返回半行，见 `read.ts`）。
 */

/** 模型单次能看到的最大行数。 */
export const MAX_TOOL_LINES = 2000;

/** 单条 tool_result 的字节上限（50 KiB）。 */
export const MAX_TOOL_BYTES = 50 * 1024;

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncateResult {
  /** 预算内的内容（**不含**提示行）。 */
  content: string;
  /** 有内容被切掉。 */
  truncated: boolean;
  /** 是被哪条上限切掉的（`null` = 没切）。 */
  truncatedBy: "lines" | "bytes" | null;
  /** 返回内容的行数。 */
  outputLines: number;
  /** 源文本的总行数。 */
  totalLines: number;
  /** 保尾时：前面被丢掉的行数（含那一行被部分保留的情况）。 */
  skippedLines: number;
  /** 保尾时：最后一行本身超预算，内容是从行尾截的。 */
  lastLinePartial: boolean;
  /** 保头时：第一行本身就超预算（`read` 要给出 `sed -n` 那条提示）。 */
  firstLineExceedsLimit: boolean;
}

/**
 * 数行数。空串是 0 行，末尾的换行不额外算一行（见文件头的行号契约）。
 */
export function countLines(text: string): number {
  return splitLines(text).length;
}

/** 按 `\n` 切行，**末尾的换行不产生一个空行**。`\r` 原样留在行内容里（不当分隔符）。 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 保开头：`read` 与 `list` 用。模型要的就是"从这一行往后"的内容。 */
export function truncateHead(text: string, options: TruncateOptions = {}): TruncateResult {
  const maxLines = options.maxLines ?? MAX_TOOL_LINES;
  const maxBytes = options.maxBytes ?? MAX_TOOL_BYTES;
  const lines = splitLines(text);
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;

  for (const line of lines) {
    if (kept.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    // 行与行之间要补一个 `\n`：它也是真实字节（budget 是字节预算，不是"字符预算"）。
    const lineBytes = Buffer.byteLength(line) + (kept.length === 0 ? 0 : 1);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }

  const firstLineExceedsLimit =
    kept.length === 0 && lines.length > 0 && Buffer.byteLength(lines[0]!) > maxBytes;

  return {
    content: kept.join("\n"),
    truncated: truncatedBy !== null,
    truncatedBy,
    outputLines: kept.length,
    totalLines: lines.length,
    skippedLines: 0,
    lastLinePartial: false,
    firstLineExceedsLimit,
  };
}

/** 保结尾：`bash` 用。报错和最终结果在结尾，前面通常是噪音。 */
export function truncateTail(text: string, options: TruncateOptions = {}): TruncateResult {
  const maxLines = options.maxLines ?? MAX_TOOL_LINES;
  const maxBytes = options.maxBytes ?? MAX_TOOL_BYTES;
  const lines = splitLines(text);
  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;
  let lastLinePartial = false;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (kept.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const line = lines[index]!;
    const lineBytes = Buffer.byteLength(line) + (kept.length === 0 ? 0 : 1);
    if (bytes + lineBytes > maxBytes) {
      if (kept.length === 0) {
        // 最后一行本身就超预算：从行尾往左取够字节。这是唯一允许"半行"的分支。
        const partial = tailBytes(line, maxBytes);
        kept.push(partial);
        bytes = Buffer.byteLength(partial);
        lastLinePartial = true;
      }
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    bytes += lineBytes;
  }

  kept.reverse();
  return {
    content: kept.join("\n"),
    truncated: truncatedBy !== null,
    truncatedBy,
    outputLines: kept.length,
    totalLines: lines.length,
    skippedLines: lines.length - kept.length,
    lastLinePartial,
    firstLineExceedsLimit: false,
  };
}

/**
 * 从行尾取 `maxBytes` 字节（不切开一个码点，也不留孤立的代理项）。
 * 只在 `truncateTail` 的"最后一行本身超预算"分支里用。
 */
export function tailBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const points = [...text];
  let bytes = 0;
  let start = points.length;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const pointBytes = Buffer.byteLength(points[index]!);
    if (bytes + pointBytes > maxBytes) break;
    bytes += pointBytes;
    start = index;
  }
  return points.slice(start).join("");
}

/** `1234` → `1.2KB`。提示里用它，免得让模型对着 51200 这种数字换算。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
