/**
 * `hub.ts` —— 观察窗的服务端：一次 Run 的事件缓冲 + 多订阅者广播（Phase 13）。
 *
 * 【为什么需要它，而不是让 SSE 端点直接挂在循环上】三件事只有在这里做才做得对：
 *  ① **重放**：浏览器断线重连（`EventSource` 自带 `Last-Event-ID`）要能接上断点，
 *     所以事件必须先落进一个有界的环形缓冲，而不是"发出去就没了"。Phase 1 的沙箱事件
 *     总线已经证明过这条路径必须存在（§C.2 的"重放空洞"）——这里是同一个问题的第二处。
 *  ② **多个订阅者**：刷新页面会短暂出现新旧两条连接，`curl -N` 调试时也会多一条。
 *  ③ **解耦**：循环只管 `emit()`，它不等待、也不知道有没有人在看（`emitEvent` 吞异常）。
 *
 * 【为什么文本增量要合并】`onText` 的粒度是 token：一次 40 轮的 Run 能产生上万条增量。
 * 逐条进来的话，环形缓冲会被它挤爆（工具结果、轮次标记全被淘汰），浏览器也要为一堆
 * 一两个字符的事件各跑一次布局。合并规则只有一条：**文本攒到 80ms 或下一条非文本事件
 * 到达时一起发**。语义没有损失（页面上本来就是连续的一段文字），代价是"最后一个词
 * 可能晚 80ms 出现"。
 *
 * 【两个上限都要有】条数（默认 2000）与字节数（默认 8 MiB）谁先到算谁：
 * 一次 `read` 的 tool_result 最大 50 KiB，光靠条数拦不住"2000 条大结果 = 100 MB"。
 * 淘汰从最老的开始，`#evictedThrough` 记住淘汰到哪儿了——请求的 `Last-Event-ID`
 * 落在淘汰区时，订阅者要先收到一条 `gap` 说明（"你漏了 id X..Y"），而不是静默少一段。
 *
 * 【不做持久化】缓冲只在内存里：CP 进程重启后页面拿到的是"这个 run 不存在"。
 * 那是 M0 的边界（spec §Phase 13 技术边界：不做回放控制），transcript.jsonl 才是长期证据。
 */

import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { RunEvent, RunEventSink } from "../agent/events.ts";

/** 缓冲里的一条事件。`id` 从 1 开始单调递增，**它就是 SSE 的 `Last-Event-ID`**。 */
export interface RunEventRecord {
  id: number;
  ts: string;
  event: RunEvent;
}

/** `/runs/{id}/info` 的响应体（UI 用它判断 run 是否存在，也是页面标题的来源）。 */
export interface RunInfo {
  runId: string;
  /** 这个 run 被登记进 hub 的时刻（不一定是循环的第一轮）。 */
  startedAt: string;
  /** 收到 `run_end` / `run_error` 的时刻。null = 还在跑。 */
  endedAt: string | null;
  status: "running" | "ended";
  model: string | null;
  issue: string | null;
  /** 当前缓冲里还有多少条（会被淘汰，所以不是"一共发生过多少条"）。 */
  bufferedEvents: number;
  /** 从开始到现在一共发过多少条（含已被淘汰的）。 */
  totalEvents: number;
  /** 缓冲里最后一条的 id（重连游标的上界）。 */
  lastEventId: number;
  bufferedBytes: number;
  subscribers: number;
  /** 只有 `run_end` 之后才有。 */
  stopReason: string | null;
  ok: boolean | null;
}

export interface RunHubOptions {
  /** 每个 run 的环形缓冲条数上限（默认 2000）。 */
  maxEventsPerRun?: number;
  /** 每个 run 的环形缓冲字节上限（默认 8 MiB）。 */
  maxBytesPerRun?: number;
  /** 内存里最多保留几个 run（默认 8），超出时淘汰最老的**已结束** run。 */
  maxRuns?: number;
  /** 单个订阅者积压的事件条数上限（默认 2000），超出丢最老的并发一条 gap。 */
  maxQueuedEvents?: number;
  /** 文本增量的合并窗口（毫秒，默认 80）。0 = 不合并（测试用）。 */
  textCoalesceMs?: number;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
  log?: LogFn;
}

export interface SubscribeOptions {
  /**
   * 从哪条之后开始。null = 从缓冲里最早的一条开始（首连的默认行为）。
   * 大于缓冲里的最大 id 时只跟新的（客户端比服务端新，例如服务端重启过）。
   */
  afterId?: number | null;
  /** 订阅者积压上限（覆盖 hub 的默认值）。 */
  maxQueuedEvents?: number;
  /** 关闭信号：SSE 响应一断，服务端就 abort 它。 */
  signal?: AbortSignal;
}

/** 没有 run 时 subscribe 返回 null；有 run 时返回一个异步迭代器（`for await` 消费）。 */
export class Subscription implements AsyncIterableIterator<RunEventRecord> {
  /** 重放部分（订阅那一刻的快照），先于实时队列消费。 */
  #replay: RunEventRecord[];
  #replayCursor = 0;
  /** 实时队列（有界）。 */
  #queue: RunEventRecord[] = [];
  #limit: number;
  #closed = false;
  #wake: (() => void) | null = null;
  /** 因积压被丢掉的条数与最后一条的 id（合并成一条 gap 说明）。 */
  #droppedCount = 0;
  #lastDroppedId: number | null = null;
  readonly #now: () => number;
  #detachAbort: (() => void) | null = null;

  constructor(replay: RunEventRecord[], options: { limit: number; now: () => number; signal?: AbortSignal }) {
    this.#replay = replay;
    this.#limit = Math.max(1, options.limit);
    this.#now = options.now;
    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) this.#closed = true;
      else {
        const onAbort = (): void => this.close();
        signal.addEventListener("abort", onAbort, { once: true });
        this.#detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /** 广播一条。**同步**：调用方（`RunHub.emit`）不该等一个慢消费者。 */
  push(record: RunEventRecord): void {
    if (this.#closed) return;
    if (this.#queue.length >= this.#limit) {
      const dropped = this.#queue.shift();
      if (dropped !== undefined) {
        this.#droppedCount += 1;
        this.#lastDroppedId = dropped.id;
      }
    }
    this.#queue.push(record);
    this.#wake?.();
  }

  /** 关闭：迭代器在把队列吐完之后结束。**幂等**。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachAbort?.();
    this.#detachAbort = null;
    this.#wake?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<RunEventRecord> {
    return this;
  }

  async next(): Promise<IteratorResult<RunEventRecord>> {
    for (;;) {
      const ready = this.#take();
      if (ready !== null) return ready;
      if (this.#closed) return { value: undefined, done: true };
      await this.#wait();
    }
  }

  async return(): Promise<IteratorResult<RunEventRecord>> {
    this.close();
    return { value: undefined, done: true };
  }

  /** 队列里下一条（重放优先，其次是积压的 gap 说明，最后是实时队列）。没有则 null。 */
  #take(): IteratorResult<RunEventRecord> | null {
    if (this.#replayCursor < this.#replay.length) {
      const value = this.#replay[this.#replayCursor]!;
      this.#replayCursor += 1;
      return { value, done: false };
    }
    if (this.#lastDroppedId !== null) {
      const id = this.#lastDroppedId;
      const count = this.#droppedCount;
      this.#lastDroppedId = null;
      this.#droppedCount = 0;
      return {
        value: {
          id,
          ts: new Date(this.#now()).toISOString(),
          event: {
            type: "note",
            turn: null,
            kind: "gap",
            message: `页面渲染跟不上，${count} 条事件被丢弃（Run 本身不受影响；重连后可以从断点补回来）`,
          },
        },
        done: false,
      };
    }
    const next = this.#queue.shift();
    return next === undefined ? null : { value: next, done: false };
  }

  #wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#wake = () => {
        this.#wake = null;
        resolve();
      };
    });
  }
}

/**
 * 一个 run 的缓冲与订阅者。私有类（外面的世界只该看到 `RunHub` 与 `Subscription`）。
 */
interface PerRunLimits {
  maxEventsPerRun: number;
  maxBytesPerRun: number;
  maxQueuedEvents: number;
}

class RunEntry {
  readonly runId: string;
  readonly startedAt: string;
  #sink: RunEventSink;

  #records: RunEventRecord[] = [];
  #bytes = 0;
  #seq = 0;
  #total = 0;
  /** 已经被淘汰的最大的 id（0 = 一条都没淘汰过）。重放时用它判断有没有空洞。 */
  #evictedThrough = 0;
  #subscribers = new Set<Subscription>();

  #pendingText = "";
  #flushTimer: NodeJS.Timeout | null = null;

  #model: string | null = null;
  #issue: string | null = null;
  #endedAt: string | null = null;
  #stopReason: string | null = null;
  #ok: boolean | null = null;

  readonly #options: PerRunLimits;
  readonly #coalesceMs: number;
  readonly #now: () => number;

  constructor(runId: string, options: RunHubOptions, resolved: PerRunLimits) {
    this.runId = runId;
    this.#options = resolved;
    this.#coalesceMs = Math.max(0, options.textCoalesceMs ?? 80);
    this.#now = options.now ?? Date.now;
    this.startedAt = new Date(this.#now()).toISOString();
    this.#sink = { emit: (event) => this.emit(event) };
  }

  get sink(): RunEventSink {
    return this.#sink;
  }

  get ended(): boolean {
    return this.#endedAt !== null;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * 收一条事件。文本走合并；其余事件先 flush 掉还没发的文本（**顺序不能乱**：
   * 文本属于它前面那一轮，先发 `tool_call` 再补上一段文字会让页面顺序错乱）。
   */
  emit(event: RunEvent): void {
    if (event.type === "text") {
      this.#pendingText += event.delta;
      if (this.#coalesceMs === 0) this.flushText();
      else if (this.#flushTimer === null) {
        this.#flushTimer = setTimeout(() => this.flushText(), this.#coalesceMs);
        // 别让一个合并窗口把进程吊住（run 结束后来不及 flush 的那一个词不重要）。
        this.#flushTimer.unref();
      }
      return;
    }
    this.flushText();
    this.#publish(event);
  }

  /** 把攒着的文本立刻发出去。没有攒着的东西时是 no-op。 */
  flushText(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#pendingText === "") return;
    const delta = this.#pendingText;
    this.#pendingText = "";
    this.#publish({ type: "text", delta });
  }

  #publish(event: RunEvent): void {
    this.#seq += 1;
    this.#total += 1;
    const record: RunEventRecord = { id: this.#seq, ts: new Date(this.#now()).toISOString(), event };
    this.#bytes += Buffer.byteLength(JSON.stringify(event));
    this.#records.push(record);
    this.#trim();
    this.#noteMeta(event);
    for (const subscriber of this.#subscribers) subscriber.push(record);
  }

  /** 环形缓冲的淘汰：条数与字节两条线，最老的先走（**至少留最新一条**）。 */
  #trim(): void {
    while (
      this.#records.length > 0 &&
      (this.#records.length > this.#options.maxEventsPerRun ||
        (this.#bytes > this.#options.maxBytesPerRun && this.#records.length > 1))
    ) {
      const dropped = this.#records.shift()!;
      this.#bytes -= Buffer.byteLength(JSON.stringify(dropped.event));
      this.#evictedThrough = dropped.id;
    }
  }

  #noteMeta(event: RunEvent): void {
    switch (event.type) {
      case "run_start":
        this.#model = event.model;
        this.#issue = event.issue;
        break;
      case "run_end":
        this.#endedAt = new Date(this.#now()).toISOString();
        this.#stopReason = event.stopReason;
        this.#ok = event.ok;
        break;
      case "run_error":
        this.#endedAt = new Date(this.#now()).toISOString();
        this.#ok = false;
        break;
      default:
        break;
    }
  }

  subscribe(options: SubscribeOptions): Subscription {
    const after = options.afterId ?? null;
    const replay: RunEventRecord[] = [];
    // 请求的游标落在淘汰区里：先给一条 gap，让客户端的游标跳到"最早的还在的"前面。
    // 它的 id 用 oldest.id - 1（比客户端当前的大、比下一条真实事件小），于是重连游标
    // 单调前进，不会因为一条说明而倒退。
    const oldest = this.#records[0];
    if (after !== null && oldest !== undefined && oldest.id > after + 1 && this.#evictedThrough > after) {
      replay.push({
        id: oldest.id - 1,
        ts: new Date(this.#now()).toISOString(),
        event: {
          type: "note",
          turn: null,
          kind: "gap",
          message: `缓冲里最早的 id 是 ${oldest.id}，你要的 ${after + 1} 已经被淘汰（最多保留 ${this.#options.maxEventsPerRun} 条）`,
        },
      });
    }
    for (const record of this.#records) {
      if (after === null || record.id > after) replay.push(record);
    }
    const subscriber = new Subscription(replay, {
      limit: options.maxQueuedEvents ?? this.#options.maxQueuedEvents,
      now: this.#now,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.#subscribers.add(subscriber);
    return subscriber;
  }

  /** 订阅者读完/断开时从集合里摘掉（幂等）。 */
  release(subscriber: Subscription): void {
    subscriber.close();
    this.#subscribers.delete(subscriber);
  }

  /** 服务器关停：结束所有订阅者（它们的 `for await` 会正常收尾）。 */
  closeAll(): void {
    this.flushText();
    for (const subscriber of this.#subscribers) subscriber.close();
    this.#subscribers.clear();
  }

  info(): RunInfo {
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      endedAt: this.#endedAt,
      status: this.#endedAt === null ? "running" : "ended",
      model: this.#model,
      issue: this.#issue,
      bufferedEvents: this.#records.length,
      totalEvents: this.#total,
      lastEventId: this.#seq,
      bufferedBytes: this.#bytes,
      subscribers: this.#subscribers.size,
      stopReason: this.#stopReason,
      ok: this.#ok,
    };
  }
}

/**
 * 多个 run 的 hub。**它不调度 run**：谁跑一个 run，谁 `ensure(runId)` 拿到 sink 并把它
 * 交给循环（`scripts/agent-run.ts` 就是这么接的）。
 */
export class RunHub {
  readonly #runs = new Map<string, RunEntry>();
  readonly #options: RunHubOptions;
  readonly #log: LogFn;

  constructor(options: RunHubOptions = {}) {
    this.#options = options;
    this.#log = options.log ?? noopLog;
  }

  /** 登记一个 run（幂等）并拿到它的 sink。 */
  ensure(runId: string): RunEventSink {
    const existing = this.#runs.get(runId);
    if (existing !== undefined) return existing.sink;
    const entry = new RunEntry(runId, this.#options, {
      maxEventsPerRun: this.#options.maxEventsPerRun ?? 2000,
      maxBytesPerRun: this.#options.maxBytesPerRun ?? 8 * 1024 * 1024,
      maxQueuedEvents: this.#options.maxQueuedEvents ?? 2000,
    });
    this.#runs.set(runId, entry);
    this.#evictRuns();
    return entry.sink;
  }

  info(runId: string): RunInfo | null {
    return this.#runs.get(runId)?.info() ?? null;
  }

  /** 最近登记的 run（`GET /` 跳到它）。没有就返回 null。 */
  latest(): string | null {
    let latest: string | null = null;
    for (const runId of this.#runs.keys()) latest = runId;
    return latest;
  }

  /** 订阅一个 run。**没有这个 run 时返回 null**（HTTP 层据此回 404）。 */
  subscribe(runId: string, options: SubscribeOptions = {}): Subscription | null {
    const entry = this.#runs.get(runId);
    if (entry === undefined) return null;
    return entry.subscribe(options);
  }

  /** 订阅者用完之后还回来（服务端在 SSE 的 finally 里调）。 */
  release(runId: string, subscriber: Subscription): void {
    this.#runs.get(runId)?.release(subscriber);
  }

  /**
   * 把攒着的文本全部发出去。收尾与测试用（正常情况下 80ms 的定时器会自己触发）。
   * 返回放出去的条数（测试断言用）。
   */
  flush(): number {
    let flushed = 0;
    for (const entry of this.#runs.values()) {
      const before = entry.info().lastEventId;
      entry.flushText();
      if (entry.info().lastEventId > before) flushed += 1;
    }
    return flushed;
  }

  /** 服务器关停：结束所有订阅（不改缓冲，页面还能把已经收到的渲染完）。 */
  close(): void {
    for (const entry of this.#runs.values()) entry.closeAll();
  }

  get runCount(): number {
    return this.#runs.size;
  }

  /**
   * 超出 `maxRuns` 时淘汰最老的已结束 run。**跑的 run 一律不淘汰**（一次 Run 的价值
   * 远大于省下的那几 MB 内存）。两轮：先找没有订阅者的，再退而求其次。
   */
  #evictRuns(): void {
    const max = this.#options.maxRuns ?? 8;
    while (this.#runs.size > max) {
      const victim = this.#pickVictim();
      if (victim === null) {
        this.#log("warn", `内存里有 ${this.#runs.size} 个 run，但都是正在跑的（不淘汰）`);
        return;
      }
      // 淘汰前先把它的订阅者结束：否则那条 SSE 会变成一个永远等不到事件的僵尸连接。
      this.#runs.get(victim)?.closeAll();
      this.#runs.delete(victim);
      this.#log("info", `淘汰最老的已结束 run（内存里最多留 ${max} 个）`, { runId: victim });
    }
  }

  #pickVictim(): string | null {
    let fallback: string | null = null;
    for (const [runId, entry] of this.#runs) {
      if (!entry.ended) continue;
      if (entry.subscriberCount === 0) return runId;
      fallback ??= runId;
    }
    return fallback;
  }
}
