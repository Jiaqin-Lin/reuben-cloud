/**
 * `GET /files/list` —— 列目录。
 *
 * 【不跟随符号链接】`type` 直接标 `symlink`，递归也只进真目录。跟随会让 list 变成一条
 * 绕过路径校验的越权通道（workspace 里一个 `ln -s /etc` 就能让你"看"到 /etc）。
 * 顺带解决了递归防环问题：不跟随就不可能绕圈。
 *
 * 【条目上限】默认 1000，超出置 `truncated:true`。截掉的是"后面的条目没列出来"，
 * 不是内容被裁——CP 要么接受，要么换更小的 path 再列一次。
 *
 * 【name 的形状】`depth=1` 时就是文件名；`depth>1` 时是**相对本次请求路径**的相对路径
 * （如 `src/a.ts`），不带前导 `/`。客户端要绝对路径就自己与响应的 `path` 拼。
 */

import { lstat, readdir, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { MAX_LIST_DEPTH, type Config } from "../config.ts";
import { parseUint, sendError, sendFsError, sendJson } from "../http.ts";
import { resolveFailureError, type RootResolver } from "../paths.ts";
import type { FileEntry, FileEntryType, FileListResponse } from "../types.ts";

/**
 * 处理一条 `GET /files/list`。响应完全由本函数发出（成功/失败都是），
 * server.ts 只负责把 URL 转交过来。
 */
export async function handleFileList(
  res: ServerResponse,
  url: URL,
  roots: RootResolver,
  config: Config,
): Promise<void> {
  // path 可以省略：默认就是写根（workspace）本身。list 是唯一允许"不指路径"的文件路由。
  const requested = url.searchParams.get("path") ?? ".";
  const resolved = roots.resolve(requested);
  if (!resolved.ok) {
    sendJson(res, 400, resolveFailureError(resolved.reason, roots, false));
    return;
  }

  const depthParam = url.searchParams.get("depth");
  const depth = depthParam === null ? 1 : parseUint(depthParam);
  if (depth === null || depth < 1 || depth > MAX_LIST_DEPTH) {
    sendError(res, 400, "invalid_depth", `depth must be an integer in 1..${MAX_LIST_DEPTH}`, {
      limit: MAX_LIST_DEPTH,
    });
    return;
  }

  let info: Stats;
  try {
    info = await stat(resolved.abs);
  } catch (err) {
    sendFsError(res, err, "list");
    return;
  }
  if (!info.isDirectory()) {
    sendError(res, 400, "not_directory", "only directories can be listed; use GET /files to read a file");
    return;
  }

  const entries: FileEntry[] = [];
  let truncated = false;

  /**
   * 深度优先收集。`remaining` 是"还能往下走几层"：1 = 只列本层。
   * 条数上限在**每个条目入队之前**判，所以 entries.length 永远不会超过上限。
   */
  const walk = async (dir: string, prefix: string, remaining: number): Promise<void> => {
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      // 子目录在列的途中被删了 / 权限不够：跳过它比让整个 list 失败友好。
      // depth=1 时到不了这里——本层的 stat 已经在上面处理过了。
      return;
    }

    // 默认的 `Array.sort()` 会把对象转成 "[object Object]" 比较（全部相等）——必须给比较器。
    // 用代码单元顺序而不是 localeCompare：后者的结果随 ICU 数据漂移，测试会不稳定。
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const item of items) {
      if (entries.length >= config.maxListEntries) {
        truncated = true;
        return;
      }
      const full = path.join(dir, item.name);
      // lstat 而不是 stat：要的就是链接本体的信息，不是它指向的东西。
      const stats = await lstat(full).catch(() => null);
      if (stats === null) continue; // 竞争：刚列出来就没了，跳过

      entries.push({
        name: prefix + item.name,
        type: entryType(item),
        size: stats.size,
        mtime: stats.mtimeMs,
      });

      // 递归只进真目录（`item.isDirectory()` 对符号链接是 false），所以不可能绕圈。
      if (remaining > 1 && item.isDirectory()) {
        await walk(full, `${prefix}${item.name}/`, remaining - 1);
        if (truncated) return; // 子目录把上限用完了，本层也别再列了
      }
    }
  };

  await walk(resolved.abs, "", depth);

  const body: FileListResponse = { path: resolved.abs, entries, truncated };
  sendJson(res, 200, body);
}

/**
 * Dirent → 对外类型。顺序有意义：符号链接必须第一个判——`withFileTypes` 的类型信息
 * 不跟随链接，一个指向目录的 symlink 在这里是 symlink，不是 dir。
 */
function entryType(item: Dirent): FileEntryType {
  if (item.isSymbolicLink()) return "symlink";
  if (item.isDirectory()) return "dir";
  if (item.isFile()) return "file";
  return "other"; // FIFO / socket / 设备
}
