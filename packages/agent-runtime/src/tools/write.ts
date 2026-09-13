/**
 * `write.ts` —— 写文件（Phase 11 §3；Phase 1 迁入并 Operations 化）。
 * 整文件覆盖，写入走 `WriteOperations.writeFile`。
 *
 * 【为什么不设行/字节上限】执行后端的 512 MiB 是垫底（§3 的原话）；模型单次输出本来就
 * 受 `max_tokens` 约束，在这里再叠一个上限只会多一种"写到一半被拒"的失败。
 *
 * 【为什么写成功要失效读锚点】`read.ts` 的大文件续读锚点按"第几行 + 起始字节偏移"
 * 直接跳转。文件被覆盖之后旧锚点会指向错误的位置——**这是锚点唯一的失效入口之一**
 * （另一个是 bash，见 `bash.ts`）。执行后端不返回 mtime，所以失效靠穷举时机而不是时间戳。
 *
 * 【P11 会加什么】目标目录不存在时给**明确错误**（现在由后端自动建目录）、
 * 以及与 `edit` 共用的 per-path 写入队列（`runExclusive`）。两者都属于"工具语义"，
 * 与这里的 Operations 化不冲突。
 */

import { Type, type Static } from "typebox";
import type { AgentTool, Content } from "../types.ts";
import type { ReadAnchors } from "./anchors.ts";
import { resolveToolPath } from "./paths.ts";
import { countLines } from "./truncate.ts";

/** 一次写入的结果（字节数 + 校验和，给模型一个可核对的凭据）。 */
export interface WriteFileResult {
  bytes: number;
  sha256: string;
  /** 实际落盘的路径（后端可能规范化过）。 */
  path: string;
}

/** 写文件出口。失败抛 `FileOperationError`。 */
export interface WriteOperations {
  writeFile(
    path: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<WriteFileResult>;
}

const writeSchema = Type.Object(
  {
    path: Type.String({ description: "File path, relative to the repository root (or absolute)." }),
    content: Type.String({ description: "Full new content of the file (UTF-8)." }),
  },
  { additionalProperties: false },
);

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolOptions {
  cwd: string;
  operations: WriteOperations;
  /** 与 `read` 共用的锚点表（同一个 Run 一份）。 */
  anchors?: ReadAnchors;
}

export function createWriteTool(options: WriteToolOptions): AgentTool<typeof writeSchema, undefined> {
  return {
    name: "write",
    label: "write",
    description:
      "Write a text file, replacing its whole content (parent directories are created automatically). " +
      "path is relative to the repository root unless it starts with /. " +
      "This is the way to edit files: read the file first, then write the new full content. " +
      "Writes can only land inside the workspace — anything else is rejected by the sandbox.",
    parameters: writeSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal): Promise<{ content: Content[]; details: undefined }> {
      const text = await runWrite(params, options, signal);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

/** 写的实现（从 M0 的 `runWrite` 迁入；返回给模型的文本，失败抛异常）。 */
export async function runWrite(
  input: WriteToolInput,
  options: WriteToolOptions,
  signal?: AbortSignal,
): Promise<string> {
  const absPath = resolveToolPath(input.path, options.cwd);
  const written = await options.operations.writeFile(absPath, input.content, signal === undefined ? {} : { signal });
  // 文件内容变了：旧锚点全部作废（见文件头）。后端返回的 path 可能与请求的不同
  // （规范化过），两个都要失效。
  options.anchors?.invalidate(absPath);
  if (written.path !== absPath) options.anchors?.invalidate(written.path);
  const lines = countLines(input.content);
  return (
    `Wrote ${written.bytes} bytes (${lines} ${lines === 1 ? "line" : "lines"}) to ${written.path}` +
    `\nsha256: ${written.sha256}`
  );
}
