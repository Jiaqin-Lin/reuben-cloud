/**
 * `event-stream.ts` —— 一个 60 行的异步事件流（设计文档 §B.5 的载体）。
 *
 * 【它解决什么】模型响应是**流式**的：文字一段一段来、工具调用参数一片一片来。
 * 消费方有两种读法，而且经常同时存在：
 *  ① `for await (const event of stream)` —— 边到边处理（前端打字机、测试断言顺序）；
 *  ② `await stream.result()` —— 只要终态（循环要的是定稿的那条消息）。
 * 一个队列 + 一个 waiting 队列就能同时满足两者，不需要引入任何依赖
 * （pi 的 `packages/ai/src/utils/event-stream.ts` 是同一个东西；我们没有 pi-ai
 * 那层 provider 框架，所以这个类自己写，语义对齐）。
 *
 * 【两条容易写错的地方，都在这里定死】
 *  ① **完成事件也要交给消费方**。`push()` 先把事件投递/入队，再判完成——否则
 *     `for await` 会看不到最后那条 `done`，前端永远停在"正在输入"。
 *  ② **`end()` 要把所有等待者放掉**。`end()` 之后新来的 `push()` 一律丢弃：
 *     一个已经定稿的流不该再变。
 */

import type { AssistantMessage, AssistantStreamEvent } from "./types.ts";

/**
 * 先进先出的队列。两个数组交替倒腾是为了 `dequeue()` 是 O(1)：
 * 只用一个 `shift()` 的数组，每次出队都是 O(n)。
 */
class FifoQueue<T> {
  #incoming: T[] = [];
  #outgoing: T[] = [];

  get length(): number {
    return this.#incoming.length + this.#outgoing.length;
  }

  enqueue(value: T): void {
    this.#incoming.push(value);
  }

  dequeue(): T | undefined {
    if (this.#outgoing.length === 0) {
      while (this.#incoming.length > 0) {
        this.#outgoing.push(this.#incoming.pop()!);
      }
    }
    return this.#outgoing.pop();
  }
}

/**
 * 泛型事件流。
 *
 * @typeParam T 事件类型。
 * @typeParam R 终态类型（`result()` 的返回值，默认与事件同型）。
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  #queue = new FifoQueue<T>();
  #waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
  #done = false;
  readonly #finalResult: Promise<R>;
  #resolveFinalResult!: (result: R) => void;
  readonly #isComplete: (event: T) => boolean;
  readonly #extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.#isComplete = isComplete;
    this.#extractResult = extractResult;
    this.#finalResult = new Promise<R>((resolve) => {
      this.#resolveFinalResult = resolve;
    });
  }

  /** 已经结束（收到完成事件或调用过 `end()`）。 */
  get done(): boolean {
    return this.#done;
  }

  /** 推一条事件。完成事件本身也会被消费方看到（见文件头）。 */
  push(event: T): void {
    if (this.#done) return;
    if (this.#isComplete(event)) {
      this.#done = true;
      this.#resolveFinalResult(this.#extractResult(event));
    }
    const waiter = this.#waiting.dequeue();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else this.#queue.enqueue(event);
  }

  /** 结束流。给了 `result` 就以它为准（`push` 完成事件时已经定过终态）。 */
  end(result?: R): void {
    this.#done = true;
    if (result !== undefined) this.#resolveFinalResult(result);
    while (this.#waiting.length > 0) {
      this.#waiting.dequeue()!({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#queue.length > 0) {
        yield this.#queue.dequeue()!;
      } else if (this.#done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.#waiting.enqueue(resolve));
        if (result.done === true) return;
        yield result.value;
      }
    }
  }

  /** 终态。**可以多次 await**（同一个 Promise）。 */
  result(): Promise<R> {
    return this.#finalResult;
  }
}

/**
 * 模型响应的流：事件是 `AssistantStreamEvent`，终态是定稿的 `AssistantMessage`。
 * 与 pi 的 `AssistantMessageEventStream` 同形——`model/client.ts` 的每个分支都返回它。
 */
export class AssistantMessageEventStream extends EventStream<AssistantStreamEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      // 终态挂在完成事件上（pi 的做法）：`result()` 不需要等 `end()`，
      // 消费方只要 `for await` 读到 done/error，就已经拿到同一条消息。
      (event) => {
        switch (event.type) {
          case "done":
            return event.message;
          case "error":
            return event.error;
          default:
            throw new Error(`AssistantMessageEventStream: ${event.type} 不是完成事件`);
        }
      },
    );
  }
}

/** 工厂函数（与 pi 同名，调用点不用 new）。 */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
