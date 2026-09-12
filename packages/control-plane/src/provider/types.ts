/**
 * Provider 层的契约：CP 眼中的「一个沙箱」长什么样。
 *
 * 【这一层的意义】CP 里只有一个模块会碰 docker socket，就是 provider 那一份实现。
 * 接口存在的意义是把这个事实圈在一个文件夹里，不是为了可插拔（§C.1 说得很直白：
 * 一个实现也是接口）。所以这里**只有 5 个方法**，没有注册表、没有配置化、没有插件发现。
 *
 * 【为什么类型不共享给沙箱】两层之间只有 HTTP 契约（§0.4）。沙箱那边的
 * `ExecRequest` 在 `sandbox-agent/src/types.ts`，这边一个字都不 import——
 * 沙箱加一个字段时，CP 不应该被迫重新编译。两份类型描述的是同一份 HTTP 契约，
 * 这是**有意的重复**。
 *
 * 【在链路中的位置】`local-docker.ts` 实现这些类型；Phase 8 的 SandboxManager
 * 消费它们（create → 落 DB、destroy → 标 DESTROYED、inspect/listManaged → 对账）。
 * 所以这里的字段从第一天就要能支撑对账，不能等到 Phase 8 现加。
 */

/**
 * 沙箱资源的配额。**注意它和加固参数不是一回事**：
 * 这个结构里的数字是"给多少资源"，加固（cap-drop / 只读根 / 非 root / 内网）是
 * provider 硬编码的、spec 里根本没有开关能关掉（§F.1）。
 *
 * `diskMb` 与 `ttlSec` 在 Docker 这一层**没有强制手段**，必须诚实说明：
 *  - `diskMb`：ext4 + overlay2 下 Docker 不支持容器磁盘硬配额（§F.1）。MVP 用
 *    「卷 + 归档体积上限 + 输出字节上限」做软限制，这里只是把 CP 的策略值传下来。
 *  - `ttlSec`：TTL 是 CP 的 sweeper 执行的（Phase 8），不是 provider 的定时器。
 * 两个字段留着是因为它们属于 spec 的一部分：将来换 provider（K8s 的 ephemeral
 * storage / gVisor）时，这两个数字会被真正用上。
 */
export interface SandboxLimits {
  /** CPU 核数，可以是小数（0.5 = 半核）。 */
  cpu: number;
  /** 内存上限（MiB）。MemorySwap 会被设成同一个值——两者不等等于 swap 可无限用。 */
  memMb: number;
  /** 进程数上限，挡 fork bomb。 */
  pids: number;
  /** 工作区体积期望值（MiB）。Docker 层不强制，见上面的说明。 */
  diskMb: number;
  /** 沙箱存活时间上限（秒）。Docker 层不强制，由 CP 的 sweeper 执行。 */
  ttlSec: number;
}

/** 创建沙箱的输入。字段少是刻意的：每多一个字段就多一条"上层能改动安全参数"的路。 */
export interface SandboxSpec {
  /**
   * 镜像引用，**必须带 digest**（形如 `repo@sha256:…`）。
   * 纯 tag 会被直接拒：tag 是可变的，而"今天验证过的镜像"和"明天同名跑的镜像"
   * 必须能证明是同一个（§C.1）。这条校验在 validateSpec 里，碰 Docker 之前就拒。
   */
  image: string;
  limits: SandboxLimits;
  /**
   * 非敏感配置。**禁止放 secret**（§F.3：沙箱内零凭据）。
   * provider 会拒绝覆盖 `SANDBOX_AGENT_TOKEN`——那个由 provider 每次 create 现生成。
   */
  env?: Record<string, string>;
  /** Docker 标签。对账的唯一依据（§D「CP 重启后的对账」），所以 sandboxId / runId 必填。 */
  labels: {
    sandboxId: string;
    runId: string;
    /** 任务 id（M3 的 tasks 表才有实体）。可选，但给了就写进标签，方便按任务查容器。 */
    taskId?: string;
  };
  /** 卷的体积期望值（MiB）。同上：软限制，仅记录。 */
  workspace: { sizeMb: number };
}

/** create() 的返回值。调用方拿它去调 sandbox-agent 的 HTTP API。 */
export interface SandboxHandle {
  sandboxId: string;
  /** Docker 容器 id（`docker inspect` 的那个 Id）。K8s 时代这里是 pod 名。 */
  providerRef: string;
  /**
   * agent 的基地址，**只有这一种形式**：`http://<ip>:8080` 或 `http://127.0.0.1:<port>`。
   * Linux 走容器 IP（不发布端口），macOS 走宿主回环上的随机端口——差异收敛在
   * resolveEndpoint 里，上层不需要知道自己在哪个平台上。
   */
  endpoint: string;
  /** 每个沙箱一个的鉴权 token，通过 env 注入容器，只在 CP 与容器之间使用。 */
  authToken: string;
  /** 容器名与卷名也返回：测试与排查时要按名字看（`docker logs` / `docker volume ls`）。 */
  containerName: string;
  volumeName: string;
  /** 创建完成的时刻（ISO 字符串）。 */
  createdAt: string;
}

/**
 * 沙箱 agent 的就绪状态。这是**事实**，不是状态机的状态——
 * 状态机的权威在 CP 的 Postgres 里（§D），provider 只回答"我现在看到什么"。
 */
export interface SandboxHealth {
  sandboxId: string;
  /**
   * `ready` / `starting` / `error` 来自 agent 的 `/health`；`unreachable` 是我们连不上它
   * （容器停了、网络还没就绪、agent 挂了）。调用方要区分"agent 说它没好"和"根本没答话"：
   * 前者等一等可能就好，后者是容器层面的问题。
   */
  status: AgentStatus;
  /** agent 版本（`/health` 的 version）。unreachable 时是 null。 */
  version: string | null;
  /**
   * 当前占着 BUSY 槽的执行 id（`exe_…` / `diff_…` / `archive_…`），空闲为 null。
   * 对账时靠它判断"CP 重启前有一个执行在跑"（Phase 8 用例 6）。
   */
  activeExecution: string | null;
  /** 这次 health 时用的 endpoint。unreachable 时仍然是解析出来的地址，便于排查。 */
  endpoint: string | null;
}

/** agent `/health` 的三种取值 + CP 自己的"连不上"。 */
export type AgentStatus = "ready" | "starting" | "error" | "unreachable";

/**
 * 对账用的单沙箱快照。**故意不叫 inspect 的原始 JSON**：Docker 的 inspect 有几百个
 * 字段，而 Phase 8 只需要这几个。原始 JSON 会诱使上层去读 `HostConfig` 之类的东西，
 * 那是 provider 的私事。
 */
export interface SandboxInspection {
  sandboxId: string;
  providerRef: string;
  containerName: string;
  /** 容器是否在跑（`State.Running`）。 */
  running: boolean;
  /** Docker 的容器状态字符串：created / running / exited / dead / paused / restarting。 */
  state: string;
  endpoint: string | null;
  /** agent 的就绪状态；容器没跑或不答话时是 `unreachable`。 */
  agentStatus: AgentStatus;
  activeExecution: string | null;
  version: string | null;
}

/**
 * `listManaged()` 的一行：**只看标签，不连 agent**（不健康检查）。
 * 对账第二步用它找孤儿容器：DB 里没有的 sandboxId 直接删。
 */
export interface ManagedSandbox {
  sandboxId: string | null;
  providerRef: string;
  containerName: string;
  runId: string | null;
  taskId: string | null;
  /**
   * 容器角色。macOS 上每个沙箱会多一个端口转发容器（见 local-docker.ts 的说明），
   * 它带同样的 sandboxId 标签，对账时必须能区分——否则会把转发容器当成沙箱本体。
   */
  role: ContainerRole;
  /** Docker 的短状态（`running` / `exited` / …）。 */
  state: string;
  running: boolean;
}

/**
 * 容器角色。`sandbox` 是本体，`port-forward` 只在 darwin 上出现（端口转发），
 * `egress-proxy` 是全局唯一的出网代理（Phase 6）——它带 `managed=true` 标签但是没有 sandboxId，
 * 对账（Phase 8）必须把它和上面两类分开处理：**代理不是沙箱，不能被当成孤儿删掉**。
 */
export type ContainerRole = "sandbox" | "port-forward" | "egress-proxy";

/**
 * Provider 层的失败原因。**结构化原因是这个接口最重要的输出之一**：
 * §D 的超时表要求"创建失败 → ERROR + 结构化原因"，Phase 8 把它写进审计表的 reason 字段，
 * 运维靠它区分"镜像拉不下来"和"agent 起不来"。所以永远不要只抛一个字符串。
 */
export type ProviderErrorReason =
  /** spec 本身不合法（tag-only 镜像、limits 越界、标签缺失、env 里有 token）。**没碰 Docker**。 */
  | "invalid_spec"
  /** 连不上 docker daemon（socket 不存在 / 权限不足 / daemon 没跑）。 */
  | "docker_unavailable"
  /** DOCKER_HOST 指向远程（tcp:// / http://）。见 resolveDockerSocketPath 的说明。 */
  | "unsupported_docker_host"
  /** 拉镜像失败（registry 不认、网络不通、manifest 不存在）。 */
  | "image_pull_failed"
  /** 本地没有这个镜像，而且它**没有 registry 可拉**（egress-proxy 就是本机构建的）。 */
  | "image_not_found"
  /** 拉镜像超预算（默认 120s，§D）。 */
  | "image_pull_timeout"
  /** 同名容器已经存在，而且不是我们管的（标签不匹配）。绝不删别人的容器。 */
  | "container_exists"
  /** 建容器 / 起容器被 Docker 拒绝（参数错、镜像坏了、资源不足）。 */
  | "container_create_failed"
  | "container_start_failed"
  /** 拿不到 endpoint（容器不在目标网络上 / 没发布端口 / 发布到了 0.0.0.0）。 */
  | "endpoint_unavailable"
  /** 15s 内 `/health` 没变成 ready（§D「创建（镜像已缓存）15s」）。 */
  | "health_timeout"
  /** agent 明确报 `status:"error"`。 */
  | "agent_error"
  /** 15s 的创建预算用光（网络/卷/容器/启动都算在内）。 */
  | "create_timeout"
  /** 共享内网不存在但名字被一个非 internal 的网络占了——宁可失败也不要静默用错网络。 */
  | "network_conflict"
  /** 请求的沙箱不存在（destroy/inspect/health 时）。 */
  | "not_found"
  /** 销毁路径上的错误。destroy 幂等，所以这个原因只在"删不掉"时出现（比如卷还在用）。 */
  | "destroy_failed"
  /** 其他 Docker API 错误。`details.status` / `details.message` 里有原文。 */
  | "docker_error";

/**
 * Provider 层唯一的错误类型。所有失败路径都要经过它——调用方按 `reason` 分支，
 * 而不是去匹配错误字符串（字符串匹配是本地化的敌人，也是重构的敌人）。
 */
export class ProviderError extends Error {
  readonly reason: ProviderErrorReason;
  /** 附加信息：Docker 的状态码与原文、容器名、哪一步失败。进日志与审计表，不进用户界面。 */
  readonly details: Record<string, unknown>;

  constructor(reason: ProviderErrorReason, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProviderError";
    this.reason = reason;
    this.details = details;
  }

  /** 给日志用的一行摘要。 */
  describe(): string {
    return `${this.reason}: ${this.message}`;
  }
}

/**
 * Provider 接口。五个方法，每一个都有明确的消费者：
 *  - `create` / `destroy` / `health` —— §C.1 的三个方法
 *  - `listManaged` / `inspect` —— §D 的启动对账，Phase 8 完全建立在这两个方法上，
 *    所以它们从第一天就有，不是"等到 Phase 8 再加"
 */
export interface SandboxProvider {
  /** 实现名，进日志与错误详情（`local-docker`）。 */
  readonly kind: string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** **幂等**：容器/卷不存在的 404 当作成功。对账会重复调用它（§Phase 5 §3）。 */
  destroy(sandboxId: string): Promise<void>;
  /** 探一次 agent 的 `/health`。容器不在 → ProviderError("not_found")。 */
  health(sandboxId: string): Promise<SandboxHealth>;
  /** 列出所有带 `reuben-cloud.managed=true` 标签的容器（含 darwin 的转发容器）。 */
  listManaged(): Promise<ManagedSandbox[]>;
  /** 单沙箱快照；容器不在 → null（对账用 null 表示"容器丢了"，不是异常）。 */
  inspect(sandboxId: string): Promise<SandboxInspection | null>;
}

// ---------------------------------------------------------------- 命名与标签

/**
 * Docker 标签与资源名前缀。**集中在 types.ts 里，因为它们是跨 phase 的契约**：
 * Phase 8 的对账、Phase 5 的 destroy、测试的清理全都按这几个字符串找东西，
 * 散落在各处就会出现"改了一处、对账开始漏掉一类容器"。
 *
 * 命名规则来自 spec §0.1（旧的 nightshift 一律作废）。
 */
export const LABEL_MANAGED = "reuben-cloud.managed";
export const LABEL_SANDBOX_ID = "reuben-cloud.sandboxId";
export const LABEL_RUN_ID = "reuben-cloud.runId";
export const LABEL_TASK_ID = "reuben-cloud.taskId";
/** 容器角色。沙箱本体也带（值为 "sandbox"），这样对账可以只用一个过滤器。 */
export const LABEL_ROLE = "reuben-cloud.role";

export const CONTAINER_PREFIX = "reuben-cloud-sbx-";
export const VOLUME_PREFIX = "reuben-cloud-ws-";
/** macOS 上的端口转发容器后缀。见 local-docker.ts 顶部的长篇说明。 */
export const FORWARD_CONTAINER_SUFFIX = "-fwd";

/** 容器内 sandbox-agent 监听的端口。镜像里 `EXPOSE 8080`，两边必须一致。 */
export const AGENT_PORT = 8080;

/**
 * 共享内网名。`--internal` = 没有出口路由，沙箱唯一的出网路径是 Phase 6 的代理容器
 * （它同时挂在同一个内网上，所以沙箱能用服务名 `reuben-cloud-proxy` 找到它）。
 */
export const INTERNAL_NETWORK = "reuben-cloud-internal";

/**
 * egress-proxy 在内网里的服务名与端口。Phase 5 还没有代理容器，但 env 先按最终形态注入：
 * 没有代理时这些变量只会让"想联网"的命令快速失败（连不上代理），而不是让它们真的出去。
 * 这个失败是**正确的**——它让"本地没有代理"和"生产里被白名单挡住"表现一致。
 */
export const PROXY_HOST = "reuben-cloud-proxy";
export const PROXY_PORT = 3128;

/**
 * egress-proxy 的容器名。**等于内网别名**：只有全局一个，不带 sandboxId。
 * Phase 7 的冒烟脚本、Phase 8 的对账、`npm run proxy:up/down` 全部用它找代理。
 */
export const PROXY_CONTAINER_NAME = PROXY_HOST;

/** 容器名的唯一来源。sandboxId 已经是 `sbx_<ulid>`，这里只加前缀。 */
export function sandboxContainerName(sandboxId: string): string {
  return `${CONTAINER_PREFIX}${sandboxId}`;
}

/** darwin 上端口转发容器的名字。 */
export function forwardContainerName(sandboxId: string): string {
  return `${CONTAINER_PREFIX}${sandboxId}${FORWARD_CONTAINER_SUFFIX}`;
}

/** 工作区卷名。卷不会被自动回收，所以名字必须能从 sandboxId 推回来。 */
export function workspaceVolumeName(sandboxId: string): string {
  return `${VOLUME_PREFIX}${sandboxId}`;
}
