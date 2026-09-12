/**
 * 日志文件：stdout + stderr 交错写入同一个文件，无标记——和终端里看到的一致。
 * 想分离看事件流或 DB 里的字节计数。
 *
 * 两件必须做对的事：
 *  1) **上限**（默认 256 MiB）。日志落在 tmpfs 上，tmpfs 页面计入 cgroup 内存；
 *     不设上限时一个 `yes` 就能把整个容器 OOM 掉（附录 A-9）。到上限后停止写、
 *     置 log_truncated，但**命令继续跑**。
 *  2) **写失败不能弄死执行**（磁盘满、inode 用完）：记 error、发事件说明、继续跑。
 */

import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";

export interface LogFileOptions {
  path: string;
  maxBytes: number;
  onError: (message: string) => void;
  onTruncated: (limit: number) => void;
}

export class LogFile {
  readonly path: string;

  #options: LogFileOptions;
  #stream: WriteStream;
  #bytes = 0;
  #truncated = false;
  #failed = false;
  #ended = false;
  #finished: Promise<void>;
  #resolveFinished: () => void = () => {};

  constructor(options: LogFileOptions) {
    this.path = options.path;
    this.#options = options;
    this.#finished = new Promise<void>((resolve) => {
      this.#resolveFinished = resolve;
    });

    this.#stream = createWriteStream(this.path, { flags: "a" });
    this.#stream.on("error", (err: Error) => this.#fail(err));
    this.#stream.on("finish", () => this.#resolveFinished());
    this.#stream.on("close", () => this.#resolveFinished());
  }

  get bytes(): number {
    return this.#bytes;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get failed(): boolean {
    return this.#failed;
  }

  write(buf: Buffer): void {
    if (this.#failed || this.#truncated || this.#ended) return;

    const room = this.#options.maxBytes - this.#bytes;
    if (room <= 0) {
      this.#markTruncated();
      return;
    }

    try {
      if (buf.length > room) {
        // 写到上限为止：文件长度恰好等于 maxBytes，行为可预测。
        this.#stream.write(buf.subarray(0, room));
        this.#bytes += room;
        this.#markTruncated();
        return;
      }
      this.#stream.write(buf);
      this.#bytes += buf.length;
    } catch (err) {
      this.#fail(err as Error);
    }
  }

  /** 等日志落盘。带 1s 上限——不能因为一个卡住的写流把终态事件无限期推迟。 */
  async end(): Promise<void> {
    if (!this.#ended) {
      this.#ended = true;
      try {
        this.#stream.end();
      } catch {
        this.#resolveFinished();
      }
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1000);
      timer.unref();
    });
    await Promise.race([this.#finished, timeout]);
    if (timer !== undefined) clearTimeout(timer);
  }

  #markTruncated(): void {
    if (this.#truncated) return;
    this.#truncated = true;
    this.#options.onTruncated(this.#options.maxBytes);
  }

  #fail(err: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#resolveFinished();
    this.#options.onError(err.message);
  }
}
