/**
 * 无依赖 ULID：48 位毫秒时间戳 + 80 位随机，Crockford base32 编码，26 字符。
 *
 * 为什么不用 crypto.randomUUID()：日志文件名、DB 主键、容器标签里都要能按时间排序。
 * 这个文件保持零依赖是刻意的——它是 `dependencies: {}` 的一部分。
 *
 * 【在链路中的位置】最底层的小工具，被 exec/registry.ts 调用来生成 execution_id。
 * 它不依赖仓库里任何其他文件，所以想先热身就从这里开始读。
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
 *
 * 两条性质是它存在的理由：
 *  1. 同毫秒内靠随机部分也不会重复（10 字节密码学随机）。
 *  2. 直接按字符串排序就等于按创建时间排序——日志文件名、DB 主键都靠这个。
 */
export function ulid(now: number = Date.now()): string {
  const chars: string[] = new Array(TIME_CHARS + RANDOM_CHARS);

  // 时间戳：48 位 → 10 个字符（50 位容器，高位补 0）。2^48 < 2^53，Number 精度安全。
  // 从后往前填：先算出最低位（取模 32），再整除 32 往前进位——就是"十进制转 32 进制"。
  let time = Math.floor(now);
  for (let i = TIME_CHARS - 1; i >= 0; i -= 1) {
    chars[i] = ENCODING[time % 32];
    time = Math.floor(time / 32);
  }

  // 随机：80 位 → 16 个字符。分两个 40 位半区，各自 < 2^53。
  // 为什么要分半区：80 位整数超过 Number 的安全整数范围（2^53），一次读会丢精度。
  const bytes = getRandomValues(new Uint8Array(10));
  for (let half = 0; half < 2; half += 1) {
    // 把 5 个字节（40 位）拼成一个 Number。`bytes[...]!` 末尾的 `!` 是告诉 TS
    // "我保证这个下标取得到值"（数组越界在类型上是 undefined），否则类型对不上。
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      value = value * 256 + bytes[half * 5 + i]!;
    }
    // 同样从后往前：把这个 40 位数字转成 8 个 base32 字符。
    for (let i = 7; i >= 0; i -= 1) {
      chars[TIME_CHARS + half * 8 + i] = ENCODING[value % 32];
      value = Math.floor(value / 32);
    }
  }

  return chars.join("");
}
