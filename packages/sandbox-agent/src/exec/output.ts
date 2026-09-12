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
 *
 * 【在链路中的位置】spawn.ts 里每个执行 new 两个（out / err），进程每吐一块数据就
 * `push()` 进来，攒够了调 `onChunk` 回调 → spawn.ts 的 emitChunk() → 事件总线。
 * 它只做"攒 + 切块"，不关心截断和预算（那是 emitChunk 的事）。
 */

import { StringDecoder } from "node:string_decoder";

/** OutputMerger 的构造参数。 */
export interface OutputMergerOptions {
  /** 单次 flush 的字节阈值，默认 64 KiB。 */
  chunkBytes: number;
  /** 距上次 flush 的毫秒阈值，默认 100ms。 */
  flushIntervalMs: number;
  /**
   * 攒够一块时往哪儿送。**同步调用**，不要在里面做 await。
   *
   * @param text 解码后的文本
   * @param bytes 对应的**原始字节数**（不是字符数，也不是 text 的字节数：
   *              非法 UTF-8 会被解码成 U+FFFD，两者会不一致）
   */
  onChunk: (text: string, bytes: number) => void;
}

/**
 * 一个流的合并器。生命周期：不断 push() → 进程结束时 end()。
 *
 * 内部状态就三样：
 *  - #decoder：处理跨 chunk 的半个多字节字符（UTF-8 增量解码）
 *  - #parts / #bytes：攒着的文本片段和它们的原始字节数
 *  - #timer：时间阈值那一半（"100ms 到了也得发"）
 */
export class OutputMerger {
  // 以下全部是"私有字段"：`#` 开头的字段外部**根本访问不到**（不是约定，是语言强制）。
  // 这是刻意的——合并器的内部状态只有它自己能改，外面只能通过 push/flush/end 操作。
  #options: OutputMergerOptions;
  #decoder = new StringDecoder("utf8");
  #parts: string[] = [];
  #bytes = 0;
  #timer: NodeJS.Timeout | null = null;
  #ended = false;

  constructor(options: OutputMergerOptions) {
    this.#options = options;
  }

  /**
   * 喂进来一块原始字节（来自 child.stdout / stderr 的 'data' 事件）。
   *
   * 三种情况会触发一次 flush：
   *  1. 攒着的加上新来的会超过 chunkBytes → 先把旧的发出去，再收新的
   *     （不这么做，单条事件就可能变成 120 KiB，等于白合并）
   *  2. 攒着的已经 ≥ chunkBytes → 立刻发
   *  3. 没到阈值 → 只是启动 100ms 定时器，等时间到
   */
  push(buf: Buffer): void {
    if (this.#ended || buf.length === 0) return;

    // 先 flush 再追加，保证单条事件不超过 chunkBytes（合并成 120 KiB 的块就白合并了）。
    if (this.#bytes > 0 && this.#bytes + buf.length > this.#options.chunkBytes) this.flush();

    const text = this.#decoder.write(buf);
    // 注意记的是 buf.length（原始字节），不是 text.length（字符串长度）。
    // 一个中文才 1 个"字符"但要 3 个字节，字节数才是"输出量"的真相。
    this.#bytes += buf.length;
    if (text.length > 0) this.#parts.push(text);

    if (this.#bytes >= this.#options.chunkBytes) {
      this.flush();
    } else if (this.#parts.length > 0) {
      this.#arm();
    }
  }

  /** 立刻把攒着的东西交出去，并取消定时器。空攒的时候什么也不做。 */
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

  /** 进程退出前调用：把 decoder 里残留的尾巴也吐出来。之后再 push 就无效了。 */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const tail = this.#decoder.end();
    if (tail.length > 0) this.#parts.push(tail);
    this.flush();
  }

  /** 启动 100ms 定时器（已经有一个了就不重复启动）。 */
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
