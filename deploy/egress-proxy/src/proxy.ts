/**
 * egress-proxy：沙箱唯一的出网路径（spec Phase 6）。
 *
 * 【它是什么】一个只做域名判断的 HTTP 代理，两种请求都接：
 *  - **CONNECT**（HTTPS 与一切 TLS）：只看 `CONNECT host:port` 里的域名，放行之后就是一条
 *    裸 TCP 隧道。**不解密、不 MITM、不注入 CA、不看路径**——正因为看不懂内容，
 *    它也就没有"改内容"这个攻击面。
 *  - **绝对 URI 的普通请求**（`GET http://deb.debian.org/... HTTP/1.1`）：Debian/Ubuntu 的
 *    apt 源是**明文 http**，只支持 CONNECT 的代理会让 `apt-get` 完全不能用，所以这一支必须接。
 *
 * 【强制来自拓扑，不来自这个文件】沙箱挂在 `--internal` 网络上，没有默认路由，
 * 它唯一的出口是这个容器。就算沙箱把自己的代理环境变量全删了，它也出不去（§F.2）。
 * 换言之：这个代理是"便利 + 审计 + 域名级白名单"，不是"唯一防线"。防线是网络拓扑。
 *
 * 【日志】每请求一行 JSON 到 stdout，交给 Docker 的 json-file 驱动轮转（附录 A-11）。
 * 字段：时间、来源 IP、域名、端口、决策、字节数、耗时。**不记录路径、不记录请求体**——
 * 那是内容，而我们本来就是为了不看内容才这么设计的。
 *
 * 【错误的方向要往哪边走】白名单文件读不出来 / 语法错（含裸 `*`）→ **拒绝启动**。
 * SIGHUP 重载时读坏 → **保留旧名单**继续跑。前者是部署错误，后者是运行期意外事故，
 * 把它们混成一种处理方式，要么让事故变成宕机，要么让部署错误悄悄上线。
 */

import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import net from "node:net";
import type { Socket } from "node:net";
import {
  AllowlistError,
  describeAllowlist,
  isIpLiteral,
  loadAllowlistFile,
  matchAllowlist,
  normalizeHost,
  splitAuthority,
} from "./allowlist.ts";
import type { Allowlist, AllowlistRule } from "./allowlist.ts";

/** 版本号进 `/healthz`，运维一眼就能看出跑的是哪一版。 */
export const VERSION = "0.0.1";

/** 内网里监听的端口（spec §0.1：`reuben-cloud-proxy` 别名 / 3128）。 */
export const DEFAULT_PORT = 3128;
/** 容器里必须监听 0.0.0.0；单元测试传 127.0.0.1。 */
export const DEFAULT_HOST = "0.0.0.0";
/** 镜像里烘进去的缺省白名单路径；运行时用 bind mount 覆盖它才能 SIGHUP 重载。 */
export const DEFAULT_ALLOWLIST_PATH = "/app/allowlist.txt";
/** 上游 TCP 连接（含等响应头）的预算。到点回 502，不无限挂着。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * 健康检查路径。**故意是一个 origin-form 路径**（不是代理请求），
 * 所以它不会跟"看域名"的主流程抢语义：只有直接打到代理端口、不做 Host 转发的探针才会命中它。
 * `ensureRunning` 与镜像的 HEALTHCHECK 用它。
 */
export const HEALTH_PATH = "/healthz";

/** 一行日志。请求日志与生命周期事件共用同一个 JSON 结构，全部走 stdout。 */
export type LogLine = Record<string, unknown>;
export type LogSink = (line: LogLine) => void;

export interface EgressProxyOptions {
  /** 白名单文件路径。启动时必读；SIGHUP 时重读。 */
  allowlistPath: string;
  /** 监听端口，0 = 随机（测试）。 */
  port?: number;
  /** 监听地址。 */
  host?: string;
  /** 上游连接预算（毫秒）。 */
  connectTimeoutMs?: number;
  /** 日志出口。默认 JSON 到 stdout；测试注入数组。 */
  log?: LogSink;
}

/** 代理实例。三个方法对应三种运维动作：起、重载、停。 */
export interface EgressProxy {
  readonly server: Server;
  /** 当前生效的白名单（reload 之后会换成新的对象）。 */
  allowlist(): Allowlist;
  /** 监听成功后的真实地址。 */
  address(): { host: string; port: number } | null;
  listen(): Promise<{ host: string; port: number }>;
  /** 重读白名单文件。失败时**保持旧名单**并抛错，由调用方决定怎么记。 */
  reload(): Allowlist;
  /** 关掉 server 与所有在途连接（含 CONNECT 隧道）。 */
  close(): Promise<void>;
}

/**
 * 造一个代理实例。**构造时就会加载白名单**：文件不存在、语法错、含裸 `*` 都在这里抛，
 * 所以"拒绝启动"这条规矩是结构性的，不依赖调用方记得先校验。
 */
export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  const log: LogSink = options.log ?? defaultLog;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  // 可变：SIGHUP 之后指向新对象。读写都只经过下面这几个闭包。
  let allowlist = loadAllowlistFile(options.allowlistPath);
  // 追踪所有 TCP 连接，以便 close() 能把 CONNECT 隧道也拆掉——Node 的
  // `server.closeAllConnections()` 不负责已被 `connect` 事件接管、已脱离 HTTP 解析器的 socket。
  const sockets = new Set<Socket>();
  let closed = false;

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  /** 给一次请求做判决。返回原因而不是布尔：日志要能回答"为什么被拒"。 */
  const decide = (hostValue: string): { host: string; rule: AllowlistRule } | { host: string; reason: string } => {
    const host = normalizeHost(hostValue);
    if (host === "") return { host, reason: "empty_host" };
    // IP 直连一律拒绝。这是刻意的：域名白名单遇到 IP 没有任何可判断的东西。
    if (isIpLiteral(host)) return { host, reason: "ip_literal" };
    const rule = matchAllowlist(allowlist, host);
    if (rule === null) return { host, reason: "not_allowlisted" };
    return { host, rule };
  };

  /** 构造一行请求日志。字段名与 spec 里那张表对齐（域名/决策/字节/耗时）。 */
  const requestLine = (input: {
    kind: "connect" | "http";
    src: string;
    startedAt: number;
    method?: string;
    host?: string;
    port?: number;
    decision: "allow" | "deny";
    rule?: string;
    reason?: string;
    inBytes?: number;
    outBytes?: number;
    error?: string;
  }): LogLine => {
    const line: LogLine = {
      ts: new Date().toISOString(),
      kind: input.kind,
      src: input.src,
      host: input.host ?? "",
      port: input.port ?? 0,
      decision: input.decision,
      in: input.inBytes ?? 0,
      out: input.outBytes ?? 0,
      ms: Date.now() - input.startedAt,
    };
    // method / rule / reason / error 只在有值时才出现：日志行保持紧凑，字段缺省 = 不适用。
    if (input.method !== undefined) line.method = input.method;
    if (input.rule !== undefined) line.rule = input.rule;
    if (input.reason !== undefined) line.reason = input.reason;
    if (input.error !== undefined) line.error = input.error;
    return line;
  };

  /** 在最原始的那条 TCP 连接上写一个拒绝响应并关闭它（CONNECT 阶段用）。 */
  const denySocket = (socket: Socket, status: string, reason: string): void => {
    const body = `${reason}\n`;
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  };

  const logWarnings = (source: Allowlist): void => {
    for (const warning of source.warnings) log({ ts: new Date().toISOString(), event: "warn", message: warning });
  };

  // ------------------------------------------------------------ CONNECT（HTTPS 走这条）

  function handleConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    track(clientSocket);
    const startedAt = Date.now();
    const src = remoteAddress(clientSocket);
    let upstream: Socket | null = null;
    let configured = false;
    let denied = false;
    let decided = false;
    let finished = false;
    let inBytes = 0;
    let outBytes = 0;
    let host = "";
    let port = 443;
    let rule: string | undefined;

    /** 只记一次"放行"日志（含失败原因），且被拒的连接不重复记。 */
    const finish = (error?: unknown): void => {
      // 还没做判决就断开的连接没有"域名/决策"可记，不产生噪声日志。
      if (!decided || finished || denied) return;
      finished = true;
      log(
        requestLine({
          kind: "connect",
          src,
          startedAt,
          host,
          port,
          decision: "allow",
          rule,
          inBytes,
          outBytes,
          error: errorMessage(error),
        }),
      );
    };

    // 【这一步必须在最前面】`connect` 事件给了我们一条**已经脱离 HTTP 解析器**的裸 socket。
    // 任何没有监听器的 'error'（客户端 RST 是最常见的）都会以未捕获异常的形式把整个
    // 代理进程带走——一个守护进程因为某个客户端断开就退出，等于"所有沙箱同时失去出网"。
    // 这个 bug 是手工验证时踩到的（npm 放弃一次 502 后 RST，代理直接退出），
    // 单测里的用例 9 把它钉住。
    clientSocket.on("error", (error: Error) => {
      upstream?.destroy();
      finish(error);
    });

    const authority = splitAuthority(req.url ?? "", 443);
    if (authority === null) {
      // 解析不出来的 authority 不给任何猜测的机会：400 + 记日志。
      denied = true;
      denySocket(clientSocket, "400 Bad Request", "bad_authority");
      log(requestLine({ kind: "connect", src, startedAt, decision: "deny", reason: "bad_authority" }));
      return;
    }
    port = authority.port;

    const verdict = decide(authority.host);
    if (!("rule" in verdict)) {
      denied = true;
      host = verdict.host;
      denySocket(clientSocket, "403 Forbidden", verdict.reason);
      log(
        requestLine({
          kind: "connect",
          src,
          startedAt,
          host,
          port,
          decision: "deny",
          reason: verdict.reason,
        }),
      );
      return;
    }
    host = verdict.host;
    rule = verdict.rule.raw;
    decided = true;

    upstream = net.connect({ host, port });
    // 在 connect 之前的失败（DNS 不解析、目标拒绝、超时）都走这里：回 502，隧道没建起来。
    const timer = setTimeout(() => {
      upstream?.destroy(new Error(`upstream connect timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
    upstream.on("error", (error: Error) => {
      clearTimeout(timer);
      if (!configured) {
        denySocket(clientSocket, "502 Bad Gateway", "upstream_unreachable");
        finish(error);
        return;
      }
      clientSocket.destroy();
      finish(error);
    });

    upstream.once("connect", () => {
      configured = true;
      clearTimeout(timer);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // head 是客户端在 CONNECT 之后立刻发来的字节（TLS ClientHello 常常在里面），
      // 必须原样送到上游，否则握手会莫名卡住。
      if (head.length > 0) {
        inBytes += head.length;
        upstream!.write(head);
      }
      upstream!.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
      });
      clientSocket.on("data", (chunk: Buffer) => {
        inBytes += chunk.length;
      });
      // pipe 的 'error' 不会被 pipe 吞掉：两个方向都在上面的监听器里收尾。
      upstream!.pipe(clientSocket);
      clientSocket.pipe(upstream!);

      // 任意一侧断开都要把另一侧带走，否则会攒下半开的 socket。
      upstream!.on("close", () => {
        clientSocket.destroy();
        finish();
      });
      upstream!.on("end", () => {
        clientSocket.end();
      });
      clientSocket.on("close", () => {
        upstream?.destroy();
        finish();
      });
    });
  }

  // ------------------------------------------------------------ 绝对 URI 的普通请求

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const startedAt = Date.now();
    const src = remoteAddress(req.socket);
    const rawUrl = req.url ?? "";

    // 健康检查：只认 origin-form（`GET /healthz`），即"直接打到代理端口"的那种探针。
    // 用代理方式访问它的请求（绝对 URI）会走正常的白名单流程——不给自己开一个后门。
    if (rawUrl === HEALTH_PATH && (req.method === "GET" || req.method === "HEAD")) {
      const body = JSON.stringify({
        status: "ready",
        version: VERSION,
        rules: allowlist.rules.length,
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    if (!/^https?:\/\//i.test(rawUrl)) {
      // origin-form（`GET /path`）= 有人把代理当普通服务器用了。回一个说人话的 400。
      sendText(
        res,
        400,
        "这是一个 HTTP 代理，不是 origin server：请把请求发成绝对 URI（GET http://host/path），" +
          "或者对 HTTPS 用 CONNECT。",
      );
      log(
        requestLine({ kind: "http", src, startedAt, method: req.method, decision: "deny", reason: "not_proxy_request" }),
      );
      return;
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      sendText(res, 400, `无法解析请求里的绝对 URI：${rawUrl.slice(0, 120)}`);
      log(requestLine({ kind: "http", src, startedAt, method: req.method, decision: "deny", reason: "bad_uri" }));
      return;
    }
    if (target.protocol !== "http:") {
      // https 的明文代理请求没有标准语义（那正是 CONNECT 的用途）。不猜，直接告诉调用方。
      sendText(res, 400, "https 请用 CONNECT 方法（curl/npm/pip 都会自动这么做）。");
      log(
        requestLine({
          kind: "http",
          src,
          startedAt,
          method: req.method,
          host: normalizeHost(target.hostname),
          decision: "deny",
          reason: "unsupported_scheme",
        }),
      );
      return;
    }

    const verdict = decide(target.hostname);
    if (!("rule" in verdict)) {
      sendText(res, 403, `域名不在白名单里：${verdict.host || "(空)"}（${verdict.reason}）`);
      log(
        requestLine({
          kind: "http",
          src,
          startedAt,
          method: req.method,
          host: verdict.host,
          port: portOf(target, 80),
          decision: "deny",
          reason: verdict.reason,
        }),
      );
      return;
    }

    const host = verdict.host;
    const port = portOf(target, 80);
    let finished = false;
    let inBytes = 0;
    let outBytes = 0;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      log(
        requestLine({
          kind: "http",
          src,
          startedAt,
          method: req.method,
          host,
          port,
          decision: "allow",
          rule: verdict.rule.raw,
          inBytes,
          outBytes,
          error: errorMessage(error),
        }),
      );
    };

    // 逐跳头（hop-by-hop）不能转发：它们是"这一段连接"的语义，转出去会破坏下一段。
    // `transfer-encoding` 尤其重要——交给 Node 按流式 body 重新决定分块方式。
    const upstream = httpRequest({
      host,
      port,
      method: req.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      headers: filterHopByHop(req.headers),
    });

    const connectTimer = setTimeout(() => {
      upstream.destroy(new Error(`upstream connect timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    req.on("data", (chunk: Buffer) => {
      inBytes += chunk.length;
    });
    upstream.on("response", (upstreamRes: IncomingMessage) => {
      clearTimeout(connectTimer);
      res.writeHead(upstreamRes.statusCode ?? 502, filterHopByHop(upstreamRes.headers));
      upstreamRes.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
      });
      upstreamRes.pipe(res);
      upstreamRes.on("error", (error: Error) => {
        res.destroy();
        finish(error);
      });
      upstreamRes.on("end", () => {
        finish();
      });
    });
    upstream.on("error", (error: Error) => {
      clearTimeout(connectTimer);
      if (!res.headersSent) sendText(res, 502, `上游不可达：${host}:${port}（${error.message}）`);
      else res.destroy();
      finish(error);
    });
    // 客户端中途断开：把上游请求也掐掉，别让它继续往一个没人的方向写。
    req.on("error", (error: Error) => {
      upstream.destroy();
      finish(error);
    });
    // res 的错误同样要有人接：没有监听器时它会冒到 socket 上，变成一条看不出源头的事件。
    res.on("error", (error: Error) => {
      upstream.destroy();
      finish(error);
    });
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  }

  // ------------------------------------------------------------ server 本体

  const server = createServer(handleRequest);
  server.on("connect", handleConnect);
  // TCP 层的错误必须有监听器，否则一个 ECONNRESET 就能把整个进程带走。
  server.on("clientError", (error: Error, socket: Socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
    log({ ts: new Date().toISOString(), event: "client_error", error: error.message });
  });

  // ------------------------------------------------------------ 实例方法

  return {
    server,

    allowlist(): Allowlist {
      return allowlist;
    },

    address(): { host: string; port: number } | null {
      const address = server.address();
      if (address === null || typeof address === "string") return null;
      return { host: address.address, port: address.port };
    },

    async listen(): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? DEFAULT_PORT, options.host ?? DEFAULT_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      const result =
        address === null || typeof address === "string"
          ? { host: options.host ?? DEFAULT_HOST, port: options.port ?? DEFAULT_PORT }
          : { host: address.address, port: address.port };
      log({ ts: new Date().toISOString(), event: "listen", ...result, ...describeAllowlist(allowlist) });
      logWarnings(allowlist);
      return result;
    },

    reload(): Allowlist {
      // 先解析、后赋值：解析抛错时旧名单原样生效（这是 SIGHUP 的正确语义）。
      const next = loadAllowlistFile(options.allowlistPath);
      allowlist = next;
      log({ ts: new Date().toISOString(), event: "reload", ...describeAllowlist(next) });
      logWarnings(next);
      return next;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 还有连接没断干净时不等它：代理没有"优雅排空"的语义，关了就是关了。
        setTimeout(resolve, 1_000).unref();
      });
      log({ ts: new Date().toISOString(), event: "close" });
    },
  };
}

/**
 * 环境变量 → 启动配置。
 *
 * 只读四个变量，缺省值直接写在这里：代理是个全局常驻的基础设施，配置项越多越容易配错。
 * 数值变量的校验规则与 sandbox-agent 的 `intEnv` 一样：设了但不是非负整数就抛，
 * 宁可启动失败也不要带着一个诡异的数字跑起来。
 */
export interface EgressProxyEnv {
  allowlistPath: string;
  port: number;
  host: string;
  connectTimeoutMs: number;
}

export function loadProxyEnv(env: NodeJS.ProcessEnv = process.env): EgressProxyEnv {
  return {
    allowlistPath: env.EGRESS_PROXY_ALLOWLIST ?? DEFAULT_ALLOWLIST_PATH,
    port: intEnv(env, "EGRESS_PROXY_PORT", DEFAULT_PORT),
    host: env.EGRESS_PROXY_HOST ?? DEFAULT_HOST,
    connectTimeoutMs: intEnv(env, "EGRESS_PROXY_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
  };
}

/** 默认日志出口：一行 JSON 到 stdout（Docker 的 json-file 驱动负责轮转，附录 A-11）。 */
const defaultLog: LogSink = (line) => {
  console.log(JSON.stringify(line));
};

// ---------------------------------------------------------------- 纯零件

/** 逐跳头名单（RFC 7230 §6.1）。转发它们会把上一段的连接语义带到下一段。 */
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

/** 过滤逐跳头。`host` 保留：它是虚拟主机的依据，也是上游看到的原始请求的一部分。 */
export function filterHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

function sendText(res: ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function portOf(target: URL, fallback: number): number {
  if (target.port === "") return fallback;
  const port = Number(target.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function remoteAddress(socket: Socket): string {
  return socket.remoteAddress ?? "";
}

/** 错误 → 日志字段。没有错误时返回 undefined，日志里就不出现这个字段。 */
function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

// ---------------------------------------------------------------- 入口

/**
 * 启动入口。`import.meta.main` 保证"被测试 import 时不会自动监听"——
 * 这正是把服务写成工厂函数而不是顶层副作用的原因。
 */
async function main(): Promise<void> {
  const config = loadProxyEnv();
  // createEgressProxy 构造时就会读白名单：文件缺失、语法错、裸 `*` 全部在这里变成启动失败。
  const proxy = createEgressProxy({ ...config, log: defaultLog });

  // ---------------------------------------------------------------- 信号处理
  //
  // 【顺序：必须在对外宣布就绪之前装好】这是一条被 CI 抓出来的真 bug（Phase 7 实现备注 18）：
  // banner 一旦写进管道，父进程（docker stop / 测试）读到它就可能立刻发 SIGTERM——而那一刻
  // 内核里 SIGTERM 还挂着**默认动作**（杀死进程），于是进程以"被信号打死"收场、退出码是 null。
  // 这个窗口在 macOS 上跑几十次不露头，Linux CI 上第一次真跑就翻了
  // （control-plane 的 egress-proxy-server.test.ts 「正常启动 + SIGTERM 优雅退出」）。
  // sandbox-agent 的 index.ts 是同一天修的同一条 bug（它俩的入口形状本来就一样）。
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[egress-proxy] ${signal} received, closing`);
    await proxy.close();
    process.exit(0);
  };

  /**
   * 信号回调是同步接口，而 shutdown 是 async——所以这里必须自己接住它的拒绝：
   * 未处理的 Promise 拒绝在 Node 24 里默认是堆栈 + 非 0 退出，那就变成了"SIGTERM 导致代理崩溃"。
   * 收尾里出错也仍然 exit(0)（在 Docker 的信号路径上，0 表示"我按你的要求停了"），
   * 细节写在 stderr 里。
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[egress-proxy] shutdown failed: ${message}`);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const address = await proxy.listen();
  console.log(
    `[egress-proxy] v${VERSION} listening on ${address.host}:${address.port} allowlist=${config.allowlistPath}`,
  );

  // SIGHUP（`docker kill -s HUP`）重载白名单：生产上换清单不重启。
  // 重载失败**保留旧名单**——这是运行期事故，不该让整个代理停摆。
  process.on("SIGHUP", () => {
    try {
      proxy.reload();
      console.log("[egress-proxy] allowlist reloaded");
    } catch (error) {
      const message = error instanceof AllowlistError ? error.message : String(error);
      console.error(`[egress-proxy] reload failed, keeping the current allowlist: ${message}`);
    }
  });
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[egress-proxy] failed to start: ${message}`);
    process.exit(1);
  });
}
