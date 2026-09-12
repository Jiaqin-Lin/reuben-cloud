/**
 * 日志文件：stdout + stderr 交错写入同一个文件，无标记——和终端里看到的一致。
 * 想分离看事件流或 DB 里的字节计数。
 *
 * 两件必须做对的事：
 *  1) **上限**（默认 256 MiB）。日志落在 tmpfs 上，tmpfs 页面计入 cgroup 内存；
 *     不设上限时一个 `yes` 就能把整个容器 OOM 掉（附录 A-9）。到上限后停止写、
 *     置 log_truncated，但**命令继续跑**。
 *  2) **写失败不能弄死执行**（磁盘满、inode 用完）：记 error、发事件说明、继续跑。
 *
 * 【在链路中的位置】registry.ts 创建记录时 new 一个，spawn.ts 每收到一块输出就 write()，
 * 终态之前 await end() 确保落盘——CP 一收到终态事件就会去读这个文件。
 *
 * 【为什么要 `end(): Promise`】写文件是异步的（先写进 Node 的内存缓冲，再由内核刷盘）。
 * 想要"落盘之后才发终态事件"，就必须有个东西能 await，这就是 #finished 的用途。
 */

import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";

/** LogFile 的构造参数。三个回调都是"出事了告诉外面一声"，不是"让你决定怎么办"。 */
export interface LogFileOptions {
  /** 日志文件路径，形如 `{logRoot}/exe_01H....log`。 */
  path: string;
  /** 字节上限。写满就封口（继续发事件，只是不再往文件里写）。 */
  maxBytes: number;
  /** 写失败时调用。registry.ts 收到后发一条 stderr 事件说明情况。 */
  onError: (message: string) => void;
  /** 写满上限时调用一次。registry.ts 收到后发一条 truncated 事件。 */
  onTruncated: (limit: number) => void;
}

/**
 * 一个执行的日志文件。三种"意外结局"各自有一个标志位，外部通过 getter 查：
 *  - truncated：写满了上限，文件被提前封口
 *  - failed：写失败了（磁盘满、没权限……）
 *  - 无标志：正常
 * 终态事件的 log_truncated 字段就是从 truncated 读的。
 */
export class LogFile {
  /** 文件路径。readonly = 建好之后不能改（TS 层面的保护，防止代码里手滑赋值）。 */
  readonly path: string;

  #options: LogFileOptions;
  #stream: WriteStream;
  /** 已经写进去的字节数，用来判断有没有到上限。 */
  #bytes = 0;
  #truncated = false;
  #failed = false;
  #ended = false;
  /** 流真正关干净之后才会 resolve 的 Promise，end() 里 await 它。 */
  #finished: Promise<void>;
  #resolveFinished: () => void = () => {};

  constructor(options: LogFileOptions) {
    this.path = options.path;
    this.#options = options;

    // "手动 resolve 的 Promise"模式：把 resolve 函数存起来，将来在事件回调里调用它。
    // 这里存进 #resolveFinished，由下面的 'finish' / 'close' / #fail 三种情况触发。
    this.#finished = new Promise<void>((resolve) => {
      this.#resolveFinished = resolve;
    });

    // flags: "a" = append（追加）。为什么不是 "w"：文件名带 ULID，正常情况下不可能
    // 撞名；但如果真撞了（进程重启 + 时钟回拨），追加比静默覆盖更安全。
    this.#stream = createWriteStream(this.path, { flags: "a" });
    // 监听错误是必须的：Node 的流一旦报错而没人听，会直接抛成未捕获异常弄死进程。
    this.#stream.on("error", (err: Error) => this.#fail(err));
    this.#stream.on("finish", () => this.#resolveFinished());
    this.#stream.on("close", () => this.#resolveFinished());
  }

  /** 已经写进文件的字节数（不含被上限挡掉的部分）。 */
  get bytes(): number {
    return this.#bytes;
  }

  /** 是否因为超出 maxBytes 被提前封口。 */
  get truncated(): boolean {
    return this.#truncated;
  }

  /** 是否写失败过（写失败之后所有 write 都变成空操作）。 */
  get failed(): boolean {
    return this.#failed;
  }

  /**
   * 写一块输出。**永不出错**：任何失败都降级成"记一笔、不再写"，绝不上抛。
   *
   * 三种情况：
   *  1. 已经失败 / 已封口 / 已经 end 了 → 直接丢掉
   *  2. 这一块会超过上限 → 只写能塞下的那部分（文件长度**恰好**等于 maxBytes，
   *     行为可预测），然后封口
   *  3. 正常 → 写进去，累加字节数
   */
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

  /**
   * 收尾：关闭写流，并等它真的落盘。**这个 await 是终态顺序的一部分**——
   * spawn.ts 的 finalize() 会先 await 它，再发终态事件。
   *
   * 带 1s 上限：不能因为一个卡住的写流把终态事件无限期推迟（§：终态事件比日志完整性重要）。
   * 注意本方法是幂等的，重复调用只是重新 await 同一个 Promise。
   */
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
    // Promise.race = "谁先完成算谁"：正常落盘 vs 1s 超时。
    await Promise.race([this.#finished, timeout]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** 只通知一次"装满上限了"。 */
  #markTruncated(): void {
    if (this.#truncated) return;
    this.#truncated = true;
    this.#options.onTruncated(this.#options.maxBytes);
  }

  /** 只通知一次"我坏了"。同时 resolve #finished——都坏了就别让 end() 白等了。 */
  #fail(err: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#resolveFinished();
    this.#options.onError(err.message);
  }
}
