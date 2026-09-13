/**
 * `vendor/tree-sitter/` 的位置——**只有这一处**知道它在哪里。
 *
 * 【为什么单独一个文件】三个地方要它：`parse.ts`（worker 的默认语法文件目录）、
 * `indexer.ts`（传给 worker 的口）、`scripts/index-repo.ts`（手工验收）。
 * 每个地方各写一遍 `new URL("../../../../vendor/…")` 就会有三份会漂的相对路径
 * ——而这个路径一旦写错，唯一的症状是"worker 启动就崩"，排查起来要跨进程。
 *
 * 【为什么允许环境变量覆盖】发布形态里 CP 可能不在仓库根（打包进镜像、或者 vendor 目录被
 * 单独挂载）。`REUBEN_CLOUD_TREE_SITTER_DIR` 是留给那种形态的逃生门，缺省值就是仓库里的那一个。
 */

import process from "node:process";
import { fileURLToPath } from "node:url";

/** 语法文件目录的绝对路径（末尾带 `/`）。 */
export const VENDOR_TREE_SITTER_DIR =
  process.env.REUBEN_CLOUD_TREE_SITTER_DIR ?? fileURLToPath(new URL("../../../../vendor/tree-sitter/", import.meta.url));
