/**
 * `list.ts` —— 列目录（Phase 11 §3）。沙箱的 `GET /files/list` 加一层"给模型看"的渲染。
 *
 * 【为什么不跟随符号链接】这是沙箱侧的设计（Phase 2 §4）：跟随会让 list 变成一条绕过
 * 路径校验的越权通道。工具层原样保留这个语义——`symlink` 就是 `symlink`，
 * 想读链接后面是什么，用 `read`（它走同一份路径校验）。
 *
 * 【两级上限】沙箱侧 1000 条（超出置 `truncated`），工具侧再套 2000 行 / 50 KiB
 * （§3.5）。两条都要如实告诉模型：前者意味着"还有条目没列出来"，后者意味着
 * "这次返回被切了"。少说一条，模型就会以为目录就这么多东西。
 */

import type { ToolDefinition } from "../model.ts";
import { MAX_TOOL_BYTES, MAX_TOOL_LINES, formatBytes, truncateHead } from "./truncate.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { asRecord, fail, ok, optionalInteger, resolveToolPath, toolFailure } from "./types.ts";

/** 沙箱侧的条目上限（Phase 2 的 `maxListEntries` 缺省值），只用于提示文案。 */
export const SANDBOX_ENTRY_LIMIT = 1000;

export const listTool: ToolDefinition = {
  name: "list",
  description:
    "List a directory. Returns one line per entry (type, name, size), sorted by name. " +
    "depth defaults to 1 (only this directory); deeper listings can be large, so keep depth small. " +
    "Symlinks are reported as symlinks, not followed. " +
    "path is relative to the repository root unless it starts with /.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, relative to the repository root (or absolute)." },
      depth: {
        type: "integer",
        minimum: 1,
        maximum: 8,
        description: "How many levels to walk (default 1, maximum 8).",
      },
    },
    required: ["path"],
  },
};

export async function runList(input: unknown, context: ToolContext): Promise<ToolResult> {
  try {
    const record = asRecord(input);
    const absPath = resolveToolPath(record, context);
    const depth = optionalInteger(record, "depth", { min: 1, max: 8 }) ?? 1;

    let listing;
    try {
      listing = await context.api.listFiles(context.target.endpoint, context.target.authToken, absPath, {
        depth,
        signal: context.signal,
      });
    } catch (error) {
      const typed = error as { agentError?: string | null };
      if (typed.agentError === "not_found") return fail(`目录不存在：${absPath}`);
      throw error;
    }

    if (listing.entries.length === 0) return ok(`(empty directory: ${listing.path})`);

    const body = listing.entries.map(formatEntry).join("\n");
    const trimmed = truncateHead(body, { maxLines: MAX_TOOL_LINES, maxBytes: MAX_TOOL_BYTES });

    const parts: string[] = [trimmed.content === "" ? "(entries too long to display)" : trimmed.content];
    if (trimmed.truncated) {
      parts.push(
        `[Showing the first ${trimmed.outputLines} of ${listing.entries.length} entries. ` +
          `Narrow it with depth=1 or a smaller path.]`,
      );
    }
    if (listing.truncated) {
      parts.push(`[truncated: the sandbox listed the first ${SANDBOX_ENTRY_LIMIT} entries only]`);
    }
    return ok(parts.join("\n\n"));
  } catch (error) {
    return toolFailure(error);
  }
}

/**
 * 一行一个条目。`name` 在 `depth>1` 时已经是相对本次请求路径的相对路径（沙箱的约定），
 * 所以这里不用拼前缀。目录加尾斜杠——模型据此判断"这是不是还能往下走"。
 */
function formatEntry(entry: { name: string; type: string; size: number }): string {
  const label = entry.type === "dir" ? `${entry.name}/` : entry.name;
  const size = entry.type === "file" ? ` ${formatBytes(entry.size)}` : "";
  return `${entry.type.padEnd(7)} ${label}${size}`;
}
