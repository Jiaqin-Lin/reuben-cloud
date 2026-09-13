/**
 * `paths.ts` —— 模型给的 path → 执行后端的绝对路径。
 *
 * 【为什么必须做这一步】执行后端（沙箱）的路径校验以 **workspace 根**（`/workspace`）为
 * 相对基准，而模型心里的 cwd 是仓库根（`/workspace/repo`）。不翻译的话
 * `read("src/a.ts")` 会静默变成 `/workspace/src/a.ts`——一个"读了另一个文件"的 bug，
 * 而且它不会报错。绝对路径原样通过（后端那边还要再校验一次越界）。
 *
 * 【为什么单独一个文件】`read` / `write` / `ls` 三个工具共用这一条规矩，
 * 各写一份迟早会漂（比如某天有人在其中一个里加了 URL 解码）。
 */

import path from "node:path";

export function resolveToolPath(raw: string, cwd: string): string {
  // path.resolve 在第二个参数是绝对路径时会忽略第一个——这正是要的语义。
  return path.resolve(cwd, raw);
}
