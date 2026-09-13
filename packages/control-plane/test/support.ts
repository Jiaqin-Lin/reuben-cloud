/**
 * control-plane 测试的公共脚手架。
 *
 * 放在 `test/support.ts`（而不是某个 `.test.ts` 里）是有意的：测试脚本用
 * `test/unit/*.test.ts` / `test/integration/*.test.ts` 这两个显式 glob，
 * 所以这个文件不会被当成测试文件跑——但单测和集成测试都能 import 它。
 * （把 helper 塞进某个测试文件里会让 import 它的另一层把那份用例也跑一遍。）
 *
 * 这里的东西分两类：
 *  - 纯数据工厂（`makeSpec`）—— 不碰任何外部资源
 *  - 集成测试的脚手架（docker CLI、agent HTTP/SSE、镜像解析、清理注册表）—— 需要 Docker
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { Client } from "pg";
import type { Db } from "../src/db/client.ts";
import { ProviderError } from "../src/provider/types.ts";
import type {
  ManagedSandbox,
  SandboxHandle,
  SandboxHealth,
  SandboxInspection,
  SandboxProvider,
  SandboxSpec,
} from "../src/provider/types.ts";

// ---------------------------------------------------------------- 数据工厂

/** 一份合法 spec 的工厂。每个用例只改自己关心的那一个字段。 */
export function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: `reuben-cloud/sandbox-base@sha256:${"a".repeat(64)}`,
    limits: { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 21_600 },
    labels: { sandboxId: "sbx_01HZZZZZZZZZZZZZZZZZZZZZZZ", runId: "run_01HZZZZZZZZZZZZZZZZZZZZZZZ" },
    workspace: { sizeMb: 4096 },
    ...overrides,
  };
}

/** 每个用例一个的 sandboxId：并行跑测试、或者上一次没清干净时都不会互相踩。 */
export function newSandboxId(): string {
  return `sbx_${randomBytes(8).toString("hex")}`;
}

// ---------------------------------------------------------------- 宿主命令

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * 跑一条宿主命令并收集输出。**产品代码不走这里**——集成测试要调 `docker` 做断言
 * （比如 `docker exec <c> stat -c %u /workspace` 查卷属主），那是测试的特权；
 * provider 自己一律走 Docker API（`docker-api.ts`），这条线不能糊。
 */
export function run(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** `docker <args>`。 */
export function docker(args: string[]): Promise<CommandResult> {
  return run(["docker", ...args]);
}

/** `docker <args>`，非 0 退出就抛（命令失败时 stdout 通常没有意义）。 */
export async function dockerOrThrow(args: string[]): Promise<string> {
  const result = await docker(args);
  if (result.code !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(" ")} 失败（exit ${result.code}）：${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Docker daemon 在不在。集成测试用它给出"跳过还是失败"的明确理由。 */
export async function dockerAvailable(): Promise<boolean> {
  const result = await docker(["version", "--format", "{{.Server.Version}}"]);
  return result.code === 0;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询等待条件成立。测试里很多状态是异步变的，只能这么等。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(options.message ?? `条件在 ${timeoutMs}ms 内没有成立`);
    await delay(intervalMs);
  }
}

/** 等一个空闲端口（用完就还）。拿它去测"连不上"这类分支。 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** 拿一份原始 inspect JSON（加固参数断言用）。测试允许直接用 docker CLI 做断言。 */
export async function rawInspect(target: string): Promise<Record<string, any>> {
  const json = await dockerOrThrow(["inspect", target]);
  const parsed = JSON.parse(json) as Array<Record<string, any>>;
  return parsed[0]!;
}

/** 容器在不在（`docker container inspect` 查，含已退出的）。 */
export async function containerExists(nameOrId: string): Promise<boolean> {
  const result = await docker(["container", "inspect", "--format", "{{.Id}}", nameOrId]);
  return result.code === 0;
}

/** 卷在不在。 */
export async function volumeExists(name: string): Promise<boolean> {
  const result = await docker(["volume", "inspect", "--format", "{{.Name}}", name]);
  return result.code === 0;
}

/**
 * 某个 sandboxId 相关的残留。
 * **用标签过滤而不是名字前缀**：名字前缀只能盖住命名规则，标签才是我们自己的契约，
 * 而且它同时能盖住 darwin 上的转发容器。
 */
export async function leftoversOf(sandboxId: string): Promise<{ containers: string[]; volumes: string[] }> {
  const containers = await dockerOrThrow([
    "ps",
    "-a",
    "--filter",
    `label=reuben-cloud.sandboxId=${sandboxId}`,
    "--format",
    "{{.Names}}",
  ]);
  const volumes = await dockerOrThrow([
    "volume",
    "ls",
    "--filter",
    `label=reuben-cloud.sandboxId=${sandboxId}`,
    "--format",
    "{{.Name}}",
  ]);
  return { containers: splitLines(containers), volumes: splitLines(volumes) };
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * 判断一条 docker 错误是不是“它已经不在了”。
 * 大小写与措辞都不固定（CLI 回 "No such volume"，API 回 "get …: no such volume"），
 * 所以只匹配关键词，不匹配整句。
 */
function isMissing(stderr: string, kind: string): boolean {
  return new RegExp(`no such ${kind}`, "i").test(stderr);
}

// ---------------------------------------------------------------- 假 Docker daemon

/** 一个跑在真的 unix socket 上的假 daemon。 */
export interface FakeDaemon {
  socketPath: string;
  /** 收到的请求（method + 带 query 的完整路径），按顺序记下来。 */
  requests: string[];
  close: () => Promise<void>;
}

/**
 * 起一个假 daemon。
 *
 * 放这里（而不是某个 `.test.ts` 里）是**必须**的：`node --test` 吃到某个测试文件时，
 * 从它 import 进来的 `test()` 调用会一起注册到同一个进程里——把 helper 放进测试文件，
 * 第二个 import 它的文件就会把那整份用例再跑一遍（文件头已经为 `makeSpec` 记过这条）。
 *
 * 做法的要点与理由见 `docker-api.test.ts` 的文件头：真的 HTTP 字节流比 mock `http.request`
 * 诚实得多；socket 路径用 `/tmp/rc-docker-XXXX` 而不是 `os.tmpdir()`（macOS 的
 * `/var/folders/...` 会碰到 unix socket 的 ~104 字节路径上限）。
 */
export async function startFakeDaemon(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<FakeDaemon> {
  const dir = await mkdtemp("/tmp/rc-docker-");
  const socketPath = path.join(dir, "docker.sock");
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- 镜像

/** 集成测试默认用的本地镜像 tag（`npm run build:image` 或 `npm run check:image` 建出来的）。 */
export const DEFAULT_IMAGE_TAG = process.env.SANDBOX_IMAGE ?? "reuben-cloud/sandbox-base:dev";

/** egress-proxy 的本地镜像 tag（`npm run build:proxy-image` 建出来的）。 */
export const DEFAULT_PROXY_IMAGE_TAG = process.env.EGRESS_PROXY_IMAGE ?? "reuben-cloud/egress-proxy:dev";

/**
 * 把本地镜像解析成 **digest 引用**（`repo@sha256:…`）。
 *
 * 为什么必须带 digest：`SandboxSpec.image` 只接受 digest（§C.1），而"本地构建的镜像"
 * 恰好没有 registry 里的 tag 可查。Docker 的经典存储与 containerd 存储都把本地镜像的
 * digest 放在 `RepoDigests` / `Id` 里（实验证明两者在这个环境下一致：
 * containerd 存储的 `.Id` 就是 manifest digest），provider 的 `#ensureImage` 又是
 * "本地命中就不拉"，所以本地开发不需要任何 registry。
 *
 * 返回的两种形态都被 `validateSpec()` 接受（`repo@sha256:…` 与裸 `sha256:…`）：
 * 经典存储（overlay2 / graphdriver）下本地构建的镜像没有 RepoDigests，只能退回 `.Id`。
 * 这不是妥协——两者都是不可变的内容寻址，tag 才是那个不该被接受的东西（见 Phase 7 备注 19）。
 *
 * @param hint 镜像不存在时告诉使用者该跑哪条命令。两个镜像的构建命令不同，所以让它可选。
 * @throws 镜像不存在时抛出，并告诉使用者先跑构建命令——比让 create 报"拉镜像失败"清楚得多。
 */
export async function resolveImageRef(tag: string = DEFAULT_IMAGE_TAG, hint = "npm run build:image"): Promise<string> {
  const result = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}} {{json .RepoDigests}}",
    tag,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `本地没有镜像 ${tag}。先跑 \`${hint}\`（或用 SANDBOX_IMAGE / EGRESS_PROXY_IMAGE 指定别的镜像）。\n${result.stderr.trim()}`,
    );
  }
  const [id, repoDigestsJson] = result.stdout.trim().split(" ");
  const repoDigests = JSON.parse(repoDigestsJson ?? "[]") as string[];
  // RepoDigests 里已经有完整的 `repo@sha256:…` 时优先用它（它和 tag 同名，最不容易搞混）。
  const preferred = repoDigests.find((item) => item.startsWith(`${tag.split(":")[0]}@`)) ?? repoDigests[0];
  if (preferred !== undefined) return preferred;
  // 没有 RepoDigests（本地构建且从没 push 过）：用 Id。Id 已经是 `sha256:…` 形式，
  // 只要不给它加 name 前缀，Docker 按 digest 就能解析到本地镜像。
  if (id !== undefined && /^sha256:[0-9a-f]{64}$/.test(id)) return id;
  throw new Error(`无法从 ${tag} 解析出 digest 引用：${result.stdout.trim()}`);
}

// ---------------------------------------------------------------- agent HTTP / SSE

export interface AgentEvent {
  event: string;
  data: Record<string, unknown>;
  /** 收到这一帧的本地时刻（用例判断"输出是在进程结束前到达的"时要用）。 */
  at: number;
}

export interface ExecOutcome {
  events: AgentEvent[];
  terminal: AgentEvent;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** 终态事件集合。四选一，互斥（§C.2）。 */
export const TERMINAL_EVENTS = new Set(["completed", "failed", "timeout", "killed"]);

/**
 * 对沙箱里的 agent 跑一条命令：POST /exec → 连 SSE → 读到终态。
 *
 * 这里**故意**不用 sandbox-agent 测试里的 `SseClient`：CP 对沙箱的消费方式就是
 * "自己解析 SSE"（Phase 8 要自己写一份 `client/sse.ts`），测试里要是复用了沙箱侧的
 * 客户端，就等于两边的解析器永远一起对、永远一起错。
 */
export async function agentExec(
  baseUrl: string,
  token: string,
  cmd: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> } = {},
): Promise<ExecOutcome> {
  const accepted = await fetch(`${baseUrl}/exec`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      cmd,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    }),
  });
  if (accepted.status !== 202) {
    throw new Error(`POST /exec 得到 ${accepted.status}：${await accepted.text()}`);
  }
  const { execution_id: executionId } = (await accepted.json()) as { execution_id: string };

  // SSE 读取的预算要比命令自己的预算宽一点：命令跑到时限被杀之后，终态事件与剩余输出
  // 还要有机会被读出来。固定 60s 会让"长命令"用例在最后一条事件上被本地超时误伤。
  const readTimeoutMs = Math.max(60_000, (options.timeoutMs ?? 30_000) + 15_000);
  const events = await readEvents(`${baseUrl}/exec/${executionId}/events`, token, { timeoutMs: readTimeoutMs });
  const terminal = events.at(-1)!;
  const collect = (stream: "stdout" | "stderr"): string =>
    events
      .filter((event) => event.event === stream)
      .map((event) => String(event.data.chunk))
      .join("");

  return {
    events,
    terminal,
    exitCode: (terminal.data.exit_code as number | null) ?? null,
    signal: (terminal.data.signal as string | null) ?? null,
    stdout: collect("stdout"),
    stderr: collect("stderr"),
  };
}

/** 连上 SSE 并读到终态事件。返回全部事件（含终态）。 */
export async function readEvents(
  url: string,
  token: string,
  options: { lastEventId?: string; timeoutMs?: number } = {},
): Promise<AgentEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  const events: AgentEvent[] = [];
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        ...(options.lastEventId === undefined ? {} : { "last-event-id": options.lastEventId }),
      },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`SSE 连接失败：${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 帧之间用空行分隔；一帧里可能有 id / event / data 多行。
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const parsed = parseFrame(frame);
        if (parsed !== null) {
          events.push(parsed);
          if (TERMINAL_EVENTS.has(parsed.event)) {
            await reader.cancel();
            return events;
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

/** 解析一个 SSE 帧。注释行（心跳 `: ping`）返回 null。 */
function parseFrame(frame: string): AgentEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // 心跳
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  return { event, data: JSON.parse(raw) as Record<string, unknown>, at: Date.now() };
}

/** 读一次 agent `/health`（不走 provider，直接打 HTTP，用于与 provider 的结果对照）。 */
export async function agentHealth(
  baseUrl: string,
  token: string,
): Promise<{ status: string; version: string; activeExecution: string | null }> {
  const response = await fetch(`${baseUrl}/health`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GET /health 得到 ${response.status}`);
  return (await response.json()) as { status: string; version: string; activeExecution: string | null };
}

// ---------------------------------------------------------------- 清理

/**
 * 测试资源的清理登记表。**每个集成用例都要把创建出来的东西登记进来**，
 * 这样即使断言失败（异常打断流程）也能在 after() 里收干净——不然一次失败的运行
 * 会留下一堆容器和卷，下一次运行时它们就变成了"对账要处理的孤儿"，
 * 让后续排查多一层噪音。
 */
export class CleanupRegistry {
  readonly #containers = new Set<string>();
  readonly #volumes = new Set<string>();
  readonly #images = new Set<string>();

  container(nameOrId: string): void {
    this.#containers.add(nameOrId);
  }

  volume(name: string): void {
    this.#volumes.add(name);
  }

  image(ref: string): void {
    this.#images.add(ref);
  }

  /** 清掉登记过的一切。**逐条吞异常**：清理失败不该掩盖真正的失败原因。 */
  async sweep(): Promise<string[]> {
    const failed: string[] = [];
    for (const container of this.#containers) {
      const result = await docker(["rm", "-f", container]);
      if (result.code !== 0 && !isMissing(result.stderr, "container")) {
        failed.push(`container ${container}: ${result.stderr.trim()}`);
      }
    }
    this.#containers.clear();
    for (const volume of this.#volumes) {
      const result = await docker(["volume", "rm", volume]);
      if (result.code !== 0 && !isMissing(result.stderr, "volume")) {
        failed.push(`volume ${volume}: ${result.stderr.trim()}`);
      }
    }
    this.#volumes.clear();
    for (const image of this.#images) {
      const result = await docker(["image", "rm", "-f", image]);
      if (result.code !== 0 && !isMissing(result.stderr, "image")) {
        failed.push(`image ${image}: ${result.stderr.trim()}`);
      }
    }
    this.#images.clear();
    return failed;
  }
}

// ---------------------------------------------------------------- Phase 8：一次性 Postgres

/**
 * 一个一次性 Postgres 容器（spec §0.5：不引 testcontainers）。
 *
 * 端口用 `-p 127.0.0.1::5432` 让 Docker 分配随机宿主端口，而不是钉死 55432：
 * `node --test` 默认**并行跑文件**，两个集成测试文件各起一个 Postgres 时，
 * 固定端口就是必然的碰撞。名字里带 pid + 随机段，上一次跑崩了留下的容器也不会挡路。
 */
export interface TestPostgres {
  containerName: string;
  /** 连接串。测试用它建 `Db`，也用它在 after() 里清数据。 */
  url: string;
  /** `docker rm -f`（一次性容器的数据不保留）。 */
  stop(): Promise<void>;
}

export async function startPostgres(options: { image?: string; timeoutMs?: number } = {}): Promise<TestPostgres> {
  const containerName = `rc-test-db-${process.pid}-${randomBytes(3).toString("hex")}`;
  const image = options.image ?? "postgres:16-alpine";
  const password = "reuben_cloud_test";
  await dockerOrThrow([
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=reuben_cloud",
    "-p",
    "127.0.0.1::5432",
    image,
  ]);
  const portOutput = await dockerOrThrow(["port", containerName, "5432"]);
  // 输出形如 `127.0.0.1:32768`（可能有多行，取第一行）。
  const port = Number(portOutput.trim().split("\n")[0]!.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) {
    await docker(["rm", "-f", containerName]);
    throw new Error(`拿不到 ${containerName} 的宿主端口：${JSON.stringify(portOutput)}`);
  }
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/reuben_cloud`;
  try {
    await waitForPostgres(url, options.timeoutMs ?? 60_000);
  } catch (error) {
    await docker(["rm", "-f", containerName]);
    throw error;
  }
  return {
    containerName,
    url,
    stop: async () => {
      await docker(["rm", "-f", containerName]);
    },
  };
}

/** 等 Postgres 真的能执行查询。只等端口通是不够的——初始化那几秒里连接会被拒。 */
async function waitForPostgres(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  for (;;) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
      if (Date.now() >= deadline) {
        throw new Error(`等 Postgres 就绪超时（${timeoutMs}ms）：${lastError}`);
      }
      await delay(500);
    }
  }
}

/** 清掉测试造出来的沙箱行（executions 有外键，先删子表）。**只删指定的 id**。 */
export async function deleteSandboxRows(db: Db, sandboxIds: readonly string[]): Promise<void> {
  if (sandboxIds.length === 0) return;
  await db.query("DELETE FROM executions WHERE sandbox_id = ANY ($1::text[])", [sandboxIds]);
  await db.query("DELETE FROM sandbox_state_transitions WHERE sandbox_id = ANY ($1::text[])", [sandboxIds]);
  await db.query("DELETE FROM sandboxes WHERE id = ANY ($1::text[])", [sandboxIds]);
}

// ---------------------------------------------------------------- Phase 8：假 agent

export interface FakeAgentRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
  /** SSE 连接上带的 `Last-Event-ID` 头（只有 events 请求有）。 */
  lastEventId: string | null;
}

/** 假 agent 的全部开关：路由行为（hooks）外加几个整体开关。 */
export interface FakeAgentOptions extends FakeAgentHooks {
  /**
   * 写完 frames 之后立刻 `res.end()`（默认 false = 挂着不结束）。
   * 用来造"事件流被掐断"：SSE 客户端会带 `Last-Event-ID` 重连，重连用尽后 manager 判
   * `stream_failed`——那是 §B 风险表里"最难查的一类"，值得有一条用例守着。
   */
  closeAfterFrames?: boolean;
}

export interface FakeAgentHooks {
  /** 覆盖 POST /exec 的响应。默认 202 + 自增 id。 */
  onExec?: (body: Record<string, unknown>) => { status?: number; body?: Record<string, unknown> } | void;
  /** GET /exec/{id}/events 要写出去的 SSE 帧（原始文本，含行尾）。默认空 = 永不给终态。 */
  onEvents?: (executionId: string) => string[];
  /** 覆盖 POST /exec/{id}/kill 的响应。默认 200 + `{status:"killing"}`。 */
  onKill?: (executionId: string) => { status?: number; body?: Record<string, unknown> } | void;
}

/**
 * 一个真的 HTTP 假 agent。**不是 mock 函数**：它监听一个真端口、走真的字节流，
 * 因为"看门狗到点会调 /kill"这件事只有通过一次真的 HTTP 请求才算验证过。
 *
 * 默认行为刻意是"最坏的那种"：事件流永远不给终态事件——那正是看门狗存在的理由。
 * 需要别的行为时用 hooks 覆盖。
 */
export class FakeSandboxAgent {
  readonly requests: FakeAgentRequest[] = [];
  /** 收到过几次 `POST /exec/{id}/kill`（按顺序记 id）。 */
  readonly killCalls: string[] = [];
  /** 每次 SSE 连接：executionId + 请求头里的 Last-Event-ID。 */
  readonly eventConnections: Array<{ executionId: string; lastEventId: string | null }> = [];
  status = "ready";
  version = "0.0.1-fake";
  activeExecution: string | null = null;

  /** POST /exec 发出去的 execution id（按顺序）。测试要断言它们时读这里。 */
  readonly executions: string[] = [];

  /** 见 `FakeAgentOptions.closeAfterFrames`。 */
  readonly closeAfterFrames: boolean;

  readonly #hooks: FakeAgentHooks;
  /**
   * execution id 的前缀带随机段：每个假 agent 实例的 id 空间是独立的。
   * 不这么做的话两个用例都会产出 `exe_fake_1`，而 `executions` 的主键是 execution id——
   * 第二条记录会去 UPDATE 第一条（`ON CONFLICT (id) DO UPDATE` 是给崩溃恢复用的），
   * 于是"这个沙箱有几条执行记录"这种断言会莫名其妙地失败。
   */
  readonly #idPrefix = `exe_fake_${randomBytes(3).toString("hex")}`;
  #server: http.Server | null = null;
  #port = 0;
  #seq = 0;

  constructor(options: FakeAgentOptions = {}) {
    const { closeAfterFrames = false, ...hooks } = options;
    this.closeAfterFrames = closeAfterFrames;
    this.#hooks = hooks;
  }

  get url(): string {
    if (this.#server === null) throw new Error("FakeSandboxAgent 还没 start()");
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.#handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.#port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    // 事件流是长连接：不主动断掉的话 close() 会一直等它们。
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req);
    this.requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
      body,
      lastEventId: (req.headers["last-event-id"] as string | undefined) ?? null,
    });

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: this.status, version: this.version, activeExecution: this.activeExecution });
      return;
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      const parsed = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
      const executionId = `${this.#idPrefix}_${++this.#seq}`;
      this.executions.push(executionId);
      const override = this.#hooks.onExec?.(parsed) ?? {};
      const payload = override.body ?? { execution_id: executionId, log_path: `/tmp/reuben-cloud/exec/${executionId}.log` };
      if (override.body?.execution_id === undefined) this.activeExecution = executionId;
      sendJson(res, override.status ?? 202, payload);
      return;
    }

    const execRoute = /^\/exec\/([^/]+)\/(events|kill)$/.exec(url.pathname);
    if (execRoute !== null) {
      const executionId = execRoute[1]!;
      if (execRoute[2] === "events" && req.method === "GET") {
        this.eventConnections.push({
          executionId,
          lastEventId: (req.headers["last-event-id"] as string | undefined) ?? null,
        });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const frame of this.#hooks.onEvents?.(executionId) ?? []) res.write(frame);
        // **默认不结束响应**：没有终态事件时连接就该一直挂着，直到调用方 abort。
        if (this.closeAfterFrames) res.end();
        return;
      }
      if (execRoute[2] === "kill" && req.method === "POST") {
        this.killCalls.push(executionId);
        const override = this.#hooks.onKill?.(executionId) ?? {};
        sendJson(res, override.status ?? 200, override.body ?? { execution_id: executionId, status: "killing" });
        return;
      }
    }

    sendJson(res, 404, { error: "not_found", message: `fake agent 没有这条路由：${req.method} ${url.pathname}` });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// ---------------------------------------------------------------- Phase 8：假 provider

/**
 * 只实现"对账看得见的那部分"的 provider：`inspect` / `listManaged` / `destroy`。
 * `create` 故意不实现——对账永远不该建容器，真需要 create 的用例走 LocalDockerProvider。
 *
 * 有了它，对账的四条规则可以在**只有 Postgres** 的情况下被逐条测到（毫秒级），
 * 而真容器那条路留给 `manager.integration.test.ts` 里的"容器丢失"用例。
 */
export class FakeProvider implements SandboxProvider {
  readonly kind = "fake";
  /** sandboxId → inspect 结果（不登记 = 容器不在）。 */
  readonly inspections = new Map<string, SandboxInspection>();
  /** listManaged() 的返回。 */
  managed: ManagedSandbox[] = [];
  /** destroy 被调用的 sandboxId（按顺序）。 */
  readonly destroyed: string[] = [];
  /** destroy 抛这个（测"删不掉"的路径）。 */
  destroyError: Error | null = null;

  create(): Promise<SandboxHandle> {
    throw new Error("FakeProvider 不实现 create：对账不该建容器");
  }

  async destroy(sandboxId: string): Promise<void> {
    this.destroyed.push(sandboxId);
    if (this.destroyError !== null) throw this.destroyError;
    this.inspections.delete(sandboxId);
    // 容器真被删掉之后就不该再出现在 listManaged() 里——否则第二次对账会把同一个孤儿
    // 再删一遍，而"对账幂等"这条断言就永远测不出真东西了。
    this.managed = this.managed.filter((item) => item.sandboxId !== sandboxId);
  }

  async health(sandboxId: string): Promise<SandboxHealth> {
    const inspection = this.inspections.get(sandboxId);
    if (inspection === undefined) throw new ProviderError("not_found", `沙箱 ${sandboxId} 不存在`);
    return {
      sandboxId,
      status: inspection.agentStatus,
      version: inspection.version,
      activeExecution: inspection.activeExecution,
      endpoint: inspection.endpoint,
    };
  }

  async listManaged(): Promise<ManagedSandbox[]> {
    return this.managed;
  }

  async inspect(sandboxId: string): Promise<SandboxInspection | null> {
    return this.inspections.get(sandboxId) ?? null;
  }
}

/** 造一份 `SandboxInspection`（默认是"一切正常的 running 沙箱"）。 */
export function fakeInspection(sandboxId: string, overrides: Partial<SandboxInspection> = {}): SandboxInspection {
  return {
    sandboxId,
    providerRef: `ref_${sandboxId}`,
    containerName: `reuben-cloud-sbx-${sandboxId}`,
    running: true,
    state: "running",
    endpoint: "http://127.0.0.1:1",
    agentStatus: "ready",
    activeExecution: null,
    version: "0.0.1-fake",
    ...overrides,
  };
}

/** 造一份 `ManagedSandbox`（默认是沙箱本体）。 */
export function fakeManaged(sandboxId: string | null, overrides: Partial<ManagedSandbox> = {}): ManagedSandbox {
  return {
    sandboxId,
    providerRef: `ref_${sandboxId ?? "proxy"}`,
    containerName: sandboxId === null ? "reuben-cloud-proxy" : `reuben-cloud-sbx-${sandboxId}`,
    runId: null,
    taskId: null,
    role: "sandbox",
    state: "running",
    running: true,
    ...overrides,
  };
}
