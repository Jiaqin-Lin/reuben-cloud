/**
 * `static.ts` —— 前端静态资源（Phase 13 的 `packages/web/public/`）。
 *
 * 【为什么是白名单而不是"把 public 目录挂上去"】静态服务器最常见的一个洞是路径拼接：
 * `/../../.env`、URL 编码、符号链接。这里根本没有拼接——**URL 路径当 Map 的键查表**，
 * 查不到就是 404。于是"路径穿越"这整类问题不存在，也不需要一条 `..` 正则去挡（挡不干净）。
 * 代价是加一个文件要在这里写一行；对这个规模的前端（三个文件）是划算的。
 *
 * 【为什么每次请求都读盘，不缓存在内存里】这是开发者的观察窗：改完 `app.js` 刷新就该看到。
 * 三个小文件、本地回环、单用户，读盘的代价可以忽略。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface StaticFile {
  /** 相对 web root 的文件名。**不接受调用方拼出来的路径**。 */
  file: string;
  type: string;
}

/**
 * 允许被访问的静态资源。**只有这五个**：观察窗（index/app）与环境页（env）各两个文件，
 * 加一份共用的样式表。没有图标二进制、没有 sourcemap、没有字体。
 * `/favicon.ico` 不走这张表——服务器直接回 204（见 `server.ts`）：不引二进制资源，
 * 也消掉浏览器控制台那条 404。
 */
export const STATIC_FILES: Readonly<Record<string, StaticFile>> = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/env.html": { file: "env.html", type: "text/html; charset=utf-8" },
  "/env.js": { file: "env.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

/**
 * 前端资源目录。缺省是仓库里的 `packages/web/public`（从本文件的 URL 往上数三层），
 * `REUBEN_CLOUD_WEB_ROOT` 可以覆盖（测试与"换个前端"都用它）。
 */
export function webRoot(): string {
  const override = process.env["REUBEN_CLOUD_WEB_ROOT"];
  if (override !== undefined && override !== "") return path.resolve(override);
  return fileURLToPath(new URL("../../../web/public/", import.meta.url));
}

export interface StaticResponse {
  body: Buffer;
  type: string;
}

/**
 * 查表 + 读文件。返回 null = "这不是一个已知的静态资源"（调用方回 404）。
 * **文件名只来自 `STATIC_FILES` 的字面量**，`pathname` 只参与查表。
 */
export async function readStatic(pathname: string, root: string = webRoot()): Promise<StaticResponse | null> {
  const entry = STATIC_FILES[pathname];
  if (entry === undefined) return null;
  const body = await readFile(path.join(root, entry.file));
  return { body, type: entry.type };
}
