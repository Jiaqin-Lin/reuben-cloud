/**
 * `write.ts` —— 写文件（Phase 11 §3）。整文件覆盖，写入走沙箱的 `PUT /files`。
 *
 * 【为什么不设行/字节上限】沙箱侧的 512 MiB 是垫底（§3 的原话）；模型单次输出本来就
 * 受 `max_tokens` 约束，在这里再叠一个上限只会多一种"写到一半被拒"的失败。
 *
 * 【为什么写成功要失效读锚点】`read.ts` 的大文件续读锚点按"第几行 + 起始字节偏移"
 * 直接跳转。文件被覆盖之后旧锚点会指向错误的位置——**这是锚点唯一的失效入口之一**
 * （另一个是 bash，见 `bash.ts`）。沙箱不返回 mtime，所以失效靠穷举时机而不是时间戳。
 */

import { Readable } from "node:stream";
import type { ToolDefinition } from "../model.ts";
import { countLines } from "./truncate.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { asRecord, ok, requireString, resolveToolPath, toolFailure } from "./types.ts";

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Write a text file, replacing its whole content (parent directories are created automatically). " +
    "path is relative to the repository root unless it starts with /. " +
    "This is the way to edit files: read the file first, then write the new full content. " +
    "Writes can only land inside the workspace — anything else is rejected by the sandbox.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the repository root (or absolute)." },
      content: { type: "string", description: "Full new content of the file (UTF-8)." },
    },
    required: ["path", "content"],
  },
};

export async function runWrite(input: unknown, context: ToolContext): Promise<ToolResult> {
  try {
    const record = asRecord(input);
    const absPath = resolveToolPath(record, context);
    const content = requireString(record, "content", { allowEmpty: true });
    const body = Buffer.from(content, "utf8");

    const written = await context.api.putFile(
      context.target.endpoint,
      context.target.authToken,
      absPath,
      Readable.from([body]),
      context.signal === undefined ? {} : { signal: context.signal },
    );

    context.anchors.invalidate(absPath);
    const lines = countLines(content);
    return ok(
      `Wrote ${written.size} bytes (${lines} ${lines === 1 ? "line" : "lines"}) to ${written.path}` +
        `\nsha256: ${written.sha256}`,
    );
  } catch (error) {
    return toolFailure(error);
  }
}
