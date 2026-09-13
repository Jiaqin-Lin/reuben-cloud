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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import type { Db } from "../src/db/client.ts";
import { ProviderError } from "../src/provider/types.ts";
import type { RepoRef } from "../src/repo/types.ts";
import { RepoError } from "../src/repo/types.ts";
import type {
  CreatePullRequestInput,
  PullRequestApi,
  PullRequestRecord,
  UpdatePullRequestInput,
} from "../src/repo/pr.ts";
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
 * 跑一条宿主命令并拿到**原始字节**（Node 的 stdout/stderr 管道本来就是 Buffer）。
 *
 * 【为什么不重用 `run()`】它把 stdout 解成 utf8 字符串——对 tar.gz 这种二进制流
 * 是把内容弄坏（每个非 UTF-8 字节变成一个 U+FFFD）。归档类的断言（sha256、解包、
 * 条目清单）必须看到原字节，所以脚手架里得有这么一份。
 */
export function runBinary(
  argv: string[],
  options: { cwd?: string; stdin?: Buffer; env?: NodeJS.ProcessEnv } = {},
): Promise<BinaryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
    // stdin 一律接上再关：git 不读它，tar -tzf / tar -xzf 读它。
    child.stdin.end(options.stdin);
  });
}

export interface BinaryResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * 把一份 tar.gz 解到一个**调用方指定的空目录**里，返回解出来的条目名。
 * `--no-same-owner` 与不加 `-P` 是 spec 的要求（归档里可能有指向 workspace 外的符号链接，
 * 解包时不能让它们变成绝对路径 / 改挂在别人身上）。
 */
export async function tarExtract(gzipped: Buffer, intoDir: string): Promise<string[]> {
  const result = await runBinary(["tar", "--no-same-owner", "-xzf", "-", "-C", intoDir], { stdin: gzipped });
  if (result.code !== 0) throw new Error(`tar -xzf 失败（归档不是合法的 tar.gz？）：${result.stderr.trim()}`);
  const listed = await runBinary(["tar", "-tzf", "-"], { stdin: gzipped });
  if (listed.code !== 0) throw new Error(`tar -tzf 失败：${listed.stderr.trim()}`);
  return listed.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** 把宿主上的一个目录打包成 tar.gz（`./...` 作为顶层）。归档样本与 fixture 都用它。 */
export async function makeTarGz(sourceDir: string): Promise<Buffer> {
  const result = await runBinary(["tar", "-czf", "-", "-C", sourceDir, "."], {
    // macOS 的 bsdtar 会把扩展属性写成 `._*` AppleDouble 条目（Phase 7 踩过的坑）。
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.code !== 0) throw new Error(`tar 打包失败：${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * 假 agent 默认的归档响应体。**不是真正的 tar.gz**：它只保证"有字节流下来"，
 * 需要验证归档内容的用例自己传 `onArchive().stream`（用 `makeTarGz()` 现造一份）。
 */
const DEFAULT_ARCHIVE_BODY = Buffer.from("fake-archive");

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

/**
 * 本地镜像的解析搬到了产品代码：`src/provider/image-ref.ts`。
 *
 * 【为什么是 re-export 而不是删掉】调用方（集成测试、`scripts/agent-run.ts`、`packages/e2e`）
 * 全都按 `test/support.ts` 的路径 import；P7 需要同一份实现出现在生产路径上（Run 侧回退要用
 * Layer 1 的 digest），所以实现搬走、名字留在这里，调用方一行不动。
 */
export { resolveImageRef } from "../src/provider/image-ref.ts";
export { DEFAULT_IMAGE_TAG, DEFAULT_PROXY_IMAGE_TAG } from "../src/provider/image-ref.ts";

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
  /**
   * GET /diff（Phase 10 的归档要用）。不给就给一份"没有改动"的合法响应。
   * 返回的体里 `base` / `patch_bytes` 是客户端强校验的字段，覆盖时别忘了。
   */
  onDiff?: (query: URLSearchParams) => { status?: number; body?: Record<string, unknown> } | void;
  /**
   * GET /archive。`dryRun=1` 时用 `dryRun` 那两个字段；否则用 `stream` 作响应体。
   * [关键] 真归档不预先给 content-length（沙箱那边就是这么流出来的），
   * 所以这里用 `writeHead` + `pipe`，让客户端走真正的流式读。
   */
  onArchive?: (query: URLSearchParams) => {
    status?: number;
    dryRun?: { size_bytes: number; file_count: number };
    stream?: Readable | Buffer | string;
  } | void;
  /** GET /files?raw=1&path=…（Phase 10 转存执行日志要用）。不给 body = 404。 */
  onReadFile?: (path: string) => { status?: number; body?: Buffer | string } | void;
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

    if (req.method === "GET" && url.pathname === "/diff") {
      const override = this.#hooks.onDiff?.(url.searchParams) ?? {};
      // 缺省是一份"工作区没有任何改动"的合法响应：客户端会校验 base / patch_bytes。
      sendJson(
        res,
        override.status ?? 200,
        override.body ?? {
          base: "0".repeat(40),
          head: "0".repeat(40),
          files: [],
          patch: "",
          patch_bytes: 0,
          truncated: false,
          patch_log_path: null,
        },
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/archive") {
      const override = this.#hooks.onArchive?.(url.searchParams) ?? {};
      if (override.status !== undefined && override.status !== 200) {
        sendJson(res, override.status, { error: "archive_failed", message: "fake agent 故意拒绝归档" });
        return;
      }
      if (url.searchParams.get("dryRun") === "1") {
        sendJson(res, 200, override.dryRun ?? { size_bytes: 0, file_count: 0 });
        return;
      }
      const body = override.stream ?? DEFAULT_ARCHIVE_BODY;
      res.writeHead(200, { "content-type": "application/gzip" });
      if (Buffer.isBuffer(body) || typeof body === "string") {
        res.end(body);
      } else {
        body.on("error", () => res.destroy());
        body.pipe(res);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/files" && url.searchParams.get("raw") === "1") {
      const filePath = url.searchParams.get("path") ?? "";
      const override = this.#hooks.onReadFile?.(filePath) ?? {};
      if (override.body === undefined) {
        sendJson(res, 404, { error: "not_found", message: `fake agent 没有这个文件：${filePath}` });
        return;
      }
      const body = override.body;
      res.writeHead(override.status ?? 200, {
        "content-type": "application/octet-stream",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
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

// ---------------------------------------------------------------- Phase 9：fixture 仓库与 smart-HTTP git 服务器

/**
 * 一个**真的** smart-HTTP git 服务器，背后是 git 自带的 CGI `git http-backend`。
 *
 * 【为什么不用 GitHub】CI 里没有 GitHub App 的私钥，而 Phase 9 的红线恰恰是
 * "token 只走 `-c http.extraHeader`、绝不落盘"。这条红线的牙齿来自一个**会检查
 * Authorization 头的真 HTTP 服务器**：没有它，用 `file://` 的 fixture 跑出来的
 * "磁盘上没有 token"是一句空话（token 根本没被用过）。有了它，clone / push 走的是
 * 真实的 smart-HTTP（info/refs、upload-pack、receive-pack），错误 token 会拿到 401。
 *
 * 【为什么套 http-backend 而不是自己实现协议】smart-HTTP 是二进制协议，手写一个假的
 * 等于把"被测的东西"也一起换掉。http-backend 是 git 自带的 CGI，我们只给它套一个
 * HTTP 外壳与一层鉴权。
 */
export interface GitHttpServer {
  url: string;
  root: string;
  token: string;
  /** 收到过的请求（断言"确实走过 HTTP"与"用的是哪个头"）。 */
  readonly requests: Array<{ method: string; path: string; authorized: boolean }>;
  close(): Promise<void>;
}

export async function startGitHttpServer(options: { root: string; token: string }): Promise<GitHttpServer> {
  await mkdir(options.root, { recursive: true });
  const requests: GitHttpServer["requests"] = [];
  const expected = `Basic ${Buffer.from(`x-access-token:${options.token}`, "utf8").toString("base64")}`;

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fixture");
    const authorized = (req.headers.authorization ?? "") === expected;
    requests.push({ method: req.method ?? "GET", path: url.pathname, authorized });
    if (!authorized) {
      req.resume(); // 把请求体丢掉，不然连接不会复用
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Basic realm="git"' });
      res.end("authentication required\n");
      return;
    }
    await serveGitBackend(req, res, port, options.root, url);
  }

  return {
    url: `http://127.0.0.1:${port}`,
    root: options.root,
    token: options.token,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 把一条请求翻译成 CGI 环境变量，交给 `git http-backend`，再把 CGI 响应搬回 HTTP。 */
async function serveGitBackend(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  root: string,
  url: URL,
): Promise<void> {
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      // push 的 pack 会被 http-backend 整体缓存到内存再交给 receive-pack，
      // 默认上限 100MB。fixture 很小，但这个默认值在真实仓库上会直接 413，所以显式抬一下。
      GIT_HTTP_MAX_REQUEST_BUFFER: "1G",
      PATH_INFO: url.pathname,
      // CGI 的 QUERY_STRING **不带**前导 `?`（带上的话 http-backend 认不出
      // `service=git-receive-pack`，就会退回 dumb HTTP——clone 还能跑，push 直接死）。
      QUERY_STRING: url.search.replace(/^\?/, ""),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: req.headers["content-length"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "x-access-token",
      SERVER_PROTOCOL: "HTTP/1.1",
      SERVER_NAME: "127.0.0.1",
      SERVER_PORT: String(port),
      GATEWAY_INTERFACE: "CGI/1.1",
      HTTP_AUTHORIZATION: req.headers.authorization ?? "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  req.pipe(child.stdin);
  res.on("close", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  let buffer = Buffer.alloc(0);
  let headersWritten = false;
  for await (const chunk of child.stdout) {
    const data = chunk as Buffer;
    if (headersWritten) {
      res.write(data);
      continue;
    }
    buffer = Buffer.concat([buffer, data]);
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const head = buffer.subarray(0, separator).toString("utf8");
    const rest = buffer.subarray(separator + 4);
    const parsed = parseCgiHeaders(head);
    res.writeHead(parsed.status, parsed.headers);
    headersWritten = true;
    if (rest.length > 0) res.write(rest);
  }
  const code = await closed;
  if (!headersWritten) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`git http-backend 没有输出（exit ${code}）：${stderr}`);
    return;
  }
  res.end();
}

function parseCgiHeaders(head: string): { status: number; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of head.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "status") status = Number(value.split(" ")[0]) || 200;
    else headers[key] = value;
  }
  return { status, headers };
}

/** fixture 仓库的初始内容（含一个二进制文件与一个要被删除的文件）。 */
const FIXTURE_FILES: Record<string, string | Buffer> = {
  "README.md": "# rc-repo-fixture\n\nPhase 9 的仓库进出测试用它当远端。\n",
  "src/greet.js": "module.exports = (name) => `hi ${name}`;\n",
  "src/old-name.txt": "rename me\n",
  "src/delete-me.txt": "delete me\n",
  // 带 NUL 与非法 UTF-8 字节：二进制改动必须能过 --binary patch 这一关。
  "assets/blob.bin": Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff, 0x0a, 0x00, 0x42]),
  ".gitignore": "dist/\nnode_modules/\n",
};

export interface GitFixtureRepo {
  /** 裸仓库的宿主路径（http-backend 的 GIT_PROJECT_ROOT 下）。 */
  bareDir: string;
  /** HTTP clone 地址（`http://127.0.0.1:<port>/fixture/repo.git`）。 */
  url: string;
  /** 初始 commit 的 sha（`/diff?base=` 用它）。 */
  baseSha: string;
  branch: string;
  /** 初始文件清单（相对仓库根）。 */
  files: string[];
}

/** 在 `server.root` 下造一个裸仓库 fixture，并推一个初始提交进去。 */
export async function createGitFixtureRepo(options: {
  server: GitHttpServer;
  owner?: string;
  repo?: string;
  branch?: string;
  /** 覆盖初始文件（key 是相对仓库根的路径）。缺省用上面那份公共 fixture。 */
  files?: Record<string, string | Buffer>;
}): Promise<GitFixtureRepo> {
  const owner = options.owner ?? "fixture";
  const repo = options.repo ?? "repo";
  const branch = options.branch ?? "main";
  const files = options.files ?? FIXTURE_FILES;
  const bareDir = path.join(options.server.root, owner, `${repo}.git`);
  await mkdir(path.dirname(bareDir), { recursive: true });
  await gitOrFail(["init", "--bare", "--initial-branch", branch, bareDir]);
  // 裸仓库默认不收 push。smart-HTTP 的 receive-pack 要求显式打开。
  await gitOrFail(["-C", bareDir, "config", "http.receivepack", "true"]);

  const workDir = await mkdtemp(path.join(os.tmpdir(), "rc-fixture-"));
  try {
    await gitOrFail(["init", "-q", "--initial-branch", branch], workDir);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(workDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await gitOrFail(["-C", workDir, "add", "-A"]);
    await gitOrFail(["-C", workDir, "commit", "-qm", "fixture: 初始提交"], undefined, true);
    const baseSha = (await gitOrFail(["-C", workDir, "rev-parse", "HEAD"])).trim();
    await gitOrFail(["-C", workDir, "push", "-q", bareDir, `${branch}:refs/heads/${branch}`]);
    await gitOrFail(["-C", bareDir, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    return { bareDir, url: `${options.server.url}/${owner}/${repo}.git`, baseSha, branch, files: Object.keys(files) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * 站在“第三方”的位置往 fixture 的某条分支上推一个 commit。
 * Phase 9 的 force-with-lease 保护用例需要它：远端在我们上次推完之后变了。
 */
export async function pushCommitToFixture(input: {
  bareDir: string;
  branch: string;
  message: string;
  files: Record<string, string | Buffer>;
}): Promise<string> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "rc-fixture-third-"));
  try {
    await gitOrFail(["clone", "-q", input.bareDir, workDir]);
    // 分支可能在别处（还没创建）：那就在默认分支上开一条新的，而不是直接失败。
    const exists = await run(["git", "-C", workDir, "rev-parse", "--verify", `origin/${input.branch}`]);
    if (exists.code === 0) {
      await gitOrFail(["-C", workDir, "checkout", "-q", "-B", input.branch, `origin/${input.branch}`]);
    } else {
      await gitOrFail(["-C", workDir, "checkout", "-q", "-b", input.branch]);
    }
    for (const [relative, content] of Object.entries(input.files)) {
      const target = path.join(workDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await gitOrFail(["-C", workDir, "add", "-A"]);
    await gitOrFail(["-C", workDir, "commit", "-qm", input.message], undefined, true);
    const sha = (await gitOrFail(["-C", workDir, "rev-parse", "HEAD"])).trim();
    await gitOrFail(["-C", workDir, "push", "-q", "origin", `HEAD:refs/heads/${input.branch}`]);
    return sha;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** fixture 里的 git 调用：身份、签名开关都显式传，CI runner 上没有全局配置。 */
async function gitOrFail(args: string[], cwd?: string, withIdentity = false): Promise<string> {
  const identity = withIdentity
    ? ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false"]
    : [];
  const result = await run(["git", ...identity, ...args], cwd === undefined ? {} : { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} 失败（exit ${result.code}）：${result.stderr.trim()}`);
  }
  return result.stdout;
}

// ---------------------------------------------------------------- Phase 10：MinIO

export interface TestMinio {
  containerName: string;
  /** `http://127.0.0.1:<随机端口>`——SDK 用它。 */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `docker rm -f`（一次性容器，数据丢了就丢了）。 */
  stop(): Promise<void>;
}

/**
 * 一次性 MinIO 容器（spec Phase 10 的测试要点：用 MinIO 容器）。
 *
 * 【为什么端口随机】与 `startPostgres` 同一条理由：`node --test` 默认并行跑文件，
 * 钉死 9000 会让两个集成测试文件撞在一起。用 `-p 127.0.0.1::9000` 让 Docker 分配。
 *
 * 【为什么由脚手架建桶】S3 的 CreateBucket 不是幂等的便利操作（AWS 上还牵扯 region），
 * 每个用例都写一遍只会多一处会漂的实现。建完桶再把控制权交给用例。
 *
 * 【为什么健康检查用 HTTP 而不是"等端口通"】MinIO 起来后还要初始化磁盘，
 * 端口通了不代表能签请求；`/minio/health/ready` 才是"能服务了"的定义。
 */
export async function startMinio(options: { image?: string; bucket?: string } = {}): Promise<TestMinio> {
  const containerName = `rc-test-minio-${process.pid}-${randomBytes(3).toString("hex")}`;
  const image = options.image ?? process.env.MINIO_IMAGE ?? "minio/minio:latest";
  const accessKeyId = "reuben_cloud_test";
  const secretAccessKey = "reuben_cloud_test_secret";
  const bucket = options.bucket ?? "reuben-cloud-test";

  await dockerOrThrow([
    "run",
    "-d",
    "--name",
    containerName,
    "-e",
    `MINIO_ROOT_USER=${accessKeyId}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
    "-p",
    "127.0.0.1::9000",
    image,
    "server",
    "/data",
  ]);

  let endpoint = "";
  try {
    const portOutput = await dockerOrThrow(["port", containerName, "9000"]);
    const port = Number(portOutput.trim().split("\n")[0]!.split(":").pop());
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`拿不到 ${containerName} 的宿主端口：${JSON.stringify(portOutput)}`);
    }
    endpoint = `http://127.0.0.1:${port}`;
    await waitForMinio(endpoint, 60_000);
    await createBucket({ endpoint, accessKeyId, secretAccessKey, bucket });
  } catch (error) {
    await docker(["rm", "-f", containerName]);
    throw error;
  }

  return {
    containerName,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    stop: async () => {
      await docker(["rm", "-f", containerName]);
    },
  };
}

/** 轮询 `/minio/health/ready` 直到 200。 */
async function waitForMinio(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/minio/health/ready`);
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) throw new Error(`等 MinIO 就绪超时（${timeoutMs}ms）：${lastError}`);
    await delay(300);
  }
}

/** 建桶。已存在（BucketAlreadyOwnedByYou / BucketAlreadyExists）视同成功。 */
async function createBucket(config: {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}): Promise<void> {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
  } finally {
    client.destroy();
  }
}

// ---------------------------------------------------------------- Phase 12：假 GitHub（PR API）

/**
 * 一个记录调用、并按脚本发挥的假 GitHub PR API。
 *
 * 【为什么放进 support.ts 而不是某个测试文件】单测（幂等 / 限流 / 权限）与集成测试
 * （`finishRun` 的整条收尾路径）都要用它。放进 `.test.ts` 会让另一个 import 它的
 * 文件把那整份用例也跑一遍——这是 support.ts 文件头记过的那条规矩。
 *
 * 【为什么不逐个 mock 函数】幂等这条逻辑要回答的是"最后仓库里到底有几条 PR"，
 * 而不是"第几个函数被调了几次"。所以这里维护一份**真的 PR 列表**：`create` 往列表里
 * 塞、`update` 改列表里的那一条，与 GitHub 的行为同构。
 */
export class FakePullRequestApi implements PullRequestApi {
  readonly pullRequests: PullRequestRecord[] = [];
  readonly calls: string[] = [];
  /** 抛错队列：每次调用先弹一个出来（用来测权限 403 / 限流 403+retry-after）。 */
  createFailures: unknown[] = [];
  updateFailures: unknown[] = [];
  listFailures: unknown[] = [];
  defaultBranch = "main";
  /** 每次 create 收到的 token 之外的东西（断言 draft / base 用）。 */
  readonly creates: CreatePullRequestInput[] = [];
  #nextNumber = 101;

  async listOpenByHead(_ref: RepoRef, head: string): Promise<PullRequestRecord[]> {
    this.calls.push(`list:${head}`);
    this.#throwNext(this.listFailures);
    return this.pullRequests.filter((item) => item.state === "open" && item.head.endsWith(`:${head}`));
  }

  async create(ref: RepoRef, input: CreatePullRequestInput): Promise<PullRequestRecord> {
    this.calls.push(`create:${input.head}:draft=${input.draft}`);
    this.#throwNext(this.createFailures);
    this.creates.push(input);
    const number = this.#nextNumber++;
    const record: PullRequestRecord = {
      number,
      htmlUrl: `https://github.com/${ref.owner}/${ref.repo}/pull/${number}`,
      state: "open",
      draft: input.draft,
      title: input.title,
      body: input.body,
      head: `${ref.owner}:${input.head}`,
      base: input.base,
    };
    this.pullRequests.push(record);
    return record;
  }

  async update(_ref: RepoRef, input: UpdatePullRequestInput): Promise<PullRequestRecord> {
    this.calls.push(`update:${input.number}`);
    this.#throwNext(this.updateFailures);
    const found = this.pullRequests.find((item) => item.number === input.number);
    if (found === undefined) throw new RepoError("pr_not_found", "没有这条 PR");
    if (input.title !== undefined) found.title = input.title;
    if (input.body !== undefined) found.body = input.body;
    if (input.base !== undefined) found.base = input.base;
    return found;
  }

  async getDefaultBranch(): Promise<string> {
    return this.defaultBranch;
  }

  #throwNext(queue: unknown[]): void {
    const next = queue.shift();
    if (next !== undefined) throw next;
  }
}
