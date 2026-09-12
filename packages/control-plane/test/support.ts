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
import net from "node:net";
import type { SandboxSpec } from "../src/provider/types.ts";

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

// ---------------------------------------------------------------- 镜像

/** 集成测试默认用的本地镜像 tag（`npm run build:image` 或 `npm run check:image` 建出来的）。 */
export const DEFAULT_IMAGE_TAG = process.env.SANDBOX_IMAGE ?? "reuben-cloud/sandbox-base:dev";

/**
 * 把本地镜像解析成 **digest 引用**（`repo@sha256:…`）。
 *
 * 为什么必须带 digest：`SandboxSpec.image` 只接受 digest（§C.1），而"本地构建的镜像"
 * 恰好没有 registry 里的 tag 可查。Docker 的经典存储与 containerd 存储都把本地镜像的
 * digest 放在 `RepoDigests` / `Id` 里（实验证明两者在这个环境下一致：
 * containerd 存储的 `.Id` 就是 manifest digest），provider 的 `#ensureImage` 又是
 * "本地命中就不拉"，所以本地开发不需要任何 registry。
 *
 * @throws 镜像不存在时抛出，并告诉使用者先跑构建命令——比让 create 报"拉镜像失败"清楚得多。
 */
export async function resolveImageRef(tag: string = DEFAULT_IMAGE_TAG): Promise<string> {
  const result = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}} {{json .RepoDigests}}",
    tag,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `本地没有镜像 ${tag}。先跑 \`npm run build:image\`（或用 SANDBOX_IMAGE 指定别的镜像）。\n${result.stderr.trim()}`,
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
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ExecOutcome> {
  const accepted = await fetch(`${baseUrl}/exec`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      cmd,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    }),
  });
  if (accepted.status !== 202) {
    throw new Error(`POST /exec 得到 ${accepted.status}：${await accepted.text()}`);
  }
  const { execution_id: executionId } = (await accepted.json()) as { execution_id: string };

  const events = await readEvents(`${baseUrl}/exec/${executionId}/events`, token, { timeoutMs: 60_000 });
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
