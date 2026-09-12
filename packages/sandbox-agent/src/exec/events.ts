/**
 * 事件总线：单调递增 id + 环形缓冲 + SSE 编码 + 重放。
 *
 * 事件流是**唯一的输出通道**；日志文件只服务于取证和 `GET /files`，不是通信通道。
 *
 * 缓冲容量默认 1000 条 / 1 MiB，先到为准（§C.2）。两个上限都能通过 env 调
 * （`SANDBOX_AGENT_EVENT_BUFFER_MAX_EVENTS` / `_BYTES`）——「重放空洞」这条路径必须能被测到，
 * 而默认容量下制造 1000 条事件要 100 秒起步。
 */

import type { ServerResponse } from "node:http";
import type { ExecEventType, TruncatedEventData } from "../types.ts";

/** 事件总线里的一条事件。id 从 1 开始单调递增，客户端用它做断线重连的游标。 */
export interface AgentEvent {
  /** 单调递增的序号。1 是第一条。重放时靠它判断"这条我收过没有"。 */
  id: number;
  /** 事件名（started / stdout / stderr / truncated / 四种终态）。 */
  type: ExecEventType;
  /** 事件内容。类型是 unknown：总线不关心里面是什么，只负责搬运。 */
  data: unknown;
}

/** 事件总线的三个旋钮。两个上限"先到为准"，超过就淘汰最老的。 */
export interface EventBusOptions {
  /** 环形缓冲最多保留多少条事件（默认 1000）。 */
  maxEvents: number;
  /** 环形缓冲最多占多少字节（默认 1 MiB）。 */
  maxBytes: number;
  /** 心跳间隔：这么久没写过东西就发一行注释帧（默认 15s）。 */
  heartbeatMs: number;
}

/**
 * 一个执行的事件总线。每个执行一个实例，终态之后被 close() 掉，不再复用。
 *
 * 内存里的三份状态：
 *  - #events：环形缓冲，是"重放"的唯一数据源（只在内存，进程重启就没了）
 *  - #seq：已发出的最大 id。缓冲淘汰了它也不回退——否则重连的客户端会重复收到事件
 *  - #subscribers：当前挂在 SSE 上的客户端。可以有多个（旧连接没断干净时）
 */
export class EventBus {
  /** 日志文件路径。重放有空洞时告诉客户端"去这个文件里找"。 */
  readonly logPath: string;

  #options: EventBusOptions;
  /** 环形缓冲本体，按 id 升序。淘汰从头部（最老的）开始。 */
  #events: AgentEvent[] = [];
  /** #events 里所有事件 data 的 JSON 字节数之和，用来判断 maxBytes。 */
  #bytes = 0;
  /** 已发出的最大 id，从 0 开始（第一条事件 id 就是 1）。 */
  #seq = 0;
  #closed = false;
  #subscribers = new Set<Subscriber>();

  constructor(logPath: string, options: EventBusOptions) {
    this.logPath = logPath;
    this.#options = options;
  }

  /** 已发出的最大 id。客户端下次可以带着它重连。 */
  get lastEventId(): number {
    return this.#seq;
  }

  /** 是否已经被 close()。registry.ts 用它避免"往已关的总线里发事件"导致抛异常。 */
  get closed(): boolean {
    return this.#closed;
  }

  /** 当前挂着几个 SSE 消费者（测试用，生产代码不读它）。 */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * 发一条事件。**同步**发出，立刻写给所有订阅者。
   *
   * @param type 事件名
   * @param data 事件内容（会 JSON 序列化）
   * @returns 刚生成的事件（带上了 id）
   * @throws 总线已关闭时抛。调用方应该用 `if (!bus.closed)` 或 publishIfOpen 包一层——
   *         日志的异步错误回调就可能落在终态之后（registry.ts 里那个 publishIfOpen 就是干这个的）。
   */
  publish(type: ExecEventType, data: unknown): AgentEvent {
    if (this.#closed) throw new Error("EventBus is closed");

    // 先入缓冲、再算字节、再淘汰，三步的顺序不能变：
    // 刚发的这条必须能查到，所以淘汰永远在 push 之后。
    const event: AgentEvent = { id: (this.#seq += 1), type, data };
    this.#events.push(event);
    this.#bytes += payloadBytes(data);
    this.#evict();

    // 同一帧文本广播给所有订阅者。这里是同步写 socket，不 await——
    // 一个慢客户端不应该阻塞进程读取子进程输出。
    const frame = encodeFrame(event);
    for (const subscriber of this.#subscribers) subscriber.write(frame);
    return event;
  }

  /**
   * 接入一个订阅者。允许 N 个订阅者各带各的游标——CP 重连时旧连接可能还没断干净，
   * 禁止重连只会让重试逻辑变复杂。
   *
   * 顺序是重点：先挂监听（客户端在重放期间断开不能变成未捕获的 'error'），
   * 再重放、再登记。中间没有 await，所以不会漏也不会重。
   *
   * @param res CP 那条 HTTP 响应对象。这个函数会把它的响应头改成 SSE 并接管它。
   * @param lastEventId 客户端上次收到的最大 id（来自 `Last-Event-ID` 请求头）。
   *                    null = 新连接、从头开始。
   */
  subscribe(res: ServerResponse, lastEventId: number | null): void {
    let subscriber: Subscriber;
    const onClose = (): void => {
      this.#subscribers.delete(subscriber);
    };
    subscriber = new Subscriber(res, this.#options.heartbeatMs, onClose);

    // SSE 的三件套头部。不能改成普通 JSON 响应。
    // X-Accel-Buffering 是给 nginx 看的：它默认会把响应攒起来再发，SSE 就"活"了。
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // 关掉 Nagle。100ms 的合并窗口已经够慢，不要再叠一层缓冲。
    res.socket?.setNoDelay(true);
    // 立刻吐一帧，把响应头冲出去：CP 需要能区分「连上了」和「还没连上」。
    subscriber.write(": connected\n\n");

    // 缓冲里最老那条的 id。缓冲为空时用 #seq + 1 表示"下一条还没发"。
    // 这两个值用来判断客户端要的那一段是不是已经被淘汰了。
    const oldestId = this.#events.length > 0 ? this.#events[0]!.id : this.#seq + 1;
    if (lastEventId !== null && lastEventId < oldestId - 1) {
      // 亏掉的那段只能去日志文件里找。这条事件没有 id：它不是被缓冲的真实事件，
      // 给它编个 id 会污染单调序列。
      const gap: TruncatedEventData = {
        reason: "replay_gap",
        from_id: lastEventId,
        log_path: this.logPath,
      };
      subscriber.write(encodeFrame({ type: "truncated", data: gap }));
    }

    for (const event of this.#events) {
      if (lastEventId !== null && event.id <= lastEventId) continue;
      subscriber.write(encodeFrame(event));
    }

    if (this.#closed) {
      subscriber.end();
      return;
    }

    this.#subscribers.add(subscriber);
  }

  /**
   * 终态事件发完之后调用：收掉所有订阅连接。
   * 幂等；之后再 publish 会抛异常（所以调用方要先查 bus.closed）。
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) subscriber.end();
    this.#subscribers.clear();
  }

  /**
   * 淘汰最老的事件，直到同时满足"条数 ≤ maxEvents"和"字节 ≤ maxBytes"。
   * 条件里的 `length > 1` 是关键：至少留一条，否则刚 publish 的那条可能当场被踢掉。
   */
  #evict(): void {
    while (
      this.#events.length > 1 &&
      (this.#events.length > this.#options.maxEvents || this.#bytes > this.#options.maxBytes)
    ) {
      const evicted = this.#events.shift()!;
      this.#bytes -= payloadBytes(evicted.data);
    }
  }
}

/**
 * 一个 SSE 连接。EventBus 每发一条事件就调它的 write()，
 * 它负责心跳、吞掉"对端已经没了"的写错误、并把自己从总线里注销。
 */
class Subscriber {
  #res: ServerResponse;
  /** 注销回调（EventBus 传进来的），关闭时要把自己从 #subscribers 里删掉。 */
  #onClose: () => void;
  /** 心跳定时器：每 heartbeatMs 醒一次，看要不要发 ping。 */
  #timer: NodeJS.Timeout;
  /** 上次写数据的时间。心跳只在"真的空闲了"才发，不是到点就发。 */
  #lastWriteAt = Date.now();
  #closed = false;

  constructor(res: ServerResponse, heartbeatMs: number, onClose: () => void) {
    this.#res = res;
    this.#onClose = onClose;

    // 心跳：中间任何一层代理都可能掐掉长时间没数据的连接。这是实现必需，不是可选项。
    this.#timer = setInterval(() => {
      if (Date.now() - this.#lastWriteAt >= heartbeatMs) this.write(": ping\n\n");
    }, heartbeatMs);
    this.#timer.unref();

    res.on("close", () => this.#close());
    res.on("error", () => this.#close());
  }

  /** 写一帧（已经编码好的 SSE 文本）。写完不管成功失败都不上抛——这条连接废了不该弄死执行。 */
  write(frame: string): void {
    if (this.#closed) return;
    this.#lastWriteAt = Date.now();
    try {
      this.#res.write(frame);
    } catch {
      this.#close();
    }
  }

  /** 正常收尾：关掉心跳定时器，然后 end 响应。 */
  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    try {
      this.#res.end();
    } catch {
      /* 连接已经没了 */
    }
  }

  /** 异常收尾（对端断开 / 写失败）：只关心跳 + 通知总线注销，不碰 res。 */
  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#onClose();
  }
}

/**
 * 把一条事件编码成 SSE 线上格式。输出的长这样（注意最后必须有个空行，那是帧结束符）：
 *
 *   id: 3<换行>
 *   event: stdout<换行>
 *   data: {"chunk":"hello"}<换行>
 *   <换行>
 *
 * truncated 事件是唯一没有 id 的——理由见 subscribe() 里的注释。
 */
function encodeFrame(event: { id?: number; type: string; data: unknown }): string {
  let frame = "";
  if (event.id !== undefined) frame += `id: ${event.id}\n`;
  frame += `event: ${event.type}\n`;
  // JSON.stringify 不会产生裸换行，所以单行 data: 是安全的。
  frame += `data: ${JSON.stringify(event.data)}\n\n`;
  return frame;
}

/** 一条事件的 data 序列化后有多少字节——环形缓冲的字节上限按这个算。 */
function payloadBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data) ?? "");
}
