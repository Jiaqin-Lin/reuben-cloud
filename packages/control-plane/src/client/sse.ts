/**
 * 手写 SSE 客户端：帧解析 + 断线重连（§Phase 8 §4 的最后一段）。
 *
 * 【为什么不用 `EventSource`】Node 里没有它（只有浏览器/undici 的实验实现），
 * 而且我们需要三件它给不了的事：显式带 `Last-Event-ID`、可控的重连次数、
 * 以及"读到终态事件就主动断掉"。手写一份 80 行，换来的是这三条全在明面上。
 *
 * 【两件事要分清楚】
 *  - **帧解析**（`SseParser`）：纯函数式的一小段状态机，负责跨 chunk 的帧、
 *    心跳注释行、多行 `data:`。它不需要网络，所以能在单元测试里被逐字节喂进去。
 *  - **连接管理**（`readSseStream`）：拿 fetch 的 body，喂给解析器，流断了就带上
 *    `lastEventId` 重连，最多 3 次。
 *
 * 【心跳为什么重要】中间任何一层代理都可能掐掉长时间没数据的连接（§C.2）。
 * 沙箱侧每 15s 发一行 `: ping`，这里必须**当成正常流量**处理：解析器把它吃掉，
 * 读循环不会超时——如果解析器把它当成错误帧，重连风暴就来了。
 *
 * 【重连游标】每次收到带 id 的事件就更新 `lastEventId`，下次重连把它放进
 * `Last-Event-ID` 头。沙箱侧据此先补发缺的事件（§C.2 的"重放"），
 * 于是"CP 断线重连不丢不重"这件事只依赖这一个数字。
 */

/** 一个 SSE 事件。`id` 是字符串（SSE 规范如此），原样回传给 `Last-Event-ID`。 */
export interface SseEvent {
  /** 事件 id；没有 id 字段时是 null（沙箱侧每条事件都带 id）。 */
  id: string | null;
  /** 事件名，默认 `message`。沙箱用 started / stdout / stderr / truncated / 四种终态。 */
  event: string;
  /** data 字段（多行用 `\n` 连接后的字符串）。 */
  data: string;
}

/**
 * 帧解析器。把任意切分的 chunk 喂进来，吐出一批**完整**的事件。
 *
 * 有三处是"看起来能省、其实省了就会错"的：
 *  1. 帧的终止符是**空行**，而空行可能是 `\n\n` / `\r\n\r\n` / `\r\r`，
 *     甚至跨越两个 chunk（`\r\n` 的 `\n` 在下一次 read 里）。
 *  2. 只有注释行（`: ping`）的帧**不是事件**，要返回 null 丢掉。
 *  3. 没有 `data:` 的帧也不派发（SSE 规范）。
 */
export class SseParser {
  #buffer = "";

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const end = findFrameEnd(this.#buffer);
      if (end === null) break;
      const frame = this.#buffer.slice(0, end.index);
      this.#buffer = this.#buffer.slice(end.index + end.length);
      const event = parseFrame(frame);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** 丢掉半个帧（重连时用：新连接不继承上一个连接的残留缓冲）。 */
  reset(): void {
    this.#buffer = "";
  }
}

/**
 * 找第一个空行（帧的终止符），返回它在字符串里的位置与长度。
 * 逐字符扫，所以 `\r\n\r\n` 跨 chunk 时也能正确识别（缓冲区本身是拼接出来的）。
 */
function findFrameEnd(text: string): { index: number; length: number } | null {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\n") {
      if (text[i + 1] === "\n") return { index: i, length: 2 };
      if (text[i + 1] === "\r" && text[i + 2] === "\n") return { index: i, length: 3 };
    } else if (char === "\r") {
      if (text[i + 1] === "\r") return { index: i, length: 2 };
      if (text[i + 1] === "\n") {
        if (text[i + 2] === "\n") return { index: i, length: 3 };
        if (text[i + 2] === "\r" && text[i + 3] === "\n") return { index: i, length: 4 };
      }
    }
  }
  return null;
}

/** 解析一个帧（不含结尾空行）。心跳/无 data 的帧返回 null。 */
function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];

  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line === "" || line.startsWith(":")) continue; // 心跳注释行
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // 规范：冒号后一个空格是可选的
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
    // retry 字段我们不用：重连节奏由 reconnectDelayMs 决定（调用方可配）。
  }

  if (data.length === 0) return null; // 只有注释 / 只有 event 名，不派发
  return { id, event, data: data.join("\n") };
}

// ---------------------------------------------------------------- 连接管理

export type SseErrorReason = "connect_failed" | "bad_status" | "reconnect_exhausted" | "aborted";

/** SSE 客户端的失败。`reason` 让调用方分支，不去匹配错误字符串。 */
export class SseError extends Error {
  readonly reason: SseErrorReason;
  readonly status: number | null;
  /** 到失败为止一共尝试了几次连接（含首次）。 */
  readonly attempts: number;

  constructor(reason: SseErrorReason, message: string, options: { status?: number | null; attempts?: number } = {}) {
    super(message);
    this.name = "SseError";
    this.reason = reason;
    this.status = options.status ?? null;
    this.attempts = options.attempts ?? 1;
  }
}

export interface SseStreamOptions {
  url: string;
  /** 额外请求头（鉴权在这里）。 */
  headers?: Record<string, string>;
  /**
   * 首连就带的游标（真正的"从断点续读"：CP 重启后拿 DB 里的最后 id 重连）。
   * 之后每次重连自动更新成最新收到的事件 id。
   */
  lastEventId?: string | null;
  /** 外部取消信号（看门狗 abort 它）。 */
  signal?: AbortSignal;
  /** 最多重连几次。默认 3（§Phase 8 §4 的原话），之后判 ERROR。 */
  maxReconnects?: number;
  /** 两次重连之间的等待。默认 250ms。 */
  reconnectDelayMs?: number;
  /** "建立连接 + 拿到响应头"的超时。默认 10s；拿到响应头之后就不再计时（事件流是长连接）。 */
  connectTimeoutMs?: number;
  /** 每次重连时回调（记日志用）。 */
  onReconnect?: (info: { attempt: number; lastEventId: string | null; reason: string }) => void;
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
}

/**
 * 连上事件流并按顺序 yield 事件。**流结束（无论原因）都会重连**，直到
 * 重连次数用尽（抛 `reconnect_exhausted`）或消费者主动 break（终态事件到了）。
 *
 * 注意"消费者 break"这条路：生成器的 finally 会 cancel 掉底层的 body，
 * 连接被真正关掉——不会留下一个还在读的 socket。
 */
export async function* readSseStream(options: SseStreamOptions): AsyncGenerator<SseEvent, void, undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxReconnects = options.maxReconnects ?? 3;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;

  let lastEventId = options.lastEventId ?? null;
  let attempt = 0;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let detachAbort: (() => void) | null = null;

  try {
    for (;;) {
      const controller = new AbortController();
      const onOuterAbort = (): void => controller.abort();
      options.signal?.addEventListener("abort", onOuterAbort, { once: true });
      detachAbort = () => options.signal?.removeEventListener("abort", onOuterAbort);

      const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          headers: {
            accept: "text/event-stream",
            "cache-control": "no-cache",
            ...options.headers,
            ...(lastEventId === null ? {} : { "last-event-id": lastEventId }),
          },
          signal: controller.signal,
        });
      } catch (error) {
        detachAbort();
        clearTimeout(connectTimer);
        throw new SseError(
          options.signal?.aborted === true ? "aborted" : "connect_failed",
          `连接 ${options.url} 失败：${error instanceof Error ? error.message : String(error)}`,
          { attempts: attempt + 1 },
        );
      }
      clearTimeout(connectTimer);
      if (!response.ok || response.body === null) {
        detachAbort();
        await response.body?.cancel().catch(() => undefined);
        throw new SseError("bad_status", `${options.url} 返回 ${response.status}`, {
          status: response.status,
          attempts: attempt + 1,
        });
      }

      // ---- 读这一段连接。跨 chunk 的帧、心跳、多行 data 全在解析器里。
      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let closedBy: string;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            closedBy = "stream_closed";
            break;
          }
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.id !== null) lastEventId = event.id;
            yield event;
          }
        }
      } catch (error) {
        closedBy = error instanceof Error ? error.message : String(error);
        // 外部取消不是"流断了"，不要把 abort 变成一次重连。
        if (options.signal?.aborted === true) {
          throw new SseError("aborted", "事件流被调用方取消", { attempts: attempt + 1 });
        }
        throw new SseError("connect_failed", `读取事件流失败：${closedBy}`, { attempts: attempt + 1 });
      } finally {
        activeReader = null;
        await reader.cancel().catch(() => undefined);
        detachAbort();
      }

      // ---- 到这里说明流自己结束了（而不是我们读到了终态主动 break）。
      // 沙箱侧的连接有可能是被代理掐的，也有可能是 agent 重启——两种情况都该重连。
      if (attempt >= maxReconnects) {
        throw new SseError("reconnect_exhausted", `事件流中断且重连 ${attempt} 次后仍然失败`, {
          attempts: attempt + 1,
        });
      }
      attempt += 1;
      options.onReconnect?.({ attempt, lastEventId, reason: closedBy });
      await sleep(reconnectDelayMs, options.signal);
    }
  } finally {
    // 消费者 break / 抛异常时走到这里：把还挂着的连接真正关掉。
    await activeReader?.cancel().catch(() => undefined);
    detachAbort?.();
  }
}

/** 可被取消的等待。取消时直接返回（外层的 for 循环会在下一次判断里抛 aborted）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
