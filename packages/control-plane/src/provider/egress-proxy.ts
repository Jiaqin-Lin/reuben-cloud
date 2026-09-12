/**
 * egress-proxy 的容器生命周期：**全局常驻一个**代理容器，而不是每沙箱一个（§F.2）。
 *
 * 【为什么这一段代码需要一个落点】spec 的 Phase 6 只写了一个任务："沙箱出不去公网，
 * 除了白名单上的包管理器域名"，交付物是 `deploy/egress-proxy/*`（代理本身）。
 * 但代理**得有人起**：它要挂在共用内网上、要把白名单文件挂进去、要按 §F.1 那套加固参数跑，
 * 还要能被 Phase 7 的冒烟脚本和 Phase 8 的对账找到。这些都不是容器里的代码能自己完成的，
 * 所以把它放在 provider 旁边——它是 CP 侧的一段基础设施代码，和 `local-docker.ts` 一起
 * 构成"CP 里唯一允许碰 docker socket 的地方"。
 *
 * 【它不是 SandboxProvider】代理没有 sandboxId、没有卷、没有 agent，硬塞进那 5 个方法
 * 只会让 SandboxProvider 的语义变得含糊（`create()` 返回的 handle 里那些字段一个都不适用）。
 * 所以它是一个**独立的小类型**，只有四个动作：`ensureRunning` / `inspect` / `reload` / `stop`。
 *
 * 【网络怎么接：bridge 与内网都要在 EndpointsConfig 里列出来，缺一不可】
 * 代理需要出口路由（上游连接是它从默认路由发出去的），沙箱又必须能按服务名找到它。
 * 看着像是「NetworkMode: bridge + EndpointsConfig[internal]」就够了，**其实不够**：
 * `NetworkMode: "bridge"` 是默认值，Docker 视同"没指定"，于是 EndpointsConfig 成为完整集合——
 * 容器只会挂上内网，默认路由和内网 DNS 转发全没有（实测：`EAI_AGAIN` + `ENETUNREACH`，
 * 也就是说所有放行的域名都会 502）。把主网络也显式列进 EndpointsConfig，两张网才真挂上，
 * 默认路由才会走 bridge。这与 Phase 5 的转发容器同一个形状（它也把自己的主网络列了一遍）。
 *
 * 【白名单为什么用 bind mount】SIGHUP 重载要求"宿主改了文件，容器里能看到"。
 * 只读根下 `docker cp` 写不进去，命名卷又要多一个搬运步骤；一个**只读单文件** bind mount
 * 正好表达这个语义。这是整个项目里唯一一处 bind mount——沙箱容器那边永远是命名卷。
 *
 * 【端口一个都不发布】代理只在共用内网上可见。发布到宿主机等于给"绕过白名单"开了一条路
 * （§F.2 已知边界第一条：宿主上不该暴露代理类服务）。所以 `buildProxyContainerRequest`
 * 只写 `ExposedPorts`，**没有任何 PortBindings**；测试会断言这一点。
 */

import { existsSync, statSync } from "node:fs";
import { DockerClient, isNotFound, resolveDockerSocketPath } from "./docker-api.ts";
import type {
  DockerContainerInspect,
  DockerCreateContainerRequest,
  DockerCreateResponse,
  DockerImageInspect,
} from "./docker-api.ts";
import { asProviderError, buildHostConfig, ensureInternalNetwork } from "./local-docker.ts";
import {
  INTERNAL_NETWORK,
  LABEL_MANAGED,
  LABEL_ROLE,
  PROXY_CONTAINER_NAME,
  PROXY_PORT,
  ProviderError,
} from "./types.ts";

/** 代理镜像的本地 tag（`npm run build:proxy-image` 的产物）。它没有 registry 可拉。 */
export const DEFAULT_PROXY_IMAGE = "reuben-cloud/egress-proxy:dev";

/** 主网络：默认 bridge，有出口路由。内网是**附加**上去的那张（见文件头）。 */
export const EXTERNAL_NETWORK = "bridge";

/**
 * 代理容器的资源上限。它只搬字节、不跑用户代码，所以给得比沙箱小得多：
 * 连接是流式的，内存占用与并发数成正比而不是与传输量成正比。
 */
const PROXY_MEM_MB = 256;
const PROXY_NANO_CPUS = 500_000_000; // 0.5 核
const PROXY_PIDS = 256;
const PROXY_TMPFS_MB = 16;

/**
 * 日志轮转：100m × 5（spec Phase 6 §4）。比沙箱的 10m × 3 大，
 * 因为**全部沙箱的出网域名都记在这一份日志里**，它是唯一的出网审计来源（附录 A-11）。
 */
const PROXY_LOG_CONFIG = { Type: "json-file", Config: { "max-size": "100m", "max-file": "5" } };

/** 白名单在容器里的挂载点（与镜像里烤进去的缺省路径一致）。 */
export const PROXY_ALLOWLIST_PATH = "/app/allowlist.txt";

/**
 * `POST /containers/{id}/start` 的超时。它**故意比别的调用宽松**：
 * start 要等 Docker 建网、挂载、拉起 init，在冷启动的 Docker Desktop 上实测见过 64 秒
 * （同一台机器热了之后是 0.2 秒）。把它算进通用的 30s 里，会让 `npm run proxy:up`
 * 在偶尔的一次冷启动上凭空失败——那种失败比"重启一次"更难解释。
 */
const START_TIMEOUT_MS = 120_000;

/** 看到 Running 之后隔多久再确认一次（见 `#waitUntilRunning` 里的说明）。 */
const RUNNING_STABLE_MS = 500;

/** 日志出口。`info` 是正常事件，`warn` 是"做完了但有件事要你知道"。 */
export type EgressProxyLog = (level: "info" | "warn", message: string, details?: Record<string, unknown>) => void;

export interface EgressProxyOptions {
  /** **宿主上**的白名单文件路径。它会被只读挂进容器。 */
  allowlistPath: string;
  /** 镜像引用。默认 `reuben-cloud/egress-proxy:dev`；解析成 digest 引用之后再建容器。 */
  image?: string;
  /** 共用内网名。默认 `reuben-cloud-internal`。 */
  networkName?: string;
  /** 容器名。默认 `reuben-cloud-proxy`（= 内网别名）。测试用独立名字避免踩到真的代理。 */
  containerName?: string;
  /** docker socket 路径。默认走 `resolveDockerSocketPath()`。 */
  socketPath?: string;
  /** 单次 Docker API 超时。 */
  requestTimeoutMs?: number;
  /** 启动后等容器进入 running 的预算。 */
  startupTimeoutMs?: number;
  /** 日志出口。默认只打 warn（与 LocalDockerProvider 一致）；CLI 会传一个打印 info 的。 */
  log?: EgressProxyLog;
}

/** 代理容器的一次快照。`inspect()`/`ensureRunning()` 的返回形状。 */
export interface EgressProxyStatus {
  containerName: string;
  providerRef: string;
  running: boolean;
  /** Docker 的状态字符串：created / running / exited / dead / … */
  state: string;
  /** 容器实际使用的镜像（digest 引用）。 */
  image: string;
  /** 退出码；还在跑时为 null。 */
  exitCode: number | null;
  /** 内网 IP。容器不在内网上时为 null（对账据此发现"代理掉线了"）。 */
  internalAddress: string | null;
  /** 宿主上的白名单文件（只读挂进容器的那份）。 */
  allowlistPath: string;
}

/**
 * 代理容器的创建请求体。**纯函数**，所以"加固参数 + 双网络 + 只读挂载 + 不发布端口"
 * 可以在单测里断言，不用起容器（集成测试再断言真实 inspect 的结果，两边都做）。
 */
export function buildProxyContainerRequest(input: {
  image: string;
  networkName: string;
  allowlistPath: string;
}): DockerCreateContainerRequest {
  return {
    Image: input.image,
    User: "1000:1000",
    WorkingDir: "/app",
    Env: [
      `EGRESS_PROXY_PORT=${PROXY_PORT}`,
      `EGRESS_PROXY_ALLOWLIST=${PROXY_ALLOWLIST_PATH}`,
      // 监听 0.0.0.0：容器里必须这样，否则内网里的沙箱连不上它。
      "EGRESS_PROXY_HOST=0.0.0.0",
    ],
    Labels: {
      [LABEL_MANAGED]: "true",
      [LABEL_ROLE]: "egress-proxy",
    },
    // 只声明，不发布。PortBindings 一个都不出现——见文件头。
    ExposedPorts: { [`${PROXY_PORT}/tcp`]: {} },
    HostConfig: buildHostConfig({
      // 主网络是 bridge：出口路由在这里。内网靠 NetworkingConfig 附加。
      networkName: EXTERNAL_NETWORK,
      memoryMb: PROXY_MEM_MB,
      nanoCpus: PROXY_NANO_CPUS,
      pids: PROXY_PIDS,
      // 全项目唯一的 bind mount：只读、单文件。见文件头。
      binds: [`${input.allowlistPath}:${PROXY_ALLOWLIST_PATH}:ro`],
      tmpfsMb: PROXY_TMPFS_MB,
      tmpfsOptions: `rw,noexec,nosuid,size=${PROXY_TMPFS_MB}m,mode=1777`,
      logConfig: PROXY_LOG_CONFIG,
    }),
    NetworkingConfig: {
      EndpointsConfig: {
        // **主网络也必须在这里再列一次**：NetworkMode 里的 "bridge" 是默认值，
        // Docker 视同"没指定"，只列内网的话容器就真的只有内网（没有默认路由、没有 DNS 转发）。
        [EXTERNAL_NETWORK]: {},
        // 别名 = 容器名：沙箱的 HTTP_PROXY 写的是 `http://reuben-cloud-proxy:3128`。
        [input.networkName]: { Aliases: [PROXY_CONTAINER_NAME] },
      },
    },
  };
}

/**
 * 把本地镜像引用解析成 **digest 引用**。
 *
 * egress-proxy 是本机构建的镜像（`npm run build:proxy-image`），**没有 registry 可拉**，
 * 所以不能走 `LocalDockerProvider.#ensureImage` 那条"先查本地再拉"的路（拉会 403）。
 * 这里只查本地：`RepoDigests` 里有就优先用它，没有就用镜像 config 的 `Id`——
 * 两者都能被 Docker 按 digest 解析到本地镜像（Phase 5 实测过同一件事）。
 *
 * @throws ProviderError("image_not_found") 本地没有这个镜像，且没有 registry 能兜底。
 */
export async function resolveLocalImageReference(docker: DockerClient, image: string): Promise<string> {
  let info: DockerImageInspect;
  try {
    info = await docker.json<DockerImageInspect>("GET", `/images/${encodeURIComponent(image)}/json`);
  } catch (error) {
    if (isNotFound(error)) {
      throw new ProviderError(
        "image_not_found",
        `本地没有镜像 ${image}（egress-proxy 是本机构建的，没有 registry 可拉）。先跑 \`npm run build:proxy-image\`。`,
        { image },
      );
    }
    throw asProviderError(error, "proxy_image_inspect");
  }
  const repo = image.split("@")[0]!.split(":")[0]!;
  const preferred =
    (info.RepoDigests ?? []).find((item) => item.startsWith(`${repo}@`)) ?? (info.RepoDigests ?? [])[0];
  if (preferred !== undefined && preferred !== "") return preferred;
  if (/^sha256:[0-9a-f]{64}$/.test(info.Id)) return info.Id;
  throw new ProviderError("image_not_found", `镜像 ${image} 既没有 RepoDigests 也没有可用的 Id`, { image });
}

/**
 * 代理容器的管理器。**幂等**：`ensureRunning()` 可以反复调（每次 CP 启动、每次冒烟、
 * 每次对账），已经在跑且配置一致的容器会被原样复用，不会被重启。
 */
export class EgressProxy {
  readonly #options: {
    allowlistPath: string;
    image: string;
    networkName: string;
    containerName: string;
    requestTimeoutMs: number;
    startupTimeoutMs: number;
    log: EgressProxyLog;
  };

  /** Docker API 客户端。测试里可以换成指向假 socket 的实例。 */
  readonly docker: DockerClient;

  constructor(options: EgressProxyOptions) {
    if (options.allowlistPath === undefined || options.allowlistPath === "") {
      throw new ProviderError("invalid_spec", "EgressProxy 必须给出白名单文件路径（宿主路径）");
    }
    let socketPath = options.socketPath;
    if (socketPath === undefined) {
      try {
        socketPath = resolveDockerSocketPath();
      } catch (error) {
        throw new ProviderError(
          "unsupported_docker_host",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    this.#options = {
      allowlistPath: options.allowlistPath,
      image: options.image ?? DEFAULT_PROXY_IMAGE,
      networkName: options.networkName ?? INTERNAL_NETWORK,
      containerName: options.containerName ?? PROXY_CONTAINER_NAME,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
      log: options.log ?? defaultLog,
    };
    this.docker = new DockerClient({
      socketPath,
      defaultTimeoutMs: this.#options.requestTimeoutMs,
    });
  }

  /**
   * 保证"一个配置正确的代理容器正在跑"。顺序：
   *  校验白名单文件（存在且是普通文件）→ 解析本地镜像 digest → 建/校验内网
   *  → 查同名容器 →（不存在 / 配置不一致）重建 →（没在跑）启动 → 等 running。
   *
   * 失败路径**不做 rollback**：这里是全局基础设施，出现半成品容器时下一次
   * `ensureRunning()` 正好会把它当成"配置不一致"重建掉；删一个可能正在被别的沙箱用的
   * 代理比留着一个退出码非 0 的容器危险得多。
   */
  async ensureRunning(): Promise<EgressProxyStatus> {
    const allowlistPath = this.#assertAllowlistFile();
    const image = await resolveLocalImageReference(this.docker, this.#options.image);
    await ensureInternalNetwork(this.docker, this.#options.networkName, {
      timeoutMs: this.#options.requestTimeoutMs,
    });

    const name = this.#options.containerName;
    let inspect = await this.#inspectByName(name);
    if (inspect !== null && !isOurProxy(inspect)) {
      // 名字被别人占了：绝不删别人的容器（和 provider 的 container_exists 同一条规矩）。
      throw new ProviderError("container_exists", `容器名 ${name} 已被一个不属于 reuben-cloud 的容器占用`, {
        name,
      });
    }

    const desiredBind = `${allowlistPath}:${PROXY_ALLOWLIST_PATH}:ro`;
    if (inspect !== null && !matchesDesired(inspect, image, desiredBind, this.#options.networkName)) {
      this.#log("warn", `代理容器 ${name} 与期望的镜像/白名单/网络不一致，重建`, { image });
      await this.#removeContainer(inspect.Id);
      inspect = null;
    }

    if (inspect === null) {
      const created = await this.#createContainer(name, image, allowlistPath);
      await this.#startContainer(created);
      inspect = await this.#waitUntilRunning(created);
      this.#log("info", `代理容器 ${name} 已创建并启动`, { image, allowlist: allowlistPath });
    } else if (inspect.State?.Running !== true) {
      await this.#startContainer(inspect.Id);
      inspect = await this.#waitUntilRunning(inspect.Id);
      this.#log("info", `代理容器 ${name} 已重新启动`);
    }

    return this.#statusOf(inspect);
  }

  /** 查当前状态；容器不存在或不是我们的 → null（对账用 null 表示"代理丢了"）。 */
  async inspect(): Promise<EgressProxyStatus | null> {
    const inspect = await this.#inspectByName(this.#options.containerName);
    if (inspect === null || !isOurProxy(inspect)) return null;
    return this.#statusOf(inspect);
  }

  /**
   * 让代理重读白名单（`docker kill -s HUP`）。生产上换清单不重启，
   * 也不会掐断任何在途连接（代理的 SIGHUP 只换内存里那份规则，见 proxy.ts）。
   *
   * 【一个已知的传播延迟】白名单是**宿主文件的只读 bind mount**，容器看到新内容可能比宿主
   * 写入晚几十毫秒（Docker Desktop 的 gRPC-FUSE 实测如此；Linux 上是实时的）。所以调用方的
   * 顺序应该是「写完文件 →（必要时确认容器已看到）→ reload()」：reload 只负责让进程重读
   * **它现在能看到的那份**，它无法知道宿主那边刚刚写了什么。
   */
  async reload(): Promise<void> {
    const inspect = await this.#inspectByName(this.#options.containerName);
    if (inspect === null || !isOurProxy(inspect)) {
      throw new ProviderError("not_found", `代理容器 ${this.#options.containerName} 不存在`, {
        name: this.#options.containerName,
      });
    }
    try {
      await this.docker.json("POST", `/containers/${inspect.Id}/kill`, {
        query: { signal: "SIGHUP" },
      });
    } catch (error) {
      if (isNotFound(error)) {
        throw new ProviderError("not_found", `代理容器在 reload 之前消失了`, {
          name: this.#options.containerName,
        });
      }
      // 409 = 容器没在跑。这正是"要重载但代理已经死了"的形状，结构化地报出去。
      throw asProviderError(error, "proxy_reload");
    }
    this.#log("info", `代理 ${this.#options.containerName} 已重载白名单`);
  }

  /**
   * 停掉代理容器。**幂等**：不存在、或者名字不是我们的，都直接返回。
   * 只删容器不删内网——网络是所有沙箱共用的资源。
   */
  async stop(): Promise<void> {
    const inspect = await this.#inspectByName(this.#options.containerName);
    if (inspect === null || !isOurProxy(inspect)) return;
    await this.#removeContainer(inspect.Id);
    this.#log("info", `代理容器 ${this.#options.containerName} 已删除`);
  }

  // -------------------------------------------------------------- 内部步骤

  /**
   * 白名单文件必须存在且是普通文件。**不能只检查"路径非空"**：
   * Docker 的 bind mount 在宿主机路径不存在时会**创建一个同名目录**，
   * 于是容器里那个路径变成目录 → 代理启动失败 → 报错变成一句难懂的 EISDIR。
   * 在碰 Docker 之前拦住它，错误信息才能说人话。
   */
  #assertAllowlistFile(): string {
    const path = this.#options.allowlistPath;
    if (!existsSync(path)) {
      throw new ProviderError("invalid_spec", `白名单文件不存在：${path}`, { allowlistPath: path });
    }
    if (!statSync(path).isFile()) {
      throw new ProviderError("invalid_spec", `白名单路径不是普通文件：${path}`, { allowlistPath: path });
    }
    return path;
  }

  async #createContainer(name: string, image: string, allowlistPath: string): Promise<string> {
    const body = buildProxyContainerRequest({
      image,
      networkName: this.#options.networkName,
      allowlistPath,
    });
    try {
      const response = await this.docker.json<DockerCreateResponse>("POST", "/containers/create", {
        query: { name },
        body,
        timeoutMs: this.#options.requestTimeoutMs,
      });
      return response.Id;
    } catch (error) {
      throw asProviderError(error, "proxy_container_create");
    }
  }

  async #startContainer(containerId: string): Promise<void> {
    try {
      await this.docker.json("POST", `/containers/${containerId}/start`, {
        timeoutMs: Math.max(this.#options.requestTimeoutMs, START_TIMEOUT_MS),
      });
    } catch (error) {
      // 304 = 已经在跑，幂等。
      const status = (error as { status?: unknown }).status;
      if (status === 304) return;
      throw asProviderError(error, "proxy_container_start");
    }
  }

  /**
   * 等容器进入 running。**不是 Probe /healthz**：macOS 上宿主路由不到容器的内网 IP
   * （Phase 5 文件头那段），所以探活只能在 Linux 上做；而"进程有没有活着"在两个平台上
   * 都能从 inspect 读出来。代理在启动时校验白名单，配置错就会立刻退出——这里能看见。
   */
  async #waitUntilRunning(containerId: string): Promise<DockerContainerInspect> {
    const deadline = Date.now() + this.#options.startupTimeoutMs;
    for (;;) {
      const inspect = await this.#inspectById(containerId);
      const state = inspect.State?.Status ?? "unknown";
      if (inspect.State?.Running === true) {
        // 「看到 Running」还不够：一个配置错的代理会在几十毫秒内自己退出（比如裸 `*`），
        // 而我们很可能就在那之前读到一次 Running=true。隔一拍再看一次，
        // 用一点延迟换掉“坏配置当成启动成功”这种最难查的假阳性。
        await sleep(RUNNING_STABLE_MS);
        const confirm = await this.#inspectById(containerId);
        if (confirm.State?.Running === true) return confirm;
        const exitCode = confirm.State?.ExitCode ?? null;
        throw new ProviderError(
          "container_start_failed",
          `代理容器启动后立刻退出（exit ${String(exitCode)}）。` +
            `最常见的原因是白名单里有裸 \`*\` 或者文件不可读——用 \`docker logs ${this.#options.containerName}\` 看原文`,
          { containerId, state: confirm.State?.Status ?? "unknown", exitCode },
        );
      }
      if (state === "exited" || state === "dead") {
        const exitCode = inspect.State?.ExitCode ?? null;
        throw new ProviderError(
          "container_start_failed",
          `代理容器启动后立刻退出（exit ${String(exitCode)}）。` +
            `最常见的原因是白名单里有裸 \`*\` 或者文件不可读——用 \`docker logs ${this.#options.containerName}\` 看原文`,
          { containerId, state, exitCode },
        );
      }
      if (Date.now() >= deadline) {
        throw new ProviderError("container_start_failed", `代理容器在 ${this.#options.startupTimeoutMs}ms 内没有进入 running`, {
          containerId,
          state,
        });
      }
      await sleep(50);
    }
  }

  /** GET /containers/{name}/json；404 → null。 */
  async #inspectByName(name: string): Promise<DockerContainerInspect | null> {
    try {
      return await this.docker.json<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(name)}/json`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw asProviderError(error, "proxy_container_inspect");
    }
  }

  async #inspectById(containerId: string): Promise<DockerContainerInspect> {
    try {
      return await this.docker.json<DockerContainerInspect>("GET", `/containers/${containerId}/json`);
    } catch (error) {
      throw asProviderError(error, "proxy_container_inspect");
    }
  }

  /** DELETE force=1。404 当成功（幂等）。 */
  async #removeContainer(containerId: string): Promise<void> {
    try {
      await this.docker.json("DELETE", `/containers/${containerId}`, { query: { force: 1 } });
    } catch (error) {
      if (isNotFound(error)) return;
      throw asProviderError(error, "proxy_container_remove");
    }
  }

  #statusOf(inspect: DockerContainerInspect): EgressProxyStatus {
    return {
      containerName: this.#options.containerName,
      providerRef: inspect.Id,
      running: inspect.State?.Running === true,
      state: inspect.State?.Status ?? "unknown",
      image: inspect.Config?.Image ?? "",
      exitCode: inspect.State?.ExitCode ?? null,
      internalAddress: inspect.NetworkSettings?.Networks?.[this.#options.networkName]?.IPAddress ?? null,
      allowlistPath: this.#options.allowlistPath,
    };
  }

  #log(level: "info" | "warn", message: string, details?: Record<string, unknown>): void {
    this.#options.log(level, message, details);
  }
}

// ---------------------------------------------------------------- 零件

/** 容器是不是我们建的代理：`managed=true` + `role=egress-proxy`。两个条件都要满足。 */
function isOurProxy(inspect: DockerContainerInspect): boolean {
  const labels = inspect.Config?.Labels ?? {};
  return labels[LABEL_MANAGED] === "true" && labels[LABEL_ROLE] === "egress-proxy";
}

/**
 * 已经存在的容器是不是"可以直接复用"。四项都要对得上：
 * 镜像 digest、白名单挂载、主网络、内网上有 IP。任何一项不同就重建——
 * 代理是安全边界，不将就一个"大概对"的容器。
 */
function matchesDesired(
  inspect: DockerContainerInspect,
  imageRef: string,
  desiredBind: string,
  networkName: string,
): boolean {
  if ((inspect.Image ?? "") !== digestOf(imageRef)) return false;
  if (!(inspect.HostConfig?.Binds ?? []).includes(desiredBind)) return false;
  if ((inspect.HostConfig?.NetworkMode ?? "") !== EXTERNAL_NETWORK) return false;
  // 两张网都必须真的挂着：只挂内网时容器看起来在跑，实际所有放行的域名都会 502
  // （见文件头那段）。这种"看起来健康、其实全坏"的状态最需要一条显式检查。
  const networks = inspect.NetworkSettings?.Networks ?? {};
  if (networks[networkName] === undefined) return false;
  if (networks[EXTERNAL_NETWORK] === undefined) return false;
  return true;
}

/** 从 `repo@sha256:…` / `sha256:…` 里取出 digest 部分，用于和 inspect 的 `Image` 比对。 */
function digestOf(imageRef: string): string {
  const at = imageRef.indexOf("@");
  if (at >= 0) return imageRef.slice(at + 1);
  return imageRef;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 默认日志：warn 打到 stderr，info 丢弃（与 LocalDockerProvider 一致）。 */
function defaultLog(level: "info" | "warn", message: string, details?: Record<string, unknown>): void {
  if (level !== "warn") return;
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.warn(`[egress-proxy] ${message}${suffix}`);
}
