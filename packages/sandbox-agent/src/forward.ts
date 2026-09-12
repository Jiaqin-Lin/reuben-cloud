/**
 * 极小的 TCP 端口转发中继。**只在 macOS 上被用到**。
 *
 * 【为什么需要它】CP 在宿主上，Linux 上它能直接连容器的内网 IP；macOS / Docker Desktop
 * 隔着一个 VM，宿主路由不到容器的 172.x 地址。而 Docker Engine **不会**给"只挂在
 * `--internal` 网络上的容器"编程端口映射（容器照常起，`NetworkSettings.Ports` 是空的，
 * 这是一个静默失败）。所以 darwin 上 CP 会额外起一个容器：它同时挂在内网和默认 bridge 上，
 * 发布一个 127.0.0.1 的随机端口，然后由本文件把流量转到沙箱 agent 的 8080。
 * 完整背景写在 `packages/control-plane/src/provider/local-docker.ts` 的文件头。
 *
 * 【它是什么、不是什么】它是一个**单向意图**的中继：`--target` 在启动时就定死了，
 * 只能连到那一个地址。它**不是**代理，不能用来访问任意主机——沙箱就算连上它，
 * 也只是绕回自己的 agent。这一点很重要：转发容器为了拿到端口发布而挂在默认 bridge 上，
 * 如果没有"只能到 target"这条约束，它就成了一条现成的出网通道。
 *
 * 【为什么放在 sandbox-agent 里】转发容器跑的就是沙箱镜像（已经拉过了，不用额外构建），
 * 而镜像里只有 `packages/sandbox-agent/src`。放在这里还顺带让它被 `npm test` 覆盖
 * （不需要 Docker 就能测）。
 *
 * 用法（由 provider 拼出来，人一般不会手敲）：
 *   node src/forward.ts --listen 8080 --target reuben-cloud-sbx-xxx:8080
 */

import { realpathSync } from "node:fs";
import net from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";

/** 监听地址。容器里必须听 0.0.0.0：内网上的沙箱与宿主发布端都要能连进来。 */
const DEFAULT_LISTEN_HOST = "0.0.0.0";

/** 单条连接没有数据也不会被掐断——HTTP keep-alive 的 CP 连接可能长时间空闲。 */
const KEEPALIVE_MS = 30_000;

export interface ForwarderOptions {
  /** 监听端口。0 = 让内核随便给一个（测试用）。 */
  listenPort: number;
  listenHost?: string;
  targetHost: string;
  targetPort: number;
  /** 每行日志的出口。默认打到 stdout——容器日志就是它的归宿。 */
  log?: (message: string) => void;
}

export interface Forwarder {
  /** 实际监听的端口（`listenPort: 0` 时是内核分配的）。 */
  readonly port: number;
  /** 已建立的连接数（测试与排查用，不参与逻辑）。 */
  connections(): number;
  /** 停止监听并掐掉所有在转的连接。幂等。 */
  close(): Promise<void>;
}

/**
 * 起一个转发器。
 *
 * 每条客户端连接配一条到 target 的上行连接，两个方向都 `pipe`（Node 的 pipe 自带背压，
 * 不需要手写缓冲区——手写缓冲是这类代码最常见的 bug 来源）。
 * 任何一侧出错就整对销毁：TCP 中继没有"半个连接还有救"的语义。
 */
export async function startForwarder(options: ForwarderOptions): Promise<Forwarder> {
  const log = options.log ?? ((message: string) => console.log(message));
  const listenHost = options.listenHost ?? DEFAULT_LISTEN_HOST;
  const target = { host: options.targetHost, port: options.targetPort };

  // 活着的连接对：关闭时要主动掐掉，否则 close() 之后进程还被旧连接吊着。
  const pairs = new Set<{ client: Socket; upstream: Socket }>();

  const server: Server = net.createServer((client: Socket) => {
    const upstream = net.connect(target);
    const pair = { client, upstream };
    pairs.add(pair);
    // 空闲连接不设超时：CP 可能要等很久才有下一条命令。
    client.setKeepAlive(true, KEEPALIVE_MS);
    upstream.setKeepAlive(true, KEEPALIVE_MS);

    const destroy = (): void => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", destroy);
    upstream.on("error", destroy);
    client.on("close", destroy);
    upstream.on("close", destroy);

    // 双向 pipe。`pipe` 会在源结束时给目标发 FIN——这正是 HTTP 需要的半关闭语义。
    client.pipe(upstream);
    upstream.pipe(client);
  });

  server.on("error", (error: Error) => {
    // 监听失败（端口被占）是致命的：进程退出比"看起来在跑其实没听"好。
    log(`[forward] server error: ${error.message}`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  log(`[forward] listening on ${listenHost}:${address.port} -> ${target.host}:${target.port}`);

  return {
    port: address.port,
    connections: () => pairs.size,
    close: async () => {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      pairs.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 解析 `--listen` / `--target` / `--host`。失败时返回一句人话，由 main 打印并退出。 */
export function parseArgs(argv: string[]): { ok: true; value: ForwarderOptions } | { ok: false; error: string } {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) return { ok: false, error: `无法识别的参数：${item}` };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${item} 缺少取值` };
    }
    flags.set(item.slice(2), value);
    index += 1;
  }

  const listen = flags.get("listen");
  const target = flags.get("target");
  if (listen === undefined) return { ok: false, error: "缺少 --listen <port>" };
  if (target === undefined) return { ok: false, error: "缺少 --target <host:port>" };

  const listenPort = Number(listen);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    return { ok: false, error: `--listen 必须是 0..65535 的整数，得到 ${JSON.stringify(listen)}` };
  }

  // target 只允许 `host:port` 形式。不解析 IPv6 字面量（我们不生成这种 target），
  // 与其写一段半对的解析，不如明确拒绝。
  const separator = target.lastIndexOf(":");
  if (separator <= 0) return { ok: false, error: `--target 必须是 host:port，得到 ${JSON.stringify(target)}` };
  const targetHost = target.slice(0, separator);
  const targetPort = Number(target.slice(separator + 1));
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return { ok: false, error: `--target 的端口不合法：${JSON.stringify(target)}` };
  }

  return {
    ok: true,
    value: { listenPort, listenHost: flags.get("host"), targetHost, targetPort },
  };
}

/**
 * CLI 入口。**只在真正作为进程启动时**才跑（不是被 import 时），这样本文件
 * 既是一个可执行程序，也是一个可被 `npm test` import 的库。
 *
 * 判断方式用 `import.meta.filename` 与 `process.argv[1]` 对比（前者已经是
 * 符号链接解析后的绝对路径，后者要做一次 realpath —— 镜像里 /app 可能就是链接）。
 * 不用 `import.meta.main`：它是 Node 24.2 才加的，而 tsconfig 里的 @types/node 还没声明它。
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === import.meta.filename;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`[forward] ${parsed.error}`);
    console.error("用法：node src/forward.ts --listen <port> --target <host:port> [--host <bind>]");
    process.exit(2);
  }

  const forwarder = await startForwarder(parsed.value);

  // 容器停止时 Docker 先发 SIGTERM，10 秒后 SIGKILL。转发器没有需要"优雅"的东西，
  // 但显式处理信号能让容器日志里有一行清楚的结束记录。
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[forward] ${signal} received, closing ${forwarder.connections()} connection(s)`);
    void forwarder.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (isEntrypoint()) {
  void main().catch((error: unknown) => {
    console.error(`[forward] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
