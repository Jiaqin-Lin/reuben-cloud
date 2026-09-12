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

export interface TestAgent {
  config: Config;
  registry: ExecutionRegistry;
  server: Server;
  port: number;
  baseUrl: string;
  /** 配置的 workspace 根（可能是符号链接，比如 macOS 的 /var）。 */
  root: string;
  /** realpath 之后的 workspace 根——路径校验用的就是它。 */
  realRoot: string;
  request(pathname: string, init?: RequestInit & { token?: string | null }): Promise<Response>;
  exec(body: unknown): Promise<Response>;
  close(): Promise<void>;
}

export interface TestAgentOptions {
  config?: Partial<Config>;
  env?: Record<string, string>;
}

export async function startTestAgent(options: TestAgentOptions = {}): Promise<TestAgent> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-agent-"));
  const env: NodeJS.ProcessEnv = {
    SANDBOX_AGENT_TOKEN: TEST_TOKEN,
    SANDBOX_AGENT_HOST: "127.0.0.1",
    SANDBOX_AGENT_PORT: "0",
    SANDBOX_WORKSPACE_ROOT: root,
    SANDBOX_LOG_ROOT: path.join(root, "logs"),
    SANDBOX_AGENT_HOME: path.join(root, "home"),
    // 显式指定，而不是让 agent 继承宿主 env（那是确定性问题的来源）。
    SANDBOX_AGENT_BASE_PATH: process.env.PATH ?? DEFAULT_BASE_PATH,
    ...options.env,
  };

  const config: Config = { ...loadConfig(env), ...options.config };
  await mkdir(config.logRoot, { recursive: true });
  await mkdir(config.home, { recursive: true });

  const roots = await createRootResolver(config.workspaceRoot);
  const registry = new ExecutionRegistry(config, roots);
  const server = createAgentServer(config, registry);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

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
    request,
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
    },
  };
}

// ---------------------------------------------------------------- SSE 客户端

export interface SseEvent {
  id: number | null;
  event: string;
  data: any;
}

export class SseClient {
  #response: Response;
  #controller: AbortController;
  #queue: SseEvent[] = [];
  #waiters: Array<{ resolve: (event: SseEvent) => void; reject: (error: unknown) => void }> = [];
  #done = false;
  #error: unknown = null;
  #closed = false;

  private constructor(response: Response, controller: AbortController) {
    this.#response = response;
    this.#controller = controller;
    void this.#pump();
  }

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

  close(): void {
    this.#closed = true;
    this.#controller.abort();
  }

  async #pump(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
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
      if (!this.#closed) this.#error = error;
    } finally {
      this.#done = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(new Error("SSE stream ended before the awaited event"));
      }
    }
  }

  #push(event: SseEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.resolve(event);
    else this.#queue.push(event);
  }
}

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

export interface ExecRun {
  executionId: string;
  logPath: string;
  events: SseEvent[];
  terminal: SseEvent;
  stdout: string;
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

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms).unref();
    }),
  ]);
}
