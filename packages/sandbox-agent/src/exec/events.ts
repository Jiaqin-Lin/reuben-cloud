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

export interface AgentEvent {
  id: number;
  type: ExecEventType;
  data: unknown;
}

export interface EventBusOptions {
  maxEvents: number;
  maxBytes: number;
  heartbeatMs: number;
}

export class EventBus {
  readonly logPath: string;

  #options: EventBusOptions;
  #events: AgentEvent[] = [];
  #bytes = 0;
  #seq = 0;
  #closed = false;
  #subscribers = new Set<Subscriber>();

  constructor(logPath: string, options: EventBusOptions) {
    this.logPath = logPath;
    this.#options = options;
  }

  get lastEventId(): number {
    return this.#seq;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  publish(type: ExecEventType, data: unknown): AgentEvent {
    if (this.#closed) throw new Error("EventBus is closed");

    const event: AgentEvent = { id: (this.#seq += 1), type, data };
    this.#events.push(event);
    this.#bytes += payloadBytes(data);
    this.#evict();

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
   */
  subscribe(res: ServerResponse, lastEventId: number | null): void {
    let subscriber: Subscriber;
    const onClose = (): void => {
      this.#subscribers.delete(subscriber);
    };
    subscriber = new Subscriber(res, this.#options.heartbeatMs, onClose);

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

  /** 终态事件发完之后调用：收掉所有订阅连接。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) subscriber.end();
    this.#subscribers.clear();
  }

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

class Subscriber {
  #res: ServerResponse;
  #onClose: () => void;
  #timer: NodeJS.Timeout;
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

  write(frame: string): void {
    if (this.#closed) return;
    this.#lastWriteAt = Date.now();
    try {
      this.#res.write(frame);
    } catch {
      this.#close();
    }
  }

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

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#onClose();
  }
}

function encodeFrame(event: { id?: number; type: string; data: unknown }): string {
  let frame = "";
  if (event.id !== undefined) frame += `id: ${event.id}\n`;
  frame += `event: ${event.type}\n`;
  // JSON.stringify 不会产生裸换行，所以单行 data: 是安全的。
  frame += `data: ${JSON.stringify(event.data)}\n\n`;
  return frame;
}

function payloadBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data) ?? "");
}
