/**
 * 无依赖 ULID：48 位毫秒时间戳 + 80 位随机，Crockford base32 编码，26 字符。
 *
 * 【为什么这里有一份和 sandbox-agent 一样的实现】spec §0.4 明确**不做
 * `packages/shared`**：两层之间只有 HTTP 契约。但 ULID 不是契约，是个 40 行的纯函数，
 * 而 CP 需要自己的 id 前缀（`sbx_` / `art_`，沙箱侧是 `exe_`）。
 * 为它建一个共享包等于把"沙箱加一个字段 CP 要不要重编译"这条边界重新打开一次。
 *
 * 【为什么不用 crypto.randomUUID()】§0.1：id 要能直接按时间排序
 * （日志文件名、DB 主键、容器标签都靠这个）。随机 UUID 丢掉的是这个性质。
 *
 * 实现在沙箱侧已经被 `test/ulid.test.ts` 覆盖过一遍，这里的断言只验证"前缀 + 时间序"，
 * 不去重测编码细节——两份实现的**契约**是同一个，这才是要盯住的东西。
 */

import { getRandomValues } from "node:crypto";

/** Crockford base32：去掉 I / L / O / U，避免肉眼混淆。 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 前 10 个字符装时间戳（48 位 → 50 位容器，高位补 0）。 */
const TIME_CHARS = 10;
/** 后 16 个字符装随机数（80 位）。 */
const RANDOM_CHARS = 16;

/**
 * 生成一个 ULID：全局唯一、而且**字典序 = 时间序**。
 *
 * @param now 毫秒时间戳。默认取当前时间；测试传固定值来验证排序性质。
 * @returns 26 个字符的字符串。
 */
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

/** 带前缀的 id：`sbx_01H…` / `exe_01H…` / `art_01H…`。 */
export function prefixedId(prefix: string, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}
