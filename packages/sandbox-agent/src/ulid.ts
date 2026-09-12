/**
 * 无依赖 ULID：48 位毫秒时间戳 + 80 位随机，Crockford base32 编码，26 字符。
 *
 * 为什么不用 crypto.randomUUID()：日志文件名、DB 主键、容器标签里都要能按时间排序。
 * 这个文件保持零依赖是刻意的——它是 `dependencies: {}` 的一部分。
 */

import { getRandomValues } from "node:crypto";

/** Crockford base32：去掉 I / L / O / U，避免肉眼混淆。 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

export function ulid(now: number = Date.now()): string {
  const chars: string[] = new Array(TIME_CHARS + RANDOM_CHARS);

  // 时间戳：48 位 → 10 个字符（50 位容器，高位补 0）。2^48 < 2^53，Number 精度安全。
  let time = Math.floor(now);
  for (let i = TIME_CHARS - 1; i >= 0; i -= 1) {
    chars[i] = ENCODING[time % 32];
    time = Math.floor(time / 32);
  }

  // 随机：80 位 → 16 个字符。分两个 40 位半区，各自 < 2^53。
  const bytes = getRandomValues(new Uint8Array(10));
  for (let half = 0; half < 2; half += 1) {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      value = value * 256 + bytes[half * 5 + i]!;
    }
    for (let i = 7; i >= 0; i -= 1) {
      chars[TIME_CHARS + half * 8 + i] = ENCODING[value % 32];
      value = Math.floor(value / 32);
    }
  }

  return chars.join("");
}
