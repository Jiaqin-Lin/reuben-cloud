/**
 * HTTP 层的公共零件：响应出口、鉴权、请求体读取。
 *
 * 从 server.ts 搬出来（Phase 2）：三个 `files/*` 处理器要发响应，而 server.ts 要 import
 * 它们——不搬就成循环依赖。搬出来的另一面是 server.ts 变回「只有路由」。
 *
 * 所有入口共用这一份实现，所以错误响应的形状、鉴权的比较方式不会有第二种写法。
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorResponse } from "./types.ts";

/** JSON 请求体（只有 `/exec` 用得上）的上限。argv 数组很小，但要有个头。 */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * 统一的 JSON 响应出口。**所有** JSON 响应都从这里走，保证头部一致。
 *
 * 三个"不能写了"的前置判断：已经发过头（写头部会抛 ERR_HEADERS_SENT）、
 * 已经结束（再写会抛 ERR_STREAM_WRITE_AFTER_END）、或者 socket 已经没了
 * （客户端中途断开，我们只是想把原本的 4xx 安静地丢掉，不要变成未捕获异常）。
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    if (!res.writableEnded) res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  res.end(json);
}

/**
 * sendJson 的语法糖，专给错误响应。文件 API 里错误分支比成功分支还多，
 * 少写一层 `{ error, message }` 的嵌套能让每个分支保持一行。
 *
 * @param extra 额外字段（`limit`、`activeExecution` 这类给 CP 做判断的结构化信息）。
 */
export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  message?: string,
  extra?: Record<string, unknown>,
): void {
  const body: ErrorResponse = { error, ...(message === undefined ? {} : { message }), ...extra };
  sendJson(res, status, body);
}

/**
 * 校验 `Authorization: Bearer <token>`。
 * 大小写不敏感（HTTP 标准），但 token 本身必须完全一致。
 * 先比长度再调 safeEqual——故意的：能在常数时间里比对的事情不要提前泄露信息。
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = "bearer ";
  if (header.length <= prefix.length) return false;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  return safeEqual(header.slice(prefix.length), token);
}

/**
 * 常数时间字符串比较，防"计时攻击"。
 *
 * 为什么不能用 `a === b`：JS 的字符串比较发现不同就立刻返回，
 * 于是"前缀对了几个字符"会反映在耗时上；攻击者可以逐字节把 token 猜出来。
 * timingSafeEqual 无论如何都比完全部字节。
 */
function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  // 长度不等直接返回 false —— timingSafeEqual 长度不等会抛异常。
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** readJsonBody 的返回：成功带解析结果，失败带该发的状态码和响应体。 */
export type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; body: ErrorResponse };

/**
 * 解析一个非负整数字符串（只认十进制数字）。三个 `files/*` 处理器共用
 * （offset / limit / depth / content-length 都走它）。
 *
 * 故意不用 `Number()` 直接转：`Number("")` 是 0、`Number("1e3")` 是 1000、
 * `Number(" 1")` 是 1，这些"宽容"会把参数错误悄悄放过去。
 */
export function parseUint(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * 把 fs 的 errno 翻成 HTTP 响应。三个 `files/*` 处理器共用：
 * ENOENT→404 / EACCES·EPERM·EROFS→403 / EISDIR·ENOTDIR→400 / 其余→500。
 * 403/404 也带上 message，方便 CP 日志里看到真实的 errno。
 */
export function sendFsError(res: ServerResponse, err: unknown, action: string): void {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
      sendError(res, 404, "not_found", `${action}: no such file or directory`);
      return;
    case "EACCES":
    case "EPERM":
    case "EROFS":
      sendError(res, 403, "permission_denied", `${action}: ${code}`);
      return;
    case "EISDIR":
      sendError(res, 400, "is_directory", `${action}: is a directory`);
      return;
    case "ENOTDIR":
      sendError(res, 400, "not_directory", `${action}: not a directory`);
      return;
    case "ENOSPC":
      sendError(res, 507, "internal_error", `${action}: no space left on device`);
      return;
    default:
      sendError(res, 500, "internal_error", `${action}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 把请求体读完并 JSON.parse。
 *
 * 这里只有三个分支：太大（413）、空的/不是 JSON（400）、读流时断了（400）。
 * 具体的字段校验不在这里——那是 spawn.ts 的 validateExecRequest 的事。
 * 分成两层是因为"是不是合法 JSON"和"字段合不合法"是两种不同的错误。
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        // 继续把流排干而不是 break：break 会销毁 socket，413 就送不出去了。
        // 超限之后不再累积，内存不随 body 增长。
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400, body: { error: "invalid_json", message: "request aborted" } };
  }

  if (tooLarge) {
    return { ok: false, status: 413, body: { error: "body_too_large", limit: MAX_BODY_BYTES } };
  }
  if (size === 0) {
    return { ok: false, status: 400, body: { error: "invalid_json", message: "empty body" } };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, body: { error: "invalid_json", message: "body is not valid JSON" } };
  }
}
