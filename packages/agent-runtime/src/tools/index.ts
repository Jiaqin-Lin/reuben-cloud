/**
 * `tools/index.ts` —— 把内置工具装配成一个 Run 能用的形状。
 *
 * 【为什么多这一个文件】`loop.ts` 只该懂"循环"：轮次、上限、事件、消息拼装。
 * 它 import 四个具体工具、拿执行后端的结果是**循环与执行细节耦合**——而这两件事的变化
 * 频率完全不同（换执行后端不该动循环逻辑，调循环策略不该动工具）。
 * 装配点放在这里之后，循环的单测可以塞一个脚本化的假工具，一行 Docker 都不用。
 *
 * 【一个 Run 一份】`createBuiltinTools()` 每次都建一个新的锚点表（`read` 的续读锚点
 * 是 Run 级状态：文件被 write/bash 改过之后必须失效，见 `anchors.ts`）。
 *
 * 【顺序】返回值按名字排序。`model/client.ts` 发送前还会再排一次——缓存前缀要求字节稳定
 * （`tools → system` 是按这个顺序进前缀的），两处都排才不怕有人在装配点调顺序。
 *
 * 【P11 会加什么】`edit` / `grep` / `find` 三个工具，以及与 `write` 共用的 per-path
 * 写入队列。它们都走同一个装配点，循环与 CP 一行不用改——这就是这个文件存在的意义。
 */

import type { AgentTool } from "../types.ts";
import type { ReadAnchors } from "./anchors.ts";
import { createReadAnchors } from "./anchors.ts";
import type { BashOperations } from "./bash.ts";
import { createBashTool } from "./bash.ts";
import type { LsOperations } from "./ls.ts";
import { createLsTool } from "./ls.ts";
import type { ReadOperations } from "./read.ts";
import { createReadTool } from "./read.ts";
import type { WriteOperations } from "./write.ts";
import { createWriteTool } from "./write.ts";

/** 内置工具的四个执行出口。CP 用一个对象实现全部四个（结构上兼容即可）。 */
export interface BuiltinToolOperations {
  bash: BashOperations;
  read: ReadOperations;
  write: WriteOperations;
  ls: LsOperations;
}

export interface BuiltinToolsOptions {
  /** 模型心里的工作目录（相对路径按它解析）。 */
  cwd: string;
  operations: BuiltinToolOperations;
  /** 复用一个锚点表（同一批工具共享；缺省新建一个）。 */
  anchors?: ReadAnchors;
}

/** 装配内置工具。返回的快照可以直接交给 `AgentContext.tools`。 */
export function createBuiltinTools(options: BuiltinToolsOptions): AgentTool[] {
  const anchors = options.anchors ?? createReadAnchors();
  const tools: AgentTool[] = [
    createBashTool({ cwd: options.cwd, operations: options.operations.bash }),
    createLsTool({ cwd: options.cwd, operations: options.operations.ls }),
    createReadTool({ cwd: options.cwd, operations: options.operations.read, anchors }),
    createWriteTool({ cwd: options.cwd, operations: options.operations.write, anchors }),
  ];
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export type { BashExecOptions, BashExecResult, BashOperations } from "./bash.ts";
export type { LsEntry, LsOperations, LsResult } from "./ls.ts";
export type { ReadOperations } from "./read.ts";
export type { WriteFileResult, WriteOperations } from "./write.ts";
export { createReadAnchors } from "./anchors.ts";
export type { ReadAnchor, ReadAnchors } from "./anchors.ts";
export { FileOperationError, ToolInputError, toolErrorMessage } from "./errors.ts";
export type { FileErrorCode } from "./errors.ts";
export {
  MAX_TOOL_BYTES,
  MAX_TOOL_LINES,
  countLines,
  formatBytes,
  splitLines,
  tailBytes,
  truncateHead,
  truncateTail,
} from "./truncate.ts";
