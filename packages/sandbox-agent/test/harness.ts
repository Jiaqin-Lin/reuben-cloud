/**
 * 测试脚手架：临时 workspace 起一个真实的 agent（进程内），加一个够用的 SSE 客户端。
 *
 * 全部用例都用临时目录当 WORKSPACE_ROOT——这是 Phase 1 让 WORKSPACE_ROOT 可配的原因：
 * 裸跑和容器里跑的是同一条路径逻辑，不需要两套。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BASE_PATH, loadConfig, type Config } from "../src/config.ts";
import { createRootResolver } from "../src/paths.ts";
import { ExecutionRegistry } from "../src/exec/registry.ts";
import { createAgentServer } from "../src/server.ts";

export const TEST_TOKEN = "test-token-0123456789";

export const TERMINAL_EVENTS = new Set(["completed", "failed", "timeout", "killed"]);

/**
 * 一个“测试中的 agent”。注意它不是 mock：startTestAgent 真的会
 * 建目录、开端口、跑真进程，只是全部跑在同一个测试进程里，所以能直接拿到 registry 对象。
 */
export interface TestAgent {
  /** 实际生效的配置（options.config 覆盖之后的值）。测试靠它读上限、路径等。 */
  config: Config;
  /** 注册表本体。测试用它直接查状态（并不通过 HTTP 查）。 */
  registry: ExecutionRegistry;
  /** 正在监听的 HTTP server，close() 要关它。 */
  server: Server;
  /** 实际监听的端口（因为传了 port: 0，只能从 server.address() 反查）。 */
  port: number;
  /** 例：http://127.0.0.1:54321。拼 URL 用。 */
  baseUrl: string;
  /** 配置的 workspace 根（可能是符号链接，比如 macOS 的 /var）。 */
  root: string;
  /** realpath 之后的 workspace 根——写路径校验用的就是它。 */
  realRoot: string;
  /**
   * 第二个读根（每个测试 agent 自己一个临时目录，关掉时删）。
   * 存在它是为了让「读多根 / 写单根」能被真测到：它不在 workspace 里面，
   * 所以写进去必须被拒、读出来必须成功。
   */
  extraRoot: string;
  /** 带鉴权头的 fetch。`token: null` = 故意不带 token（测 401 用）。 */
  request(pathname: string, init?: RequestInit & { token?: string | null }): Promise<Response>;
  /** 对 /exec 发一个 JSON POST。不跟随事件流，只拿 202 响应。 */
  exec(body: unknown): Promise<Response>;
  /** 收尾：杀掉在跑的、关 server、删临时目录。测试的 after() 里调。 */
  close(): Promise<void>;
}

/** startTestAgent 的旋钮。两个都是可选的，大多数用例只用 env。 */
export interface TestAgentOptions {
  /** 直接覆盖 Config 里的字段。`Partial<T>` = T 的所有字段都变可选（TS 自带工具类型）。 */
  config?: Partial<Config>;
  /** 追加/覆盖传给 loadConfig 的环境变量（改缓冲容量、chunk 大小等）。 */
  env?: Record<string, string>;
}

/**
 * 起一个测试 agent。做的事和 index.ts 的 main() 几乎一样，区别只有三点：
 *  1. 端口用 0（操作系统随便给一个空闲端口，避免并行跑测试时撞端口）
 *  2. 所有路径都在一个临时目录里（用完即删）
 *  3. 不监听信号、不 process.exit（否则测试进程自己就死了）
 *
 * 注意它直接调 loadConfig(env) 而不是读 process.env：测试行为不随宿主机漂移。
 */
export async function startTestAgent(options: TestAgentOptions = {}): Promise<TestAgent> {
  // mkdtemp 会建一个随机名的空目录。rq-agent- 是前缀，方便出问题时认出来。
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-agent-"));
  // 第二个读根：不在 workspace 里面（不然“写不进去”这件事根本测不出来）。
  const extraRoot = await mkdtemp(path.join(os.tmpdir(), "rc-agent-read-"));
  // 下面这些 env 全是为了这个用例好断言；真正必填的只有 TOKEN。
  const env: NodeJS.ProcessEnv = {
    SANDBOX_AGENT_TOKEN: TEST_TOKEN,
    SANDBOX_AGENT_HOST: "127.0.0.1",
    SANDBOX_AGENT_PORT: "0",
    SANDBOX_WORKSPACE_ROOT: root,
    // 不设它的话缺省会指向真实的 /tmp/reuben-cloud——测试不该碰全局路径。
    SANDBOX_AGENT_READ_ROOTS: `${root},${extraRoot}`,
    SANDBOX_LOG_ROOT: path.join(root, "logs"),
    SANDBOX_AGENT_HOME: path.join(root, "home"),
    // 显式指定，而不是让 agent 继承宿主 env（那是确定性问题的来源）。
    SANDBOX_AGENT_BASE_PATH: process.env.PATH ?? DEFAULT_BASE_PATH,
    ...options.env,
  };

  // `{...loadConfig(env), ...options.config}`：后者里的字段会覆盖前者。
  const config: Config = { ...loadConfig(env), ...options.config };
  await mkdir(config.logRoot, { recursive: true });
  await mkdir(config.home, { recursive: true });

  const roots = await createRootResolver({
    writeRoot: config.workspaceRoot,
    readRoots: config.readRoots,
  });
  const registry = new ExecutionRegistry(config, roots);
  const server = createAgentServer(config, registry, roots);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 包一层 fetch：自动带上鉴权头，并把 /exec 的 body 序列化封装掉。
  // token 的三态：undefined=用默认 TEST_TOKEN；null=不带；字符串=用指定的。
  const request = (pathname: string, init: RequestInit & { token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const token = init.token === undefined ? TEST_TOKEN : init.token;
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${baseUrl}${pathname}`, { ...init, headers });
  };

  return {
    config,
    registry,
    server,
    port,
    baseUrl,
    root,
    realRoot: roots.realRoot,
    extraRoot,
    request,
    // 注意这里不是 server.listen，而是把 JSON 序列化都封好了。
    exec: (body: unknown) =>
      request("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    async close() {
      await registry.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      await rm(extraRoot, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- SSE 客户端

/** SSE 线上解出来的一帧。data 用 any：测试里每个用例自己知道类型。 */
export interface SseEvent {
  /** `id:` 字段；truncated 的 replay_gap 帧故意没有 id，那时为 null。 */
  id: number | null;
  /** `event:` 字段（started / stdout / …）。没写 event: 时 SSE 默认叫 "message"。 */
  event: string;
  /** `data:` 字段 JSON.parse 之后的结果。 */
  data: any;
}

/**
 * 手写的 SSE 客户端。为什么要手写：Node 内置的 fetch 会把整个响应体当成一个流，
 * 而 SSE 的“按 \n\n 分帧”得自己解——这正是生产代码要做的同一件事（CP 側也要手写）。
 *
 * 它把“推”的流变成了“拉”的接口：next() 取下一帧，没收到就等着。
 */
export class SseClient {
  #response: Response;
  /** 用来主动断开连接（close 时调 abort）。 */
  #controller: AbortController;
  /** 已经收到但还没被 next() 取走的帧（拉取快到推送时用）。 */
  #queue: SseEvent[] = [];
  /** 已经调了 next() 但帧还没到的人，来了帧先给他们。 */
  #waiters: Array<{ resolve: (event: SseEvent) => void; reject: (error: unknown) => void }> = [];
  /** 流是不是已经结束了（正常 EOF 或异常）。 */
  #done = false;
  #error: unknown = null;
  /** 是不是我们自己主动关的（区分“预期内的关闭”和“连接断了”）。 */
  #closed = false;

  private constructor(response: Response, controller: AbortController) {
    this.#response = response;
    this.#controller = controller;
    // 启动后台读取循环。没有 await——构造函数不能异步，所以让它自己跑。
    void this.#pump();
  }

  /**
   * 连上 SSE（也可用于重连）。
   *
   * @param lastEventId 带上它就在请求里加 `Last-Event-ID` 头——服务端会从它之后重放。
   */
  static async connect(url: string, token: string, lastEventId?: number): Promise<SseClient> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
    };
    if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);

    const controller = new AbortController();
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok || response.body === null) {
      controller.abort();
      throw new Error(`SSE connect failed: ${response.status}`);
    }
    return new SseClient(response, controller);
  }

  /**
   * 取下一帧。内置 10s 超时——“等一个永远不来的事件”是测试里最常见的挂死方式。
   * 帧已经在队列里就立刻返回；否则挂起自己，等 #pump 推给它。
   */
  async next(timeoutMs = 10_000): Promise<SseEvent> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    if (this.#done) throw this.#error ?? new Error("SSE stream ended before the next event");

    return new Promise<SseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for an SSE event`));
      }, timeoutMs);
      const waiter = {
        resolve: (event: SseEvent) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  /** 主动断开。这之后 #pump 里抛的错就不再当成“意外断线”了。 */
  close(): void {
    this.#closed = true;
    this.#controller.abort();
  }

  /**
   * 后台读取循环：把字节流切成帧。
   * 两个典型的错法，这里都避开了：
   *  - 用裸 String 拼接：跨 chunk 的多字节字符会变成乱码（和 output.ts 同一个坑）
   *  - 假设“一个 chunk = 一帧”：网络重包会把一帧切成两段，所以必须缓存到分隔符出现
   */
  async #pump(): Promise<void> {
    const decoder = new TextDecoder();
    // buffer 里存的永远是“还没有凑出一个完整帧”的最后一段。
    let buffer = "";
    try {
      // `for await ... of` 依次吃每个网络 chunk；`stream: true` 是解码器参数，
      // 意思是“后面还有，先别强行给最后的半个字符下结论”。
      for await (const chunk of this.#response.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = parseFrame(raw);
          if (event !== null) this.#push(event);
          index = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      // 我们自己 abort 的话必然抛 AbortError，那是预期内的，不记成错误。
      if (!this.#closed) this.#error = error;
    } finally {
      // 流结束：所有还在等的人得收到拒绝，否则它们会挂到超时才报错（难查）。
      this.#done = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(new Error("SSE stream ended before the awaited event"));
      }
    }
  }

  /** 一帧到手：有等待者就直给，否则入队。 */
  #push(event: SseEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.resolve(event);
    else this.#queue.push(event);
  }
}

/**
 * 把一帧的文本（不含末尾空行）解成 SseEvent。对应生产端 events.ts 的 encodeFrame()。
 *
 * SSE 的字段格式是 `名字: 值`（冒号后的一个空格会被吃掉）；
 * 以 `:` 开头的是注释行——心跳就是这种，直接忽略。
 */
function parseFrame(raw: string): SseEvent | null {
  let id: number | null = null;
  let event = "message";
  const data: string[] = [];

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // 心跳/注释行
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "id") id = Number.parseInt(value, 10);
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (data.length === 0) return null;
  return { id, event, data: JSON.parse(data.join("\n")) };
}

// ---------------------------------------------------------------- 常用断言辅助

/** runExec 的全部产出，方便用例直接断言。 */
export interface ExecRun {
  executionId: string;
  logPath: string;
  /** 从连上到终态收到的全部事件。 */
  events: SseEvent[];
  /** 最后一个事件（必然是四种终态之一）。 */
  terminal: SseEvent;
  /** 所有 stdout 事件拼起来的文本。 */
  stdout: string;
  /** 所有 stderr 事件拼起来的文本。 */
  stderr: string;
}

/** POST /exec → 接 SSE → 读到终态。SSE 连上之前发出的事件靠重放补齐。 */
export async function runExec(
  agent: TestAgent,
  body: unknown,
  options: { timeoutMs?: number } = {},
): Promise<ExecRun> {
  const response = await agent.exec(body);
  if (response.status !== 202) {
    throw new Error(`expected 202, got ${response.status}: ${await response.text()}`);
  }
  const accepted = (await response.json()) as { execution_id: string; log_path: string };
  const events = await drainExec(agent, accepted.execution_id, options.timeoutMs);
  const terminal = events.at(-1)!;

  return {
    executionId: accepted.execution_id,
    logPath: accepted.log_path,
    events,
    terminal,
    stdout: collect(events, "stdout"),
    stderr: collect(events, "stderr"),
  };
}

/** 连接（或带 Last-Event-ID 重连）并一直读到终态事件。 */
export async function drainExec(
  agent: TestAgent,
  executionId: string,
  timeoutMs = 15_000,
): Promise<SseEvent[]> {
  const client = await SseClient.connect(
    `${agent.baseUrl}/exec/${executionId}/events`,
    TEST_TOKEN,
  );
  return drainUntilTerminal(client, timeoutMs);
}

export async function drainUntilTerminal(client: SseClient, timeoutMs = 15_000): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  try {
    for (;;) {
      const event = await client.next(timeoutMs);
      events.push(event);
      if (TERMINAL_EVENTS.has(event.event)) return events;
    }
  } finally {
    client.close();
  }
}

/** 把某一路（stdout 或 stderr）的 chunk 拼成完整文本。 */
export function collect(events: SseEvent[], stream: "stdout" | "stderr"): string {
  return events
    .filter((event) => event.event === stream)
    .map((event) => event.data.chunk as string)
    .join("");
}

/** 让一个执行进入终态（供用例之间清理用）。 */
export async function killAndWait(agent: TestAgent, executionId: string): Promise<void> {
  await agent.request(`/exec/${executionId}/kill`, { method: "POST" });
  await waitFor(() => agent.registry.get(executionId)?.status !== "running", {
    message: `execution ${executionId} did not reach a terminal state`,
  });
}

/**
 * 轮询等待某个条件成立，或者超时报错。
 * 测试里没有“信号”可用，很多状态是异步变的，所以只能用轮询。
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(options.message ?? `condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 判断一个 pid 还活着吗。用信号 0（不真发信号，只做权限/存在性检查）。
 * EPERM = “进程在，但我没权限发信号”——那也是活着，所以返回 true。
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 给一个 Promise 加超时：到点还没完成就抛。等待“某件事永远不发生”的用例靠它。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms).unref();
    }),
  ]);
}
