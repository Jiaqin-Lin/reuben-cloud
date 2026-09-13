/**
 * `errors.ts` —— 工具层的错误词汇与"给模型看的话"。
 *
 * 【为什么要有自己的错误码】工具跑在 agent-runtime 里，而"文件不存在 / 越界 / 不是
 * 合法 UTF-8"这些事实来自 CP 注入的执行后端（沙箱、将来的本地裸跑）。后端把它自己的
 * 结构化错误码翻译成这里的 `FileErrorCode`，工具把它翻译成**模型能照着改的话**——
 * 模型看到 `path_out_of_bounds` 只会瞎猜，看到"path 只能落在 /workspace 之下"才知道
 * 怎么改。三层各管一段：后端知道"为什么"，工具知道"怎么说"。
 *
 * 【为什么错误要分类而不是只带 message】同一个 message 里的字符串匹配会在两种后端上
 * 漂；分类之后"这个错误该不该重试 / 该不该降级"是 switch，不是正则。
 */

/** 文件操作的错误码。后端必须从自己的错误里映射到这几个之一。 */
export type FileErrorCode =
  /** 路径不存在。 */
  | "not_found"
  /** 试图读一个目录。 */
  | "is_directory"
  /** 试图 list 一个非目录。 */
  | "not_directory"
  /** 不是合法 UTF-8（二进制文件）。 */
  | "invalid_utf8"
  /** 超过后端的内联读上限。 */
  | "too_large"
  /** offset/limit 不合法。 */
  | "invalid_range"
  /** 路径越界（沙箱的路径校验）。 */
  | "path_out_of_bounds"
  /** 后端忙（同一个沙箱同时只允许一条命令）。 */
  | "busy"
  /** 权限不足。 */
  | "denied"
  /** 其他。 */
  | "unknown";

/**
 * 后端抛回给工具的错误。**必须带 code**：`read` 靠 `too_large` 决定走分片路径，
 * `ls` 靠 `not_found` 给出"目录不存在"，其余走统一翻译。
 */
export class FileOperationError extends Error {
  readonly code: FileErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: FileErrorCode, message: string, options: { details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FileOperationError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

/** 参数校验失败。**不是异常路径**：工具层把它翻译成 `isError` 的 tool_result，让模型自己改。 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/**
 * 错误 → 给模型看的一句话。后端错误码在这里变成可执行的提示。
 * 认不出的错误原样透出 message（不让模型对着一个空话发呆）。
 */
export function toolErrorMessage(error: unknown): string {
  if (error instanceof ToolInputError) return error.message;
  if (error instanceof FileOperationError) return fileErrorHint(error);
  return error instanceof Error ? error.message : String(error);
}

/** 文件错误码 → 可执行的提示。 */
export function fileErrorHint(error: FileOperationError): string {
  const path = typeof error.details["path"] === "string" ? error.details["path"] : "";
  switch (error.code) {
    case "path_out_of_bounds":
      return "路径越界：读只能落在 /workspace 与 /tmp/reuben-cloud 之下，写只能落在 /workspace 之下。相对路径按工作目录解析。";
    case "not_found":
      return `${error.message}${path === "" ? "" : `（${path}）`}`;
    case "is_directory":
      return "这是一个目录，用 ls 工具列它，或者 read 一个具体文件。";
    case "not_directory":
      return "这不是一个目录（ls 只能列目录）。";
    case "invalid_utf8":
      return "这个文件不是合法 UTF-8（二进制文件？）。二进制内容请用 bash 处理（例如 xxd / head -c），不要用 read。";
    case "too_large":
      return "文件太大，超过沙箱的内联读上限。用 offset/limit 分片读。";
    case "invalid_range":
      return "offset/limit 不合法（offset 不能是负数，limit 必须是正数）。";
    case "busy":
      return "沙箱正忙：同一个沙箱同一时间只允许一条命令。等这一条结束再试。";
    case "denied":
      return error.message;
    case "unknown":
      return error.message;
  }
}
