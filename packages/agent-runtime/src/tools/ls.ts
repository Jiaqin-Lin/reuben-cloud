/**
 * `ls.ts` —— 列目录（Phase 11 §3；Phase 1 迁入并 Operations 化）。
 *
 * 【名字为什么是 `ls`】M0 叫 `list`。模型对 `ls` 的先验更强（所有主流 coding agent 都是
 * 这个形状），改名能省掉一批"模型先写 list、再自己改成 ls"的无效轮次。旧名字保留为
 * `aliases`（模型看不到它，但会话/历史里出现 `list` 时仍能执行），下个版本删掉
 * （spec 附录 A-2）。文件与工具的 `name` 都用新名字，不留两份实现。
 *
 * 【为什么不跟随符号链接】这是执行后端的设计（沙箱 Phase 2 §4）：跟随会让 ls 变成一条
 * 绕过路径校验的越权通道。工具层原样保留这个语义——`symlink` 就是 `symlink`，
 * 想读链接后面是什么，用 `read`（它走同一份路径校验）。
 *
 * 【两级上限】后端侧 1000 条（超出置 `truncated`），工具侧再套 2000 行 / 50 KiB
 * （§3.5）。两条都要如实告诉模型：前者意味着"还有条目没列出来"，后者意味着
 * "这次返回被切了"。少说一条，模型就会以为目录就这么多东西。
 */

import { Type, type Static } from "typebox";
import type { AgentTool, Content } from "../types.ts";
import { resolveToolPath } from "./paths.ts";
import { MAX_TOOL_BYTES, MAX_TOOL_LINES, formatBytes, truncateHead } from "./truncate.ts";

/** 一个目录条目（与沙箱 `GET /files/list` 的字段一一对应）。 */
export interface LsEntry {
  name: string;
  type: string;
  size: number;
}

export interface LsResult {
  path: string;
  entries: LsEntry[];
  /** 后端自己的条目上限到了（"还有条目没列出来"）。 */
  truncated: boolean;
}

/** 列目录出口。失败抛 `FileOperationError`（`not_found` / `not_directory` / …）。 */
export interface LsOperations {
  list(path: string, options: { depth: number; signal?: AbortSignal }): Promise<LsResult>;
}

/** 后端侧的条目上限（沙箱 `maxListEntries` 缺省值），只用于提示文案。 */
export const SANDBOX_ENTRY_LIMIT = 1000;

const lsSchema = Type.Object(
  {
    path: Type.String({ description: "Directory path, relative to the repository root (or absolute)." }),
    depth: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 8,
        description: "How many levels to walk (default 1, maximum 8).",
      }),
    ),
  },
  { additionalProperties: false },
);

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolOptions {
  cwd: string;
  operations: LsOperations;
}

export function createLsTool(options: LsToolOptions): AgentTool<typeof lsSchema, undefined> {
  return {
    name: "ls",
    label: "ls",
    description:
      "List a directory. Returns one line per entry (type, name, size), sorted by name. " +
      "depth defaults to 1 (only this directory); deeper listings can be large, so keep depth small. " +
      "Symlinks are reported as symlinks, not followed. " +
      "path is relative to the repository root unless it starts with /.",
    parameters: lsSchema,
    executionMode: "parallel",
    aliases: ["list"],
    async execute(_toolCallId, params, signal): Promise<{ content: Content[]; details: undefined }> {
      const text = await runLs(params, options, signal);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

/** 列目录的实现（从 M0 的 `runList` 迁入；返回给模型的文本，失败抛异常）。 */
export async function runLs(input: LsToolInput, options: LsToolOptions, signal?: AbortSignal): Promise<string> {
  const absPath = resolveToolPath(input.path, options.cwd);
  const depth = input.depth ?? 1;
  const listing = await options.operations.list(absPath, signal === undefined ? { depth } : { depth, signal });
  if (listing.entries.length === 0) return `(empty directory: ${listing.path})`;

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
  return parts.join("\n\n");
}

/**
 * 一行一个条目。`name` 在 `depth>1` 时已经是相对本次请求路径的相对路径（后端的约定），
 * 所以这里不用拼前缀。目录加尾斜杠——模型据此判断"这是不是还能往下走"。
 */
function formatEntry(entry: LsEntry): string {
  const label = entry.type === "dir" ? `${entry.name}/` : entry.name;
  const size = entry.type === "file" ? ` ${formatBytes(entry.size)}` : "";
  return `${entry.type.padEnd(7)} ${label}${size}`;
}
