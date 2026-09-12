/**
 * `PUT /files` —— 流式写文件。
 *
 * 【Body 是裸字节】不解析 `multipart/form-data`：CP 传的是 `repo.tar.gz`，它自己知道
 * 怎么打包；解析 multipart 是纯粹的额外代码。但要**显式拒绝**它——不解析又不说，
 * multipart 的边界字符串就会被当成文件内容静默写进去。
 *
 * 【原子性】先写 `{path}.part-{rand}`，成功后 `rename` 覆盖。半途失败的目标目录里
 * 只会剩下一个临时文件（会被删掉），绝不会留下半个 tar。
 *
 * 【上限与断开】超限要删临时文件、回 413、并且**断开请求流**：只回 413 不断开的话
 * 客户端还在往上灌几百 MiB，连接会吊住。顺序是重点——先 destroy 的话 413 会被
 * socket 销毁吃掉，CP 只能看到 connection reset、分不清原因。实现是
 * `res.once("finish", () => req.destroy())` 之后再发响应。
 *
 * 【路径校验】走 `RootResolver.resolve(..., {forWrite:true})`：写只看 writeRoot。
 * 注意解析结果可能是符号链接指向的真实路径，rename 落在真实路径上（落点仍然在校验过的
 * 范围内）——这是"跟随符号链接写"的语义，和 `open()` 一致。
 */

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Config } from "../config.ts";
import { sendError, sendFsError, sendJson, parseUint } from "../http.ts";
import { resolveFailureError, type RootResolver } from "../paths.ts";
import type { FileWriteResponse } from "../types.ts";

/**
 * 处理一条 `PUT /files`。响应完全由本函数发出（成功/失败都是），
 * server.ts 只负责把请求和 URL 转交过来。
 */
export async function handleFileWrite(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  roots: RootResolver,
  config: Config,
): Promise<void> {
  const requested = url.searchParams.get("path");
  if (requested === null) {
    rejectAndDisconnect(req, res, 400, "missing_path", "query parameter `path` is required");
    return;
  }
  const resolved = roots.resolve(requested, { forWrite: true });
  if (!resolved.ok) {
    // 越界和参数不合法都是 400，但措辞不同（resolveFailureError 统一负责）。
    // 这些分支一律不读 body，所以顺手把连接断掉，免得客户端往上灌一个没人要的 tar。
    const body = resolveFailureError(resolved.reason, roots, true);
    rejectAndDisconnect(req, res, 400, body.error, typeof body.message === "string" ? body.message : undefined);
    return;
  }
  const target = resolved.abs;

  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) {
    rejectAndDisconnect(
      req,
      res,
      400,
      "invalid_content_type",
      "body must be raw bytes; multipart/form-data is not parsed",
    );
    return;
  }

  // Content-Length 头如果已经超标，连读都不用读——直接拒。
  // 这只是快捷路径：撒谎的客户端和 chunked 编码走下面的流式计数。
  const declaredValue = req.headers["content-length"];
  const declared = declaredValue === undefined ? null : parseUint(declaredValue);
  if (declared !== null && declared > config.maxWriteBytes) {
    rejectAndDisconnect(req, res, 413, "too_large", `body is ${declared} bytes, limit is ${config.maxWriteBytes}`, {
      limit: config.maxWriteBytes,
    });
    return;
  }

  // 目标是目录 → 400：不判的话 rename 会以 EISDIR/ENOTEMPTY 报出来，像内部错误。
  const existing = await lstat(target).catch(() => null);
  if (existing?.isDirectory() === true) {
    rejectAndDisconnect(req, res, 400, "is_directory", "cannot replace a directory with a file");
    return;
  }

  // 自动 mkdir -p 父目录：CP 灌 tar 之前不必先跑一次 exec mkdir。
  try {
    await mkdir(path.dirname(target), { recursive: true });
  } catch (err) {
    rejectAndDisconnect(req, res, 500, "internal_error", `cannot create parent directory: ${errnoMessage(err)}`);
    return;
  }

  // 临时文件与目标同目录：rename 只在同一个文件系统内是原子的。
  // flags "wx" = 独占创建，撞名（不可能，随机 8 位十六进制）直接报错而不是覆盖。
  const tempPath = `${target}.part-${randomBytes(4).toString("hex")}`;
  const hash = createHash("sha256");
  let size = 0;
  let tooLarge = false;

  // 源：把请求体原样转发，同时做三件事——计数、算哈希、判上限。
  // 用异步生成器而不是先把 body 读成 Buffer：256 MiB 的 tar 不允许在内存里出现第二份。
  async function* bodyChunks(): AsyncGenerator<Buffer> {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > config.maxWriteBytes) {
        tooLarge = true;
        // 直接结束生成器：pipeline 会正常收尾，临时文件是个半成品，下面按 tooLarge 走 413。
        return;
      }
      hash.update(buf);
      yield buf;
    }
  }

  let failure: Error | null = null;
  try {
    await pipeline(bodyChunks(), createWriteStream(tempPath, { flags: "wx" }));
  } catch (err) {
    failure = err as Error;
  }

  if (tooLarge) {
    // 先删临时文件再回响应：否则一次超限上传会在目标目录里留一个几百 MiB 的垃圾。
    await unlink(tempPath).catch(() => {});
    rejectAndDisconnect(req, res, 413, "too_large", `body exceeds ${config.maxWriteBytes} bytes`, {
      limit: config.maxWriteBytes,
    });
    return;
  }

  if (failure !== null) {
    await unlink(tempPath).catch(() => {});
    if (isClientAbort(failure, req)) {
      // 客户端自己断了：没有目标文件，也没有 .part——正是我们要的。
      sendError(res, 400, "upload_aborted", "client disconnected before the body was complete");
      return;
    }
    // 写失败（磁盘满、权限……）：清掉半成品，把真实 errno 报出去。
    rejectFsError(req, res, failure, "write");
    return;
  }

  // 走到这里：body 完整、临时文件也完整。原子换名（同目录，POSIX rename 覆盖是原子的）。
  try {
    await rename(tempPath, target);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    sendFsError(res, err, "rename");
    return;
  }

  const body: FileWriteResponse = { path: target, size, sha256: hash.digest("hex") };
  sendJson(res, 200, body);
}

/**
 * 拒绝一个我们**不打算读**的请求体：先发响应，等它真的 flush 出去之后再断开请求流。
 * 反过来的顺序（先断开再发）会让响应被 socket 销毁吃掉。
 */
function rejectAndDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
  message?: string,
  extra?: Record<string, unknown>,
): void {
  res.once("finish", () => req.destroy());
  sendError(res, status, error, message, extra);
}

/** 同上，但状态码/错误码由 errno 决定（sendFsError 的那套映射）。 */
function rejectFsError(req: IncomingMessage, res: ServerResponse, err: unknown, action: string): void {
  res.once("finish", () => req.destroy());
  sendFsError(res, err, action);
}

/**
 * 客户端中途断开的判断。两个条件都要：请求体没读完（`req.complete === false`）
 * **且**错误长得像断线。只看前者会把"磁盘满导致 pipeline 顺手掐掉源流"也误判成
 * 客户端断线——那样 CP 会收到 upload_aborted，而真相是服务端没空间了。
 */
function isClientAbort(err: Error, req: IncomingMessage): boolean {
  if (req.complete) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE") return true;
  // Node 在请求被中断时给的是一个 message 为 "aborted" 的 Error（没有 code）。
  return err.message === "aborted";
}

/** 给 mkdir 失败拼一句人话。 */
function errnoMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
