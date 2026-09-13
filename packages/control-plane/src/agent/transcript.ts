/**
 * `transcript.ts` —— 一次 Run 的完整轨迹（Phase 11 §7）。
 *
 * 【为什么是 JSONL 文件而不是 DB】一次 Run 的 transcript 可能几十 MB（每轮的请求都带着
 * 完整的 messages，工具结果按 50 KiB 一条算），塞 jsonb 是自找麻烦。落本地文件、
 * Run 结束时上传对象存储（`runs/<runId>/transcript.jsonl`），DB 里只留一行 artifact。
 *
 * 【为什么每轮都写完整的 system + tools + messages】README 的设计原则是"一切可回放"：
 * 模型看到了什么，必须能事后原样重现。只存"增量"的话，回放要靠重跑拼装逻辑——
 * 而拼装逻辑本身就是被怀疑的那个东西。代价是体积，收益是"打开这个文件就能看到
 * 第 7 轮模型到底收到了什么"。
 *
 * 【写失败不弄死 Run】transcript 是**证据**，不是流程的一部分。磁盘满、inode 用完
 * 只该让这一次 Run 的"可回放"打折扣，不该让一个已经改了 20 分钟代码的 Run 归零。
 * 所以 `append()` 吞掉异常、记日志、把失败挂在 `failure` 上；Run 结果里如实写出来。
 *
 * 【为什么用 appendFile 而不是 createWriteStream】一次 Run 只有几十到几百条记录，
 * 每条一次 `appendFile` 的代价可以忽略；换来的是"没有流的两套生命周期"——
 * 不用管背压、不用管 close 顺序、不会在进程被 kill 时留下一个半截缓冲区。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { StoredObject } from "../artifacts/store.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import { artifactKey } from "../artifacts/offload.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { runDirOf } from "../repo/clone.ts";

/** 一次 Run 的 transcript 落点：`/tmp/reuben-cloud-cp/<runId>/transcript.jsonl`（§0.1）。 */
export function transcriptPathOf(runId: string, root?: string): string {
  return path.join(root === undefined ? runDirOf(runId) : runDirOf(runId, root), "transcript.jsonl");
}

export interface TranscriptOptions {
  runId: string;
  /** 覆盖落点（测试用临时目录）。 */
  path?: string;
  log?: LogFn;
}

export class Transcript {
  readonly runId: string;
  readonly path: string;

  #records = 0;
  #bytes = 0;
  #failure: Error | null = null;
  #chain: Promise<void> = Promise.resolve();
  readonly #log: LogFn;

  private constructor(options: TranscriptOptions, filePath: string) {
    this.runId = options.runId;
    this.path = filePath;
    this.#log = options.log ?? noopLog;
  }

  /** 建好目录、打开（截断）文件。同名 runId 重跑时不留上一次的记录。 */
  static async create(options: TranscriptOptions): Promise<Transcript> {
    const filePath = options.path ?? transcriptPathOf(options.runId);
    await mkdir(path.dirname(filePath), { recursive: true });
    // 空文件先落一个：`upload()` 在"一条记录都没写"时也能传一个合法的空对象上去。
    await appendFile(filePath, "");
    return new Transcript(options, filePath);
  }

  /** 记录条数。 */
  get recordCount(): number {
    return this.#records;
  }

  /** 已经写进去的字节数（估算，用于日志与 Run 结果）。 */
  get bytes(): number {
    return this.#bytes;
  }

  /** 写失败的原因。null = 一切正常。 */
  get failure(): Error | null {
    return this.#failure;
  }

  /**
   * 追加一条记录。`type` 与时间戳由这里补，调用方只给内容。
   *
   * 写是**串行**的：连续调用不会交错，也不会因为并发 append 把两行 JSON 搅在一起。
   * 失败不抛（见文件头），但会置 `failure` 并打一条 error 日志。
   */
  async append(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const line = `${JSON.stringify({ type, ts: new Date().toISOString(), ...payload })}\n`;
    this.#chain = this.#chain.then(async () => {
      try {
        await appendFile(this.path, line);
        this.#records += 1;
        this.#bytes += Buffer.byteLength(line);
      } catch (error) {
        this.#failure ??= error instanceof Error ? error : new Error(String(error));
        this.#log("error", `transcript 写入失败（Run 继续，但这一轮无法回放）`, {
          path: this.path,
          error: this.#failure.message,
        });
      }
    });
    await this.#chain;
  }

  /**
   * 上传到对象存储（spec：`runs/<runId>/transcript.jsonl`）。**流式**：几十 MB 的
   * transcript 不进 CP 的内存。等所有写入排空之后再读文件，免得传到一半的内容。
   */
  async upload(store: ArtifactStore): Promise<StoredObject> {
    await this.#chain;
    return store.put(artifactKey.transcript(this.runId), createReadStream(this.path));
  }
}
