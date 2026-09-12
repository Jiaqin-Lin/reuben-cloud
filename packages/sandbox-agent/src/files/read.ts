/**
 * `GET /files` —— 读文件。两种响应形状：
 *   - 默认（内联 JSON）：`{path, size, sha256, encoding, offset, bytes, content}`
 *   - `raw=1`：`application/octet-stream` 流式吐出（CP 读大日志、读超限 patch 走这条路）
 *
 * 路径校验全部走 `RootResolver.resolve`（读多根），本文件不自己判路径。
 *
 * 【limit 的语义】这是这条路由最容易看错的一处，所以写在最前面：
 *   - **不传 `limit`**：内联 JSON 读的上限是 `maxReadBytes`（默认 1 MiB）。剩余部分超过它
 *     就 413 `too_large`——**不静默截断**，理由和 `timeoutMs` 一样：调用方会误以为自己
 *     拿到了全文。要读大文件就显式传 `offset`+`limit` 分片，或者用 `raw=1`。
 *   - **传了 `limit`**：只要 ≤ `maxReadBytes` 就一定是「返回这一段」，哪怕文件还有更多。
 *     否则分片读永远拿不到第一片（每一片都会因为"后面还有"而被 413）。
 *   - **`raw=1` 不传 `limit`**：从 `offset` 到文件末尾全部流出去。流式响应没有内联 JSON
 *     那种内存与 base64 膨胀问题，所以不受 1 MiB 约束；传了 `limit` 则仍按范围切。
 *
 * 【非法 UTF-8】一律 400 `invalid_utf8`，不静默替换成 U+FFFD——静默替换会让
 * "读到的内容和真实内容不同"这件事无人察觉。不做二进制探测：猜会猜错，让调用方说。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Config } from "../config.ts";
import { sendError, sendFsError, sendJson, parseUint } from "../http.ts";
import { resolveFailureError, type RootResolver } from "../paths.ts";
import type { FileReadEncoding, FileReadResponse } from "../types.ts";

/**
 * 处理一条 `GET /files`。响应完全由本函数发出（成功/失败都是），
 * server.ts 只负责把 URL 转交过来。
 */
export async function handleFileRead(
  res: ServerResponse,
  url: URL,
  roots: RootResolver,
  config: Config,
): Promise<void> {
  const requested = url.searchParams.get("path");
  if (requested === null) {
    sendError(res, 400, "missing_path", "query parameter `path` is required");
    return;
  }
  const resolved = roots.resolve(requested);
  if (!resolved.ok) {
    sendJson(res, 400, resolveFailureError(resolved.reason, roots, false));
    return;
  }

  const params = url.searchParams;

  const raw = parseRaw(params.get("raw"));
  if (raw === "invalid") {
    sendError(res, 400, "invalid_raw", "raw must be `1`/`true` (stream) or `0`/`false` (JSON)");
    return;
  }

  const encoding = parseEncoding(params.get("encoding"));
  if (encoding === null) {
    sendError(res, 400, "invalid_encoding", "encoding must be `utf8` or `base64`");
    return;
  }

  const offsetParam = params.get("offset");
  const offset = offsetParam === null ? 0 : parseUint(offsetParam);
  if (offset === null) {
    sendError(res, 400, "invalid_range", "offset must be a non-negative integer (bytes)");
    return;
  }

  const limitParam = params.get("limit");
  const limit = limitParam === null ? null : parseUint(limitParam);
  if (limitParam !== null && (limit === null || limit === 0)) {
    sendError(res, 400, "invalid_range", "limit must be a positive integer (bytes)");
    return;
  }
  if (limit !== null && limit > config.maxReadBytes) {
    // 显式 limit 的天花板也是 maxReadBytes：它是"单次内联读"的上限，不是"单次读"的上限。
    sendError(res, 413, "too_large", `limit must not exceed ${config.maxReadBytes} bytes`, {
      limit: config.maxReadBytes,
    });
    return;
  }

  let info: Stats;
  try {
    info = await stat(resolved.abs);
  } catch (err) {
    // ENOENT → 404（不存在），EACCES → 403，其余 → 500，都在 sendFsError 里。
    sendFsError(res, err, "read");
    return;
  }
  if (info.isDirectory()) {
    sendError(res, 400, "is_directory", "this path is a directory; use GET /files/list");
    return;
  }
  if (!info.isFile()) {
    // FIFO/socket/设备：读它们可能永远阻塞，明确拒掉比挂着好。
    sendError(res, 400, "not_a_file", "only regular files can be read");
    return;
  }

  const size = info.size;
  const available = Math.max(0, size - offset);

  // 没传 limit 的内联读：剩余部分超过上限就拒。注意这里**不**退回"读前 1 MiB"——
  // 静默截断正是本项目到处在避免的东西（见 timeoutMs 的规矩）。
  if (!raw && limit === null && available > config.maxReadBytes) {
    sendError(
      res,
      413,
      "too_large",
      `file has ${available} bytes from offset ${offset}, over the ${config.maxReadBytes}-byte ` +
        "inline limit; page through it with offset/limit, or use raw=1",
      { limit: config.maxReadBytes, size },
    );
    return;
  }

  // 实际读多少：显式 limit → 取 limit 与剩余部分的较小值；raw 不传 limit → 剩余全部。
  const bytesToRead =
    limit !== null
      ? Math.min(limit, available)
      : raw
        ? available
        : Math.min(available, config.maxReadBytes);

  if (raw) {
    await streamRange(res, resolved.abs, offset, bytesToRead);
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await readRange(resolved.abs, offset, bytesToRead);
  } catch (err) {
    sendFsError(res, err, "read");
    return;
  }

  let content: string;
  if (encoding === "base64") {
    // 原字节往返，不猜、不嗅探。
    content = buffer.toString("base64");
  } else {
    const text = decodeUtf8(buffer);
    if (text === null) {
      sendError(
        res,
        400,
        "invalid_utf8",
        "the requested byte range is not valid UTF-8 (binary file, or offset/limit split a " +
          "multi-byte character); retry with encoding=base64",
      );
      return;
    }
    content = text;
  }

  const body: FileReadResponse = {
    path: resolved.abs,
    size,
    // 只覆盖本次返回的那段字节：范围读时算全文哈希没有意义。
    sha256: createHash("sha256").update(buffer).digest("hex"),
    encoding,
    offset,
    bytes: buffer.length,
    content,
  };
  sendJson(res, 200, body);
}

/**
 * raw 模式：把 `[offset, offset+length)` 直接接到 HTTP 响应上。
 * 用 `pipeline` 而不是 `stream.pipe(res)`：它会顺手处理中途出错时的销毁，
 * 客户端断开时也不会留下一个继续读文件的句柄。
 */
async function streamRange(
  res: ServerResponse,
  abs: string,
  offset: number,
  length: number,
): Promise<void> {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": length,
    "Cache-Control": "no-store",
  });
  if (length === 0) {
    // 空范围（空文件 / offset 在 EOF 之后）：没有可读的内容，直接收尾。
    // 不能给 createReadStream 传 end < start，那会抛 ERR_OUT_OF_RANGE。
    res.end();
    return;
  }
  try {
    await pipeline(createReadStream(abs, { start: offset, end: offset + length - 1 }), res);
  } catch {
    // 头已经发出去了，没法再回一个 500；能做的只有把连接拆掉，别让对端傻等。
    res.destroy();
  }
}

/**
 * 按字节范围读进内存。上限已经由调用方守住（≤ maxReadBytes），所以这里是安全的。
 *
 * 用"open 一次 + 循环 read"而不是 `readFile`：readFile 没有 offset/limit，
 * 而按范围读是这条路由的常规用法（模型分片读外置结果）。
 */
async function readRange(abs: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(abs, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) break; // 文件在 stat 之后变短了：有多少给多少
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/** 严格 UTF-8 解码：非法字节返回 null（而不是 U+FFFD）。 */
function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * 解析 raw 参数。返回 "invalid" 表示传了但值不认识——宁可 400 也不要把 `raw=ture`
 * 这种拼错静默当成"不要 raw"（那正好和调用方想要的相反）。
 */
function parseRaw(value: string | null): boolean | "invalid" {
  if (value === null) return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return "invalid";
}

/** 解析 encoding。缺省 utf8；`utf-8` 是顺手接受的别名，其余一律 400。 */
function parseEncoding(value: string | null): FileReadEncoding | null {
  if (value === null || value === "utf8" || value === "utf-8") return "utf8";
  if (value === "base64") return "base64";
  return null;
}
