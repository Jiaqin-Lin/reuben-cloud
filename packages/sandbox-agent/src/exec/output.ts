/**
 * 输出合并器：stdout / stderr 各一个，互相独立。
 *
 * 规则（§C.2）：累积到 ≥64KiB 或距上次 flush ≥100ms，先到先发。
 *
 * 用 StringDecoder 做**增量解码**是这里的核心——裸 Buffer.toString() 会把跨 chunk 的
 * 多字节字符切成乱码。中文输出、emoji、任何非 ASCII 都会踩到，而且是偶发。
 *
 * 顺流顺序保证：同一流内严格有序（单线程事件循环 + 单合并器）。
 * stdout 与 stderr 之间**不保证时序**（OS 层面本来就不保证）——不要去"修"它。
 */

import { StringDecoder } from "node:string_decoder";

export interface OutputMergerOptions {
  /** 单次 flush 的字节阈值，默认 64 KiB。 */
  chunkBytes: number;
  /** 距上次 flush 的毫秒阈值，默认 100ms。 */
  flushIntervalMs: number;
  /**
   * @param text 解码后的文本
   * @param bytes 对应的**原始字节数**（不是字符数，也不是 text 的字节数：
   *              非法 UTF-8 会被解码成 U+FFFD，两者会不一致）
   */
  onChunk: (text: string, bytes: number) => void;
}

export class OutputMerger {
  #options: OutputMergerOptions;
  #decoder = new StringDecoder("utf8");
  #parts: string[] = [];
  #bytes = 0;
  #timer: NodeJS.Timeout | null = null;
  #ended = false;

  constructor(options: OutputMergerOptions) {
    this.#options = options;
  }

  push(buf: Buffer): void {
    if (this.#ended || buf.length === 0) return;

    // 先 flush 再追加，保证单条事件不超过 chunkBytes（合并成 120 KiB 的块就白合并了）。
    if (this.#bytes > 0 && this.#bytes + buf.length > this.#options.chunkBytes) this.flush();

    const text = this.#decoder.write(buf);
    this.#bytes += buf.length;
    if (text.length > 0) this.#parts.push(text);

    if (this.#bytes >= this.#options.chunkBytes) {
      this.flush();
    } else if (this.#parts.length > 0) {
      this.#arm();
    }
  }

  flush(): void {
    this.#clearTimer();
    // parts 为空说明只有半个多字节字符还在 decoder 里：字节数留着，等下一个 chunk 一起算。
    if (this.#parts.length === 0) return;

    const text = this.#parts.join("");
    const bytes = this.#bytes;
    this.#parts = [];
    this.#bytes = 0;
    this.#options.onChunk(text, bytes);
  }

  /** 进程退出前调用：把 decoder 里残留的尾巴也吐出来。 */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const tail = this.#decoder.end();
    if (tail.length > 0) this.#parts.push(tail);
    this.flush();
  }

  #arm(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#options.flushIntervalMs);
    // 不让定时器吊住进程（优雅退出时尤其重要）。
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
