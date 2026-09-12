/**
 * Docker Engine API 的最小客户端：unix socket 上的 HTTP，**零依赖**。
 *
 * 【为什么不引 dockerode】§0.2 的依赖策略里写明了理由，这里是它的落地：
 * 我们只需要 9 个**非流式 JSON** 调用（`/images/create` 那个进度流是唯一需要读流的地方，
 * 而它只是 ndjson）。dockerode 的价值主要在 attach / events 的流式封装，
 * 而我们**不用 docker attach**——exec 一律走 sandbox-agent 的 HTTP API。
 * 创建参数反正要手写 JSON body，所以自己写反而更直白。
 *
 * 【如果**以后**需要 `docker events` 或 attach，再评估引 dockerode】——这句话留在文件头，
 * 免得日后重复讨论。
 *
 * 【API 版本显式钉住】所有请求都走 `/v1.44<path>`。Docker 的 API 是可协商的，
 * 但它这几年对旧版本一直在放宽（daemon 的 MinAPIVersion 现在是 1.40），
 * 写死一个版本能保证"本地能跑、CI 上也能跑"，而不是取决于 daemon 的心情。
 *
 * 【在链路中的位置】provider 文件夹是**唯一**允许import 这个文件的地方（Phase 5 起是
 * `local-docker.ts`，Phase 6 加上 `egress-proxy.ts`）。它们把这里的 `DockerApiError`
 * 翻译成 `ProviderError`（带结构化原因），所以这一层不需要知道沙箱、spec 或安全策略，
 * 只需要知道"怎么跟 docker daemon 说话"。
 */

import { Buffer } from "node:buffer";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { StringDecoder } from "node:string_decoder";

/** 默认 API 版本。`/v1.44` 对应 Docker Engine 25 起的能力集，daemon 侧最低支持 1.40。 */
export const DEFAULT_API_VERSION = "v1.44";

/** 非流式请求的默认超时。单个调用超过 30s 还没回，说明 socket 或 daemon 有问题。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Docker 返回了一个错误响应（4xx / 5xx）。
 *
 * `status` 是我们判分支的依据（404 = 不存在、409 = 冲突、500 = daemon 自己出错），
 * `dockerMessage` 是 daemon 原文——它经常是唯一有用的诊断信息
 * （"No such image"、"Conflict. The container name ... is already in use"），
 * 所以永远不要把它吞掉。
 */
export class DockerApiError extends Error {
  /** HTTP 状态码；0 表示"压根没连上 daemon"之外的异常（这里恒为真实状态码）。 */
  readonly status: number;
  /** 出错的 API 路径（不含版本前缀），日志里定位用。 */
  readonly path: string;
  /** daemon 返回的 message 原文。 */
  readonly dockerMessage: string;

  constructor(status: number, path: string, dockerMessage: string, options: { cause?: unknown } = {}) {
    super(`docker ${status} ${path}: ${dockerMessage}`, options);
    this.name = "DockerApiError";
    this.status = status;
    this.path = path;
    this.dockerMessage = dockerMessage;
  }
}

/**
 * 连不上 daemon：socket 不存在（宿主没装 Docker）、权限不足、daemon 没启动、连接被重置。
 *
 * 与 `DockerApiError` 分开是因为调用方的处理完全不同：**这个原因下重试没有意义**，
 * 而且它对应 spec 里的 `docker_unavailable`（运维问题），而不是"这个请求做错了"。
 */
export class DockerUnavailableError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "DockerUnavailableError";
    this.socketPath = socketPath;
  }
}

/**
 * `AbortSignal.timeout()` 超时（TimeoutError）与主动 abort（AbortError）都会走到这里。
 * 导出它是因为 provider 需要用同一套判据把这两种情况翻译成结构化的失败原因，
 * 而"什么算超时"这件事只应该有一份定义。
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * 把请求层的错误归一化。**超时必须原样放行**——它不是"连不上 daemon"，
 * 而是"daemon 太慢"：两者的运维动作完全不同（前者看 socket/权限，后者看预算与负载）。
 * 吞掉它的类型会让 provider 只能报一个含糊的 docker_unavailable。
 */
function normalizeRequestError(socketPath: string, error: NodeJS.ErrnoException): Error {
  if (isTimeoutError(error)) return error;
  return toUnavailable(socketPath, error);
}

/** 判断一个错误是不是 404。调用方（provider）用它实现"不存在就当作成功 / 返回 null"。 */
export function isNotFound(error: unknown): boolean {
  return error instanceof DockerApiError && error.status === 404;
}

/** 判断一个错误是不是指定状态码的 Docker 错误。 */
export function isDockerError(error: unknown, status: number): boolean {
  return error instanceof DockerApiError && error.status === status;
}

/**
 * 从环境变量解析 docker socket 的路径。
 *
 * **只支持本机 daemon**（spec Phase 5「技术边界」第一条）：
 *  - 没设 `DOCKER_HOST` → `/var/run/docker.sock`
 *  - `unix:///path/to.sock` → `/path/to.sock`（去掉 scheme）
 *  - `tcp://` / `http://` / `ssh://` / 其他 → **抛错**。远程 daemon 的认证（TLS 证书、
 *    context）没做，而"静默连到另一台机器上"是最糟糕的失败方式：你会在错误的宿主机上
 *    创建沙箱、并且以为自己成功了。所以这里选择启动即失败。
 *
 * @param env 默认 `process.env`；测试传自己的对象，行为不随宿主漂移。
 */
export function resolveDockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.DOCKER_HOST;
  if (host === undefined || host === "") return "/var/run/docker.sock";
  if (host.startsWith("unix://")) {
    const path = host.slice("unix://".length);
    if (path === "") {
      throw new DockerUnavailableError(host, `DOCKER_HOST=${host} 没给出 socket 路径`);
    }
    return path;
  }
  throw new DockerUnavailableError(
    host,
    `DOCKER_HOST=${host} 不是本机 unix socket。LocalDockerProvider 只支持本机 daemon` +
      `（远程/TLS 尚未实现，且静默连到别的机器比直接失败危险得多）。`,
  );
}

/** 一次请求的可选项。 */
export interface DockerRequestOptions {
  /** 查询参数。`undefined` 的项会被跳过（不是变成字符串 "undefined"）。 */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body。传 `undefined` 表示没有 body（GET/DELETE/无参数 POST）。 */
  body?: unknown;
  /** 本次请求的超时；缺省用客户端级的 defaultTimeoutMs。 */
  timeoutMs?: number;
  /**
   * 额外的 HTTP 头。目前只有两个用处：`X-Registry-Auth`（拉私有镜像，MVP 用不到）
   * 与测试里注入的头。默认自动带 `Content-Type: application/json`（有 body 时）。
   */
  headers?: Record<string, string>;
}

export interface DockerClientOptions {
  /** unix socket 路径。用 `resolveDockerSocketPath()` 得到。 */
  socketPath: string;
  /** API 版本，带不带 `v` 都行（内部会归一化）。默认 `v1.44`。 */
  apiVersion?: string;
  /** 单请求默认超时（毫秒）。 */
  defaultTimeoutMs?: number;
}

/** 一次原始响应的结果。`json()` 之外的调用方（比如只看状态码的）用得到。 */
export interface DockerRawResponse {
  status: number;
  body: Buffer;
}

/**
 * Docker 的 ndjson 进度流里的一条消息。`/images/create`（pull）用它推进度：
 * `{"status":"Pulling fs layer"}`、`{"status":"Downloading","progressDetail":{...}}`、
 * 失败时是 `{"errorDetail":{"message":"…"},"error":"…"}`。
 */
export interface DockerProgressMessage {
  status?: string;
  id?: string;
  progress?: string;
  error?: string;
  errorDetail?: { message?: string };
}

/**
 * 走 unix socket 的 Docker API 客户端。**无状态**（不缓存任何东西），
 * 所以可以随便构造、随便丢。
 */
export class DockerClient {
  readonly socketPath: string;
  /** 形如 `v1.44`。 */
  readonly apiVersion: string;
  readonly defaultTimeoutMs: number;

  constructor(options: DockerClientOptions) {
    this.socketPath = options.socketPath;
    // 归一化：调用方写 "1.44" 或 "v1.44" 都行，拼 URL 的那一处不用做判断。
    const raw = options.apiVersion ?? DEFAULT_API_VERSION;
    this.apiVersion = raw.startsWith("v") ? raw : `v${raw}`;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** 完整路径：`/v1.44` + 业务路径。日志与错误里都用它（不含 query）。 */
  apiPath(path: string): string {
    return `/${this.apiVersion}${path}`;
  }

  /**
   * 发一个 JSON 请求并解析响应。
   *
   * 约定：**非 2xx 一律抛**（`DockerApiError`），因为调用方几乎总是希望"出错就是出错"。
   * 需要容忍 404 的地方（容器/卷不存在）用 `isNotFound(error)` 判断，
   * 而不是给每个调用点加一个 boolean 开关——那种开关最后会变成"谁都忘了检查"。
   *
   * 204 与空 body 返回 `undefined as T`：Docker 的 start / stop / volume delete 都是 204。
   */
  async json<T>(method: string, path: string, options: DockerRequestOptions = {}): Promise<T> {
    const response = await this.raw(method, path, options);
    if (response.body.length === 0) return undefined as T;
    try {
      return JSON.parse(response.body.toString("utf8")) as T;
    } catch (error) {
      // Docker 偶尔会在非 JSON 的错误里返回 HTML（代理、daemon 崩溃页）。把它包成
      // DockerApiError 而不是让 SyntaxError 冒到 provider 层——否则错误原因会退化。
      throw new DockerApiError(
        response.status,
        path,
        `响应不是合法 JSON：${response.body.toString("utf8").slice(0, 200)}`,
        { cause: error },
      );
    }
  }

  /**
   * 发一个请求并返回**原始**响应（不解析、不抛非 2xx）。
   * 只有需要自己看状态码的场景用（`json()` 除外），目前主要用于测试。
   */
  raw(method: string, path: string, options: DockerRequestOptions = {}): Promise<DockerRawResponse> {
    const query = serializeQuery(options.query);
    const fullPath = `${this.apiPath(path)}${query === "" ? "" : `?${query}`}`;
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const headers: Record<string, string> = { ...options.headers };
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }

    return new Promise<DockerRawResponse>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: fullPath,
          method,
          headers,
          // AbortSignal.timeout 是 Node 原生能力：到点自动 abort，不需要自己管定时器。
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", (error: Error) => {
            reject(new DockerApiError(response.statusCode ?? 0, path, `读响应失败：${error.message}`, { cause: error }));
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            const text = Buffer.concat(chunks);
            if (status >= 400) {
              reject(new DockerApiError(status, path, extractDockerMessage(text), {}));
              return;
            }
            resolve({ status, body: text });
          });
        },
      );

      request.on("error", (error: NodeJS.ErrnoException) => {
        reject(normalizeRequestError(this.socketPath, error));
      });
      if (body !== null) request.write(body);
      request.end();
    });
  }

  /**
   * 读一个 **ndjson** 进度流（Docker 的 pull / build 用它）。
   *
   * 两个必须处理的细节，都不是可选的：
   *  1. **跨 chunk 的行**：一条 JSON 可能被切成两半（TCP 不管你的行边界）。所以攒 buffer、
   *     按 `\n` 切、最后剩下的残片留到下一轮——这和 SSE 解析是同一类坑。
   *  2. **流里带错误**：pull 失败时 HTTP 状态码仍然是 200，错误在最后一条消息里
   *     （`{"errorDetail":{...}}`）。只看状态码会把"镜像没拉下来"当成成功。
   *
   * @param onMessage 每解析出一条消息调一次。抛异常会中止整个流（并销毁连接）。
   */
  async ndjson(
    method: string,
    path: string,
    options: DockerRequestOptions,
    onMessage: (message: DockerProgressMessage) => void,
  ): Promise<void> {
    const query = serializeQuery(options.query);
    const fullPath = `${this.apiPath(path)}${query === "" ? "" : `?${query}`}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: fullPath,
          method,
          headers: options.headers ?? {},
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0;
          if (status >= 400) {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
              reject(new DockerApiError(status, path, extractDockerMessage(Buffer.concat(chunks)), {}));
            });
            return;
          }

          // decoder 而不是 `chunk.toString()`：后者会把跨 chunk 的多字节字符切坏
          // （镜像 tag / 进度里的中文都会触发）。
          const decoder = new StringDecoder("utf8");
          let pending = "";
          let failed: Error | null = null;

          const handleLine = (line: string): void => {
            const text = line.trim();
            if (text === "" || failed !== null) return;
            let message: DockerProgressMessage;
            try {
              message = JSON.parse(text) as DockerProgressMessage;
            } catch {
              // 进度流里出现无法解析的行：记下来但不中止——真正重要的错误消息是合法 JSON，
              // 而这种行通常是 daemon 在打日志。
              return;
            }
            try {
              onMessage(message);
            } catch (error) {
              failed = error as Error;
              response.destroy();
            }
          };

          response.on("data", (chunk: Buffer) => {
            pending += decoder.write(chunk);
            const lines = pending.split("\n");
            // 最后一段可能不完整，留在 pending 里等下一个 chunk。
            pending = lines.pop() ?? "";
            for (const line of lines) handleLine(line);
          });
          response.on("error", (error: Error) => {
            reject(new DockerApiError(status, path, `读进度流失败：${error.message}`, { cause: error }));
          });
          response.on("end", () => {
            // 最后一行可能没有换行符结尾。
            pending += decoder.end();
            handleLine(pending);
            if (failed !== null) reject(failed);
            else resolve();
          });
        },
      );

      request.on("error", (error: NodeJS.ErrnoException) => {
        reject(normalizeRequestError(this.socketPath, error));
      });
      request.end();
    });
  }

  /**
   * `/version`（真名是 `/_ping`，带 `?` 才回版本 JSON）。**唯一用途是连通性探针**：
   * 启动时想知道"daemon 在不在"、测试里想跳过"没装 Docker"。
   */
  async ping(): Promise<{ apiVersion: string; version: string }> {
    const raw = await this.raw("GET", "/_ping", { headers: { accept: "application/json" } });
    const text = raw.body.toString("utf8").trim();
    // `/_ping` 不带参数时只回 "OK"（纯文本）。这时版本未知，但仍然证明 daemon 在。
    if (text === "OK") return { apiVersion: "", version: "" };
    try {
      const parsed = JSON.parse(text) as { ApiVersion?: string; Version?: string };
      return { apiVersion: parsed.ApiVersion ?? "", version: parsed.Version ?? "" };
    } catch {
      return { apiVersion: "", version: "" };
    }
  }
}

/** 把 Docker 的错误响应体变成一句人话（优先用 daemon 的 message 字段）。 */
function extractDockerMessage(body: Buffer): string {
  const text = body.toString("utf8").trim();
  if (text === "") return "（空响应体）";
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    /* 不是 JSON：直接用原文 */
  }
  return text.slice(0, 300);
}

/** 把 Node 的连接层错误归一成 DockerUnavailableError（并保留原始 cause）。 */
function toUnavailable(socketPath: string, error: NodeJS.ErrnoException): DockerUnavailableError {
  const code = error.code ?? "";
  const hint =
    code === "ENOENT"
      ? "socket 不存在——Docker 没装或者没启动"
      : code === "EACCES"
        ? "没有权限访问 socket——把当前用户加进 docker 组"
        : code === "ECONNREFUSED"
          ? "daemon 拒绝连接——它可能正在重启"
          : "连接失败";
  return new DockerUnavailableError(socketPath, `连不上 docker daemon（${socketPath}）：${hint}（${code || error.message}）`, {
    cause: error,
  });
}

/** 把 query 对象序列化成查询串：跳过 undefined，其余做 URL 编码。 */
export function serializeQuery(query: DockerRequestOptions["query"]): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

// ---------------------------------------------------------------- Docker 的响应结构（只用到的字段）

/**
 * `GET /containers/{id}/json` 里我们真正读的字段。
 *
 * **故意写得很窄**：Docker 的 inspect 有几百个字段，把它们全抄一遍既是维护负担，
 * 也会诱使上层去读 `HostConfig` 做安全判断——那是 provider 的职责。
 * 结构类型（而不是 `any`）的意义是：改错字段名时 `tsc` 会告诉你。
 * 注意每个字段都是可选的：Docker 在容器还没起来时确实会省略它们。
 */
export interface DockerContainerInspect {
  Id: string;
  Name: string;
  /** 容器使用的镜像 **digest**（`sha256:…`）。用来判断"这个容器还是不是我期望的那个镜像"。 */
  Image?: string;
  Config?: {
    Image?: string;
    User?: string;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
  } | null;
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
  } | null;
  HostConfig?: {
    NetworkMode?: string;
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    PidsLimit?: number;
    ReadonlyRootfs?: boolean;
    CapDrop?: string[] | null;
    CapAdd?: string[] | null;
    SecurityOpt?: string[] | null;
    Privileged?: boolean;
    Init?: boolean;
    AutoRemove?: boolean;
    Binds?: string[] | null;
    Tmpfs?: Record<string, string> | null;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null;
    LogConfig?: { Type?: string; Config?: Record<string, string> | null } | null;
  } | null;
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string; Gateway?: string } | null> | null;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  } | null;
}

/** `GET /containers/json` 的一行（listManaged 用）。 */
export interface DockerContainerSummary {
  Id: string;
  Names?: string[] | null;
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: Record<string, string> | null;
}

/** `POST /volumes/create` 的响应（只用得到 Name）。 */
export interface DockerVolumeInfo {
  Name: string;
  Driver?: string;
  Labels?: Record<string, string> | null;
  CreatedAt?: string;
}

/** `POST /containers/create` 的响应。 */
export interface DockerCreateResponse {
  Id: string;
  Warnings?: string[] | null;
}

/**
 * 创建容器时的 `HostConfig`。**只要这里写全了，加固参数就不会漏**——
 * 所有字段都是必填的（除了发布端口），新增一个容器类型时编译器会逼着你想清楚每一项。
 * 这些字段的值由 `local-docker.ts` 的 `buildHostConfig()` 填充，那里逐条对应 §F.1。
 */
export interface DockerHostConfig {
  ReadonlyRootfs: boolean;
  CapDrop: string[];
  SecurityOpt: string[];
  Privileged: boolean;
  Memory: number;
  MemorySwap: number;
  NanoCpus: number;
  PidsLimit: number;
  Init: boolean;
  /** 可写点必须逐个列出（只读根之外）。键是容器内路径，值是选项串。 */
  Tmpfs: Record<string, string>;
  /** 只允许命名卷（`name:/path`），没有 bind mount 的输入端。 */
  Binds: string[];
  NetworkMode: string;
  /** 只有需要发布端口时才有（darwin 的转发容器）。HostIp 恒为 127.0.0.1。 */
  PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  RestartPolicy: { Name: string; MaximumRetryCount?: number };
  AutoRemove: boolean;
  LogConfig: { Type: string; Config: Record<string, string> };
}

/**
 * `POST /containers/create` 的请求体。也是**故意写窄**的：
 * 里面没有 `Privileged: true` 的开关（字段定死为 false）、没有 `Mounts`（只有 Binds）、
 * 没有 `NetworkMode: host` 的可能（值来自 provider 的配置）。
 */
export interface DockerCreateContainerRequest {
  Image: string;
  User?: string;
  WorkingDir?: string;
  Env?: string[];
  Labels?: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  Cmd?: string[];
  Entrypoint?: string[];
  HostConfig: DockerHostConfig;
  /** 多网络容器（darwin 的转发容器、Phase 6 的 egress-proxy）。
   * 主网络仍由 `HostConfig.NetworkMode` 决定；这里列出的是"之外的"那张网。
   * `Aliases` 是内网 DNS 里的名字（代理必须能被沙箱用 `reuben-cloud-proxy` 找到）。 */
  NetworkingConfig?: { EndpointsConfig: Record<string, { Aliases?: string[] }> };
}

/** `GET /networks/{name}` 里我们读的字段（校验已有网络真的是 internal）。 */
export interface DockerNetworkInfo {
  Name: string;
  Id: string;
  Driver?: string;
  Internal?: boolean;
  Labels?: Record<string, string> | null;
}

/**
 * `GET /images/{ref}/json` 里我们读的字段。
 *
 * 用途只有一个：把本机构建的镜像引用解析成 **digest 引用**（`repo@sha256:…`）。
 * egress-proxy 没有 registry 可拉，所以这个解析必须在本地完成。
 *  - `RepoDigests`：push/拉过、或者 containerd 存储记过的镜像有；本地构建的通常为空。
 *  - `Id`：镜像 config 的 sha256。把它当 digest 用能解析到本地镜像（Phase 5 实测如此）。
 */
export interface DockerImageInspect {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
}
