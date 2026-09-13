/**
 * LocalDockerProvider：把「一个沙箱」翻译成「一个加固过的容器 + 一个命名卷 + 一个内网」。
 *
 * 【在链路中的位置】CP 的 provider 层，进程内模块，**不是独立服务**（§C.1）。
 * 上面是 Phase 8 的 SandboxManager（它往 DB 写状态），下面是 docker daemon。
 * 这个文件是**整个 CP 里唯一允许碰 docker socket 的地方**——把这句话变成结构性保证的
 * 办法就是：只有它 import `docker-api.ts`。
 *
 * 【加固参数硬编码在这里，spec 里没有开关能关掉】`SandboxSpec` 里**不存在** `privileged`、
 * 不存在 `binds`、不存在 `securityOpt`。代码里根本没有那些分支，就不可能被上层打开。
 * 这是 §F.1 那一整张表在实现层面的落点：不是"我们记得加"，是"加不进去"。
 * 具体的值见 `buildHostConfig()`，测试同时断言"发出去的请求"和"容器 inspect 的结果"。
 *
 * 【超时分层】§D 的表落到实现就是两条独立的计时：
 *  - **镜像拉取**：单独的 120s 预算。拆出来是为了让下面那条 15s 变得可预期。
 *  - **创建**（卷 + 网络 + 容器 + 启动 + health）：15s 总预算，到点就回 `create_timeout`，
 *    并且**先把已创建的资源删掉**。两者分开计时，上层才能区分"镜像没下下来"和
 *    "容器起不来"——这两种故障的处理完全不同。
 *
 * 【失败清理不靠调用方记得做】`create()` 用一个 try/catch 包住全部步骤，catch 里按
 * 创建的反向顺序清理（转发容器 → 沙箱容器 → 卷；网络是共享的，不删）。清理本身也
 * 全部吞异常：清一个已经没了的容器会 404，那不是新错误，不能覆盖真正的原因。
 *
 * ------------------------------------------------------------------ macOS 的端口转发
 *
 * Linux 上 CP 与容器同主机，直接走容器的内网 IP，**不发布任何端口**（§C.1 的原话）。
 * macOS / Docker Desktop 上做不到这一点：宿主与容器之间隔着一个 VM，宿主**无法**路由到
 * 容器的 172.x 地址（实测：`curl http://172.22.0.3:8080/health` 直接不通）。
 *
 * 那 `PortBindings` 行不行？**不行，而且是静默失败**——Docker Engine 对"只挂在
 * `--internal` 网络上的容器"根本不编程端口映射：容器照常起，`docker port` 什么都不显示，
 * `NetworkSettings.Ports` 是空的（这是引擎行为，不是 Docker Desktop 的怪癖；
 * moby/moby discussion #53256 有同样的最小复现）。实测三种写法都一样：
 * `-p 127.0.0.1::8080` / `-p 8080:8080` / `-p 127.0.0.1:18099:8080` 全部不生效。
 *
 * 所以 darwin 上多一个**端口转发容器**（`reuben-cloud-sbx-{id}-fwd`）：
 *   - 同时挂在 `reuben-cloud-internal`（能到 agent）和默认 `bridge`（能发布端口）上；
 *   - 只发布到 `127.0.0.1` 的随机端口（绝不 0.0.0.0）；
 *   - 跑的是 `sandbox-agent/src/forward.ts`（一个 ~60 行的 TCP 中继，没有别的能力）；
 *   - 端口映射**只加在它身上**：沙箱容器自己永远不发布任何端口。
 *
 * 为什么要费这个劲，而不是"macOS 上就别用 internal 网络了"：那样本地开发时沙箱会
 * 直接能上公网，于是"没配代理也能装依赖"这件事在本地永远测不出来，而它在生产里
 * 100% 会失败。宁可多一个中继容器，也不要一台和生产行为不一样的开发机。
 * 这里的不变量是：**沙箱容器在任何平台上都没有出网路径**，差异只在"宿主怎么够到它"。
 */

import { randomBytes } from "node:crypto";
import {
  DockerClient,
  DockerUnavailableError,
  isDockerError,
  isNotFound,
  isTimeoutError,
  resolveDockerSocketPath,
} from "./docker-api.ts";
import type {
  DockerContainerInspect,
  DockerContainerSummary,
  DockerCreateContainerRequest,
  DockerCreateResponse,
  DockerHostConfig,
  DockerNetworkInfo,
  DockerVolumeInfo,
} from "./docker-api.ts";
import {
  AGENT_PORT,
  INTERNAL_NETWORK,
  LABEL_MANAGED,
  LABEL_ROLE,
  LABEL_RUN_ID,
  LABEL_SANDBOX_ID,
  LABEL_TASK_ID,
  PROXY_HOST,
  PROXY_PORT,
  ProviderError,
  forwardContainerName,
  sandboxContainerName,
  workspaceVolumeName,
} from "./types.ts";
import type {
  AgentStatus,
  ContainerRole,
  ManagedSandbox,
  SandboxHandle,
  SandboxHealth,
  SandboxInspection,
  SandboxProvider,
  SandboxSpec,
} from "./types.ts";

// ---------------------------------------------------------------- 常量

/** 字节/核的换算基数。写出来是为了让 `2147483648` 这种数字在代码里有出处。 */
const MIB = 1024 * 1024;

/**
 * spec 里 limits 的**硬上限**。超出直接 `invalid_spec`，不静默钳制。
 *
 * 为什么是"硬上限"而不是"推荐值"：这一层的职责是保证**一个沙箱不可能要到宿主机级别的资源**。
 * 真正的分配策略（这个任务给多少 CPU）是 CP 上层的事，还没写。所以这里的数字只需要满足
 * "比任何合理的单任务需求都大，比宿主机小得多"。越界就报错，因为静默钳制会让调用方
 * 以为自己拿到了 64 核——和 Phase 1 里 `timeoutMs` 那条规矩完全一样。
 */
export const LIMIT_MAX_CPU = 8;
export const LIMIT_MAX_MEM_MB = 16 * 1024;
export const LIMIT_MAX_PIDS = 8 * 1024;
export const LIMIT_MAX_DISK_MB = 256 * 1024;
export const LIMIT_MAX_TTL_SEC = 24 * 60 * 60;
/** 下限：给 1 MiB 内存的"沙箱"连 node 都起不来，那是在制造没人看得懂的失败。 */
export const LIMIT_MIN_MEM_MB = 128;
export const LIMIT_MIN_PIDS = 32;
export const LIMIT_MIN_TTL_SEC = 60;

/** 镜像引用里的 digest 形状（§C.1：只接受 digest，不接受纯 tag）。 */
const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/** sandboxId / runId 等会进容器名与卷名的标识符。Docker 对卷名的字符集有要求。 */
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 环境变量名的形状（POSIX）。 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 沙箱容器 /tmp 的 tmpfs 大小。**tmpfs 页面计入 cgroup 内存**，所以它是 2 GiB 预算里的一部分。 */
const SANDBOX_TMPFS_MB = 512;
/** 转发容器是个 TCP 中继，16 MiB 的 /tmp 都嫌多。 */
const FORWARDER_TMPFS_MB = 16;
/** 转发容器自己的资源上限：它只搬字节，给多了是浪费，给少了会误伤。 */
const FORWARDER_MEM_MB = 128;
const FORWARDER_NANO_CPUS = 250_000_000; // 0.25 核
const FORWARDER_PIDS = 64;

/** Docker 的 json-file 日志轮转（附录 A-11）。 */
const LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

/** 日志级别。provider 只发两种：`info` 是正常事件，`warn` 是"做完了但有件事要你知道"。 */
export type ProviderLogLevel = "info" | "warn";

/**
 * Provider 的可调项。**生产用默认值**，测试用它把预算压到毫秒级（用例 6 的 health 超时
 * 不能真等 15 秒）。跨平台的差异（darwin 的转发容器）由 `platform` 决定，测试注入
 * `platform: "darwin"` 就能在 mac 上跑到与 Linux 相同的分支。
 */
export interface LocalDockerProviderOptions {
  /** docker socket 路径。缺省走 `resolveDockerSocketPath()`（`DOCKER_HOST` 是 tcp:// 时抛错）。 */
  socketPath?: string;
  /** 共享内网名。默认 `reuben-cloud-internal`。 */
  networkName?: string;
  /** 代理地址，注入进容器的 `HTTP_PROXY` 等变量。默认 `http://reuben-cloud-proxy:3128`。 */
  proxyUrl?: string;
  /** 平台。默认 `process.platform`；注入它是为了单测/在 mac 上验证 Linux 分支。 */
  platform?: NodeJS.Platform;
  /** 拉镜像的预算（§D：120s）。 */
  pullTimeoutMs?: number;
  /** 创建的总预算（§D：15s），不含拉镜像。 */
  createTimeoutMs?: number;
  /** health 轮询间隔（§D：250ms）。 */
  healthIntervalMs?: number;
  /** 单次 health 请求的超时。它必须显著小于轮询预算，否则一次卡住的请求会吃掉整个预算。 */
  healthProbeTimeoutMs?: number;
  /** 单请求的 Docker API 超时（非拉取）。 */
  requestTimeoutMs?: number;
  /** 日志出口。默认：warn 打到 `console.warn`，info 丢弃（测试可注入记录器）。 */
  log?: (level: ProviderLogLevel, message: string, details?: Record<string, unknown>) => void;
}

/** 内部用的规范化配置（默认值已填好）。 */
interface ResolvedOptions {
  socketPath: string;
  networkName: string;
  proxyUrl: string;
  platform: NodeJS.Platform;
  pullTimeoutMs: number;
  createTimeoutMs: number;
  healthIntervalMs: number;
  healthProbeTimeoutMs: number;
  requestTimeoutMs: number;
  log: (level: ProviderLogLevel, message: string, details?: Record<string, unknown>) => void;
}

/** 校验之后的 spec：保证下游拿到的东西已经合法，不用重复判断。 */
interface ValidatedSpec extends SandboxSpec {
  env: Record<string, string>;
}

/** agent `/health` 的响应体（CP 侧的描述，故意不复用沙箱的类型）。 */
interface AgentHealthPayload {
  status?: string;
  version?: string;
  activeExecution?: string | null;
}

// ---------------------------------------------------------------- spec 校验

/**
 * 校验 spec 并归一化。**这一步在任何 Docker 调用之前**（spec Phase 5 §2 第 1 步）：
 * 非法输入不应该在 daemon 上留下任何痕迹，也不应该花 120s 去拉一个根本不该拉的镜像。
 *
 * 每一条拒绝都有具体理由，不是"防御性编程"：
 *  - 镜像没有 digest：tag 可变，"验证过的版本"和"下次跑的版本"无法证明是同一个。
 *  - limits 越界：见 LIMIT_* 的说明。
 *  - 标签缺失/非法：**对账的唯一依据**（§D），名字进容器名与卷名。
 *  - env 里带 `SANDBOX_AGENT_TOKEN`：token 由 provider 每次 create 现生成，
 *    允许上层指定等于允许所有沙箱共用一个凭据。
 *  - 带 `reuben-cloud.` 前缀的自定义标签：那是 provider 自己的命名空间，
 *    让上层写等于让它伪造 sandboxId —— 对账会开始认错容器。
 */
export function validateSpec(spec: SandboxSpec): ValidatedSpec {
  const bad = (message: string, details: Record<string, unknown> = {}): never => {
    throw new ProviderError("invalid_spec", message, details);
  };

  if (typeof spec.image !== "string" || !DIGEST_RE.test(spec.image)) {
    bad(`image 必须带 digest（形如 repo@sha256:<64 hex>），得到 ${JSON.stringify(spec.image)}`, {
      image: spec.image,
    });
  }

  const limits = spec.limits;
  if (limits === undefined || limits === null) bad("limits 必填");
  const { cpu, memMb, pids, diskMb, ttlSec } = limits;
  if (typeof cpu !== "number" || !Number.isFinite(cpu) || cpu <= 0 || cpu > LIMIT_MAX_CPU) {
    bad(`limits.cpu 必须在 (0, ${LIMIT_MAX_CPU}]，得到 ${JSON.stringify(cpu)}`);
  }
  if (!isIntegerInRange(memMb, LIMIT_MIN_MEM_MB, LIMIT_MAX_MEM_MB)) {
    bad(`limits.memMb 必须在 [${LIMIT_MIN_MEM_MB}, ${LIMIT_MAX_MEM_MB}]，得到 ${JSON.stringify(memMb)}`);
  }
  if (!isIntegerInRange(pids, LIMIT_MIN_PIDS, LIMIT_MAX_PIDS)) {
    bad(`limits.pids 必须在 [${LIMIT_MIN_PIDS}, ${LIMIT_MAX_PIDS}]，得到 ${JSON.stringify(pids)}`);
  }
  if (!isIntegerInRange(diskMb, 0, LIMIT_MAX_DISK_MB)) {
    bad(`limits.diskMb 必须在 [0, ${LIMIT_MAX_DISK_MB}]，得到 ${JSON.stringify(diskMb)}`);
  }
  if (!isIntegerInRange(ttlSec, LIMIT_MIN_TTL_SEC, LIMIT_MAX_TTL_SEC)) {
    bad(`limits.ttlSec 必须在 [${LIMIT_MIN_TTL_SEC}, ${LIMIT_MAX_TTL_SEC}]，得到 ${JSON.stringify(ttlSec)}`);
  }

  const workspace = spec.workspace;
  if (workspace === undefined || workspace === null || !isIntegerInRange(workspace.sizeMb, 0, LIMIT_MAX_DISK_MB)) {
    bad(`workspace.sizeMb 必须在 [0, ${LIMIT_MAX_DISK_MB}]，得到 ${JSON.stringify(workspace?.sizeMb)}`);
  }

  const labels = spec.labels;
  if (labels === undefined || labels === null) bad("labels 必填");
  requireIdentifier(labels.sandboxId, "labels.sandboxId", bad);
  requireIdentifier(labels.runId, "labels.runId", bad);
  if (labels.taskId !== undefined) requireIdentifier(labels.taskId, "labels.taskId", bad);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!ENV_KEY_RE.test(key)) bad(`env 的键不合法：${JSON.stringify(key)}`);
    if (typeof value !== "string" || value.includes("\0")) {
      bad(`env[${key}] 必须是不含 NUL 的字符串，得到 ${JSON.stringify(value)}`);
    }
    if (key.toUpperCase() === "SANDBOX_AGENT_TOKEN") {
      bad("env 里不允许出现 SANDBOX_AGENT_TOKEN：token 由 provider 每次 create 现生成", { key });
    }
    env[key] = value;
  }
  if (Object.keys(env).length > 64) bad(`env 最多 64 项，得到 ${Object.keys(env).length}`);

  return { ...spec, env };
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function requireIdentifier(value: unknown, field: string, bad: (message: string) => never): void {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    bad(`${field} 必须是 ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$，得到 ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------- 纯函数：加固参数与 endpoint

/**
 * 造一份加固过的 HostConfig。**纯函数**，所以"加固参数有没有被漏掉"这件事可以在
 * 毫秒级的单元测试里断言，不用起容器（集成测试再断言真实容器的 inspect 结果，两边都做）。
 *
 * 逐条对应 §F.1：
 *  - `ReadonlyRootfs` —— 镜像内容不可篡改，木马无法持久化。
 *  - `CapDrop: ["ALL"]` —— 默认的 14 个 capability（含 CAP_NET_RAW / CAP_CHOWN）一个不留。
 *  - `no-new-privileges` + `apparmor=docker-default` —— 阻断 setuid 提权；AppArmor 显式写出
 *    防止被意外关掉。**不写 seccomp** = 用 Docker 默认 profile（§F.1 要求"必须是默认 profile"，
 *    翻译成实现就是"这一项根本不出现"）。测试断言 `SecurityOpt` 里**不含** `seccomp=`。
 *  - `Privileged: false` —— 显式写出，且没有任何分支能把它设成 true。
 *  - `Memory == MemorySwap` —— 两者不等等于 swap 可用，内存上限形同虚设。
 *  - `Init: true` —— tini 回收僵尸，否则 agent 起的后台进程会把 pids 上限耗光。
 *  - `Tmpfs` 只有 /tmp 一项 —— 只读根之外的可写点必须逐个显式列出。
 *  - `Binds`：沙箱容器只允许命名卷；唯一一个 bind mount 的消费者是 egress-proxy
 *    （Phase 6 需要宿主文件与容器内路径是同一份内容才能 SIGHUP 换白名单，见 egress-proxy.ts）。
 *  - `LogConfig` 默认按附录 A-11 轮转；代理传自己的（100m × 5）。
 */
export function buildHostConfig(input: {
  networkName: string;
  memoryMb: number;
  nanoCpus: number;
  pids: number;
  binds: string[];
  tmpfsMb: number;
  /** 有值才发布端口（darwin 的转发容器）。沙箱容器**永远**不传它。 */
  publishPort?: number;
  /** 非默认的 tmpfs 选项（转发容器与 egress-proxy 用 noexec）。 */
  tmpfsOptions?: string;
  /** 非默认的日志轮转（egress-proxy 用 100m × 5）。 */
  logConfig?: DockerHostConfig["LogConfig"];
}): DockerHostConfig {
  const hostConfig: DockerHostConfig = {
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true", "apparmor=docker-default"],
    Privileged: false,
    Memory: input.memoryMb * MIB,
    MemorySwap: input.memoryMb * MIB,
    NanoCpus: input.nanoCpus,
    PidsLimit: input.pids,
    Init: true,
    Tmpfs: {
      // 沙箱的 /tmp **必须 exec**：Docker 对 tmpfs 的缺省里带了 noexec，不显式写 `exec`
      // 就会被加上（实测：`rw,nosuid,size=512m,mode=1777` → 挂载结果里多了 noexec）。
      // 那会打断 npm 的 postinstall / node-gyp / python venv 里的 console script——
      // 它们都要从 /tmp 执行一个刚写进去的文件。§F.1 明确说了这条取舍：
      // 攻击者本来就能在 /workspace 执行任意代码，noexec 换不来实际安全增益，却会真地弄坏可用性。
      "/tmp": input.tmpfsOptions ?? `rw,exec,nosuid,size=${input.tmpfsMb}m,mode=1777`,
    },
    Binds: input.binds,
    // 内网：没有出口路由，唯一的出网路径是 Phase 6 的代理容器。
    NetworkMode: input.networkName,
    RestartPolicy: { Name: "no" },
    AutoRemove: false,
    LogConfig: input.logConfig ?? LOG_CONFIG,
  };
  if (input.publishPort !== undefined) {
    // HostIp 硬编码成 127.0.0.1：**绝不发布到 0.0.0.0**（§Phase 5 的原文）。
    hostConfig.PortBindings = {
      [`${input.publishPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
    };
  }
  return hostConfig;
}

/** 沙箱容器的创建请求体。抽成纯函数是为了让"加固参数 + 镜像引用"在单测里可断言。 */
export function buildSandboxContainerRequest(input: {
  spec: ValidatedSpec;
  token: string;
  volumeName: string;
  networkName: string;
  proxyUrl: string;
}): DockerCreateContainerRequest {
  const { spec } = input;
  const hostConfig = buildHostConfig({
    networkName: input.networkName,
    memoryMb: spec.limits.memMb,
    nanoCpus: Math.round(spec.limits.cpu * 1_000_000_000),
    pids: spec.limits.pids,
    binds: [`${input.volumeName}:/workspace`],
    tmpfsMb: SANDBOX_TMPFS_MB,
  });

  // ---------------------------------------------------------------- 反向验证钩子（Phase 7）
  //
  // 隔离红线测试最容易变成一段永远绿的装饰性代码：没人知道它到底在测什么。所以
  // Phase 7 的 CI 里有一个 job **故意**把这里打开，然后断言 `--tag=isolation` 必须变红。
  //
  // 几条自我约束：
  //  - 普通路径上这个 env 永远不存在，所以这行代码跑不到（`grep SMOKE_NEGATIVE_CONTROL`
  //    一眼能看出它是个测试钩子，不是一个隐藏配置）。
  //  - 钩子只落在**沙箱容器**上：`buildHostConfig` 本身没被动，所以 darwin 的转发容器
  //    与 Phase 6 的出网代理都不会因此失去加固——被破坏的正是"沙箱被加固了吗"这一条。
  //  - 只破坏一项（CapDrop），失败原因才唯一：I10 的 `docker inspect` 复核会精确地
  //    在 CapDrop 那一行断言失败，CI 的反向验证 job 靠这个字符串确认"失败原因是它"。
  if (process.env.SMOKE_NEGATIVE_CONTROL) {
    hostConfig.CapDrop = [];
  }

  return {
    Image: spec.image,
    User: "1000:1000",
    WorkingDir: "/workspace",
    Env: buildContainerEnv(spec.env, input.token, input.proxyUrl),
    Labels: buildLabels(spec, "sandbox"),
    HostConfig: hostConfig,
  };
}

/**
 * darwin 的端口转发容器。它**不是沙箱**：只跑 `src/forward.ts`，把宿主发布端口上的
 * 连接转到沙箱 agent 的 8080。同一个镜像（已经拉过了，不用额外构建），但资源上限更低、
 * /tmp 更小且 noexec —— 它没有理由执行任何东西。
 *
 * 双网卡是必须的：内网让它能到 agent，默认 bridge 让端口发布生效（见文件头）。
 */
export function buildForwarderContainerRequest(input: {
  spec: ValidatedSpec;
  sandboxId: string;
  networkName: string;
  targetHost: string;
}): DockerCreateContainerRequest {
  return {
    Image: input.spec.image,
    User: "1000:1000",
    WorkingDir: "/app",
    Env: [`HOME=/tmp/agent`],
    Labels: buildLabels(input.spec, "port-forward"),
    Cmd: [
      "node",
      "src/forward.ts",
      "--listen",
      String(AGENT_PORT),
      "--target",
      `${input.targetHost}:${AGENT_PORT}`,
    ],
    ExposedPorts: { [`${AGENT_PORT}/tcp`]: {} },
    HostConfig: buildHostConfig({
      networkName: input.networkName,
      memoryMb: FORWARDER_MEM_MB,
      nanoCpus: FORWARDER_NANO_CPUS,
      pids: FORWARDER_PIDS,
      binds: [],
      tmpfsMb: FORWARDER_TMPFS_MB,
      tmpfsOptions: `rw,noexec,nosuid,size=${FORWARDER_TMPFS_MB}m,mode=1777`,
      publishPort: AGENT_PORT,
    }),
    // 主网络是内网（默认路由不给它），再加一个默认 bridge 让端口发布生效。
    // Phase 6 的 egress-proxy 反过来：主网络是 bridge（出口路由在那里），内网靠别名挂上去。
    NetworkingConfig: {
      EndpointsConfig: { [input.networkName]: {}, bridge: {} },
    },
  };
}

/**
 * 容器环境 = 固定三项 + spec.env。**不继承 CP 自己的 process.env**（和 Phase 1 的
 * `buildEnv()` 同一条理由：确定性，不是防泄密）。
 *
 * 代理变量按最终形态注入：Phase 6 才有代理容器，但**现在就注入**，因为没有代理时
 * "想联网"的命令会快速失败——这个失败是特性：本地和"生产里被白名单挡住"表现一致。
 */
export function buildContainerEnv(extra: Record<string, string>, token: string, proxyUrl: string): string[] {
  const base: Record<string, string> = {
    SANDBOX_AGENT_TOKEN: token,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    // 本机与内网不走代理。漏掉 localhost 会让 agent 自己的探活被代理掉。
    NO_PROXY: `localhost,127.0.0.1,::1,${PROXY_HOST},${INTERNAL_NETWORK}`,
    no_proxy: `localhost,127.0.0.1,::1,${PROXY_HOST},${INTERNAL_NETWORK}`,
  };
  // extra 在最后：允许上层覆盖代理设置（比如测试里给一个不存在的代理），
  // 但 token 已经在 validateSpec 里被禁止覆盖了。
  for (const [key, value] of Object.entries(extra)) base[key] = value;
  return Object.entries(base).map(([key, value]) => `${key}=${value}`);
}

/** 标签的唯一定义处。对账、清理、测试都按这几个字符串找东西。 */
function buildLabels(spec: ValidatedSpec, role: ContainerRole): Record<string, string> {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: "true",
    [LABEL_SANDBOX_ID]: spec.labels.sandboxId,
    [LABEL_RUN_ID]: spec.labels.runId,
    [LABEL_ROLE]: role,
  };
  if (spec.labels.taskId !== undefined) labels[LABEL_TASK_ID] = spec.labels.taskId;
  return labels;
}

/** endpoint 解析失败的原因。每一种都对应一个具体的排查方向，所以不合并成一个字符串。 */
export type EndpointFailure =
  | "container_ip_missing"
  | "published_port_missing"
  | "unsafe_host_ip";

export type EndpointResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: EndpointFailure; detail: string };

/**
 * 从容器 inspect JSON 里算出 agent 的基地址。**纯函数**（spec 测试要点第 8 条要求它可单测）。
 *
 * Linux：读目标内网上容器自己的 IP。宿主到 bridge 上的容器 IP 默认可达，
 * 所以不需要发布任何端口——这也是"生产在 Linux 上跑"的一个具体好处。
 *
 * darwin：读发布到宿主的随机端口。**必须校验 HostIp 是 127.0.0.1**：
 * 如果哪天有人把发布地址改成 0.0.0.0，这里会拒绝而不是"能用就行"——
 * 那意味着沙箱的 agent 暴露在整个局域网上，一个只在内网里可见的端口不该有这种命运。
 */
export function resolveEndpoint(
  inspect: DockerContainerInspect,
  options: { platform: NodeJS.Platform; networkName: string; port: number },
): EndpointResult {
  if (options.platform === "darwin") {
    const bindings = inspect.NetworkSettings?.Ports?.[`${options.port}/tcp`] ?? null;
    const binding = (bindings ?? []).find((item) => (item?.HostPort ?? "") !== "");
    if (binding === undefined) {
      return {
        ok: false,
        reason: "published_port_missing",
        detail: `容器没有发布 ${options.port}/tcp（internal 网络上的容器不会自动发布，见文件头）`,
      };
    }
    const hostIp = binding.HostIp ?? "";
    if (hostIp !== "127.0.0.1" && hostIp !== "::1") {
      return {
        ok: false,
        reason: "unsafe_host_ip",
        detail: `端口发布在 ${JSON.stringify(hostIp)} 上，只接受 127.0.0.1（绝不发布到 0.0.0.0）`,
      };
    }
    return { ok: true, endpoint: `http://127.0.0.1:${binding.HostPort}` };
  }

  const address = inspect.NetworkSettings?.Networks?.[options.networkName]?.IPAddress ?? "";
  if (address === "") {
    return {
      ok: false,
      reason: "container_ip_missing",
      detail: `容器不在 ${options.networkName} 网络上，或者还没拿到 IP`,
    };
  }
  return { ok: true, endpoint: `http://${address}:${options.port}` };
}

// ---------------------------------------------------------------- Provider 本体

/**
 * 本机 Docker 的 SandboxProvider 实现。
 *
 * 生命周期（§D）映射到方法：
 *   create → CREATING（调用方在调用前就写好了这行记录）
 *   health → 轮询到 READY / 抛错转 ERROR
 *   destroy → DESTROYED（幂等，对账会重复调）
 *   inspect / listManaged → 崩溃恢复的唯一事实来源
 */
export class LocalDockerProvider implements SandboxProvider {
  readonly kind = "local-docker";
  /** Docker API 客户端。测试里可以换成指向假 socket 的实例。 */
  readonly docker: DockerClient;

  readonly #options: ResolvedOptions;

  constructor(options: LocalDockerProviderOptions = {}) {
    // socket 路径的解析有两种失败：DOCKER_HOST 指向远程（配置错，**永远不该重试**）
    // 与 socket 不存在（daemon 没起来）。前者翻译成 `unsupported_docker_host`——
    // 静默连到另一台机器上比直接失败危险得多，所以这个原因必须是可识别的，
    // 而不是混在 `docker_unavailable` 里。
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
      socketPath,
      networkName: options.networkName ?? INTERNAL_NETWORK,
      proxyUrl: options.proxyUrl ?? `http://${PROXY_HOST}:${PROXY_PORT}`,
      platform: options.platform ?? process.platform,
      pullTimeoutMs: options.pullTimeoutMs ?? 120_000,
      createTimeoutMs: options.createTimeoutMs ?? 15_000,
      healthIntervalMs: options.healthIntervalMs ?? 250,
      healthProbeTimeoutMs: options.healthProbeTimeoutMs ?? 2_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      log: options.log ?? defaultLog,
    };
    this.docker = new DockerClient({
      socketPath: this.#options.socketPath,
      defaultTimeoutMs: this.#options.requestTimeoutMs,
    });
  }

  /** 共享内网名（Phase 6 的代理容器要挂到同一个网络上，所以它得能读出来）。 */
  get networkName(): string {
    return this.#options.networkName;
  }

  /** 当前平台。日志与测试用。 */
  get platform(): NodeJS.Platform {
    return this.#options.platform;
  }

  /**
   * 创建一个沙箱。步骤顺序**本身是设计的一部分**（Phase 5 §2）：
   * 校验 → 拉镜像 → 建网络 → 建卷 → 建容器 → 启动 →（darwin 加转发容器）→ 解析 endpoint → 等 health。
   *
   * 任何一步失败都会反向清理已创建的东西，然后抛带结构化原因的 `ProviderError`。
   * 失败路径的清理**不能靠调用方记得做**——调用方在失败时第一反应是重试或报警，
   * 而不是"先删掉那半个容器"。
   */
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const clean = validateSpec(spec);
    const sandboxId = clean.labels.sandboxId;
    const containerName = sandboxContainerName(sandboxId);
    const volumeName = workspaceVolumeName(sandboxId);
    // token 每次 create 现生成：它只保护一个仅在内网可达的端口，但"每沙箱一个"是底线。
    const authToken = randomBytes(32).toString("base64url");

    // 第 2 步：拉镜像。**单独计时**（120s 预算），之后的一切共用 15s 预算。
    await this.#ensureImage(clean.image);

    const deadline = Date.now() + this.#options.createTimeoutMs;
    let sandboxContainerId: string | null = null;
    let forwarderContainerId: string | null = null;
    let volumeCreated = false;
    try {
      // 第 3/4 步：网络与卷。网络放在卷前面（相对正文挪了一处，理由见实现备注 7）：
      // 它是共享资源（建一次就够、且幂等），失败时不该留下一个待清理的卷。
      // Phase 6 的 egress-proxy 也用同一份实现（它必须挂在同一张内网上）。
      await ensureInternalNetwork(this.docker, this.#options.networkName, { timeoutMs: budgetTimeout(deadline) });
      await this.#createVolume(volumeName, clean, deadline);
      volumeCreated = true;

      // 第 5 步：建容器（此时 spec 已校验，加固参数已固化在请求体里）。
      const body = buildSandboxContainerRequest({
        spec: clean,
        token: authToken,
        volumeName,
        networkName: this.#options.networkName,
        proxyUrl: this.#options.proxyUrl,
      });
      sandboxContainerId = await this.#createContainerWithConflict(
        containerName,
        body,
        sandboxId,
        deadline,
        "container_create",
      );

      // 第 6 步：启动。
      await this.#startContainer(sandboxContainerId, deadline);

      // 第 7 步：darwin 才有的端口转发容器（见文件头）。Linux 上没有这一步。
      if (this.#options.platform === "darwin") {
        forwarderContainerId = await this.#createForwarder(clean, containerName, deadline);
        await this.#startContainer(forwarderContainerId, deadline);
      }

      // 第 8 步：解析 endpoint + 轮询 /health。两者的预算都是那同一个 15s。
      const endpointContainerId = forwarderContainerId ?? sandboxContainerId;
      const endpoint = await this.#waitForEndpoint(endpointContainerId, deadline);
      const health = await this.#waitForReady(endpoint, authToken, deadline);

      this.#log("info", `沙箱 ${sandboxId} 就绪`, { endpoint, container: containerName });
      return {
        sandboxId,
        providerRef: sandboxContainerId,
        endpoint,
        authToken,
        containerName,
        volumeName,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      // 反向清理：转发容器 → 沙箱容器 → 卷。网络是共享的，不删。
      await this.#rollback({
        sandboxId,
        containerIds: [forwarderContainerId, sandboxContainerId],
        volumeName,
        volumeCreated,
      });
      throw asProviderError(error);
    }
  }

  /**
   * 销毁沙箱。**幂等**（对账会重复调它）：
   *  1. darwin 的转发容器先删（它还挂着端口）
   *  2. `stop?t=10` 给 agent 10 秒自己带走子进程组（§Phase 5 §3）——这一步很重要，
   *     直接 `kill -9` 会在卷里留下半个写入状态
   *  3. `DELETE force=1` 兜底
   *  4. 删卷；卷还在用（409）时记警告，留给下次对账
   *
   * 名字被别人占了（标签不是我们的）时**什么都不做**：绝不删不属于自己的容器。
   */
  async destroy(sandboxId: string): Promise<void> {
    await this.#removeContainerByName(forwardContainerName(sandboxId), sandboxId, { force: true });
    const sandboxName = sandboxContainerName(sandboxId);
    const ours = await this.#isOursByName(sandboxName, sandboxId);
    if (ours !== null) {
      await this.#stopContainer(ours.Id);
      await this.#removeContainerById(ours.Id);
    } else if (ours === null) {
      // 容器不在：正常（已经删过了，或者本来就没起来）。
    }
    await this.#removeVolume(workspaceVolumeName(sandboxId));
    this.#log("info", `沙箱 ${sandboxId} 已销毁`);
  }

  /**
   * 探一次 agent 的 `/health`。
   *
   * token 是从容器的 `Config.Env` 里读回来的——看起来像个捷径，其实是必需的：
   * CP 重启后 provider 是新的对象，而沙箱还活着，对账必须能继续跟它说话。
   * token 的明文就在容器 env 里（Phase 8 的 DB 里也明文存，那一条已经记过账），
   * 所以这不是新增的暴露面。
   *
   * 容器不在 → `not_found`（这是异常，调用方应该转 ERROR）；
   * 容器在但连不上 → 返回 `status: "unreachable"`（这是事实，不是异常）。
   */
  async health(sandboxId: string): Promise<SandboxHealth> {
    const inspect = await this.#inspectByName(sandboxContainerName(sandboxId));
    if (inspect === null || !isOwnedBy(inspect, sandboxId)) {
      throw new ProviderError("not_found", `沙箱 ${sandboxId} 的容器不存在`, { sandboxId });
    }
    const token = readTokenFromInspect(inspect);
    const resolved = await this.#endpointForInspect(sandboxId, inspect);
    if (!resolved.ok) {
      return { sandboxId, status: "unreachable", version: null, activeExecution: null, endpoint: null };
    }
    const probe = await this.#probeHealth(resolved.endpoint, token, this.#options.healthProbeTimeoutMs);
    return {
      sandboxId,
      status: probe?.status ?? "unreachable",
      version: probe?.version ?? null,
      activeExecution: probe?.activeExecution ?? null,
      endpoint: resolved.endpoint,
    };
  }

  /**
   * 列出所有带 `reuben-cloud.managed=true` 的容器（含 darwin 的转发容器）。
   * **只看标签，不连 agent**：对账的第一步是"列出真实世界里的东西"，
   * 这一步不应该因为某个 agent 挂了而整体失败。
   */
  async listManaged(): Promise<ManagedSandbox[]> {
    let summaries: DockerContainerSummary[];
    try {
      summaries = await this.docker.json<DockerContainerSummary[]>("GET", "/containers/json", {
        query: { all: 1, filters: JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }) },
      });
    } catch (error) {
      throw asProviderError(error);
    }
    const rows = (summaries ?? []).map((summary) => {
      const labels = summary.Labels ?? {};
      return {
        sandboxId: labels[LABEL_SANDBOX_ID] ?? null,
        providerRef: summary.Id,
        containerName: (summary.Names?.[0] ?? "").replace(/^\//, ""),
        runId: labels[LABEL_RUN_ID] ?? null,
        taskId: labels[LABEL_TASK_ID] ?? null,
        role: toContainerRole(labels[LABEL_ROLE]),
        state: summary.State ?? "unknown",
        running: summary.State === "running",
      } satisfies ManagedSandbox;
    });
    // 排序：对账与测试都希望同一份世界给出同一个顺序（Docker 不保证返回顺序）。
    return rows.sort((left, right) => left.containerName.localeCompare(right.containerName));
  }

  /**
   * 单沙箱快照。容器不在 → `null`。
   *
   * **`null` 与异常的区别是刻意的**：对账看到 `null` 意味着"DB 里有一行，但容器没了"，
   * 它要做的动作是 `transition(ERROR, "container_lost")`；而抛异常意味着"我没法判断"，
   * 那时应该保持现状、等下一轮。
   */
  async inspect(sandboxId: string): Promise<SandboxInspection | null> {
    const inspect = await this.#inspectByName(sandboxContainerName(sandboxId));
    if (inspect === null || !isOwnedBy(inspect, sandboxId)) return null;

    const token = readTokenFromInspect(inspect);
    const resolved = await this.#endpointForInspect(sandboxId, inspect);
    let agentStatus: AgentStatus = "unreachable";
    let activeExecution: string | null = null;
    let version: string | null = null;
    if (resolved.ok) {
      const probe = await this.#probeHealth(resolved.endpoint, token, this.#options.healthProbeTimeoutMs);
      if (probe !== null) {
        agentStatus = probe.status;
        activeExecution = probe.activeExecution;
        version = probe.version;
      }
    }
    return {
      sandboxId,
      providerRef: inspect.Id,
      containerName: sandboxContainerName(sandboxId),
      running: inspect.State?.Running === true,
      state: inspect.State?.Status ?? "unknown",
      endpoint: resolved.ok ? resolved.endpoint : null,
      agentStatus,
      activeExecution,
      version,
    };
  }

  // -------------------------------------------------------------- 创建的各步骤

  /**
   * 保证镜像在本地。**先查本地，再拉**——这不是优化，是本地开发的必需：
   * 本地构建的镜像（`reuben-cloud/sandbox-base:dev`）没有对应的 registry，
   * 无脑 `POST /images/create` 会去 docker.io 找 `reuben-cloud/sandbox-base` 并 403。
   *
   * digest 引用在这一步被验证：`@sha256:` 里那个 64 位十六进制要么在本地命中，
   * 要么能被 registry 解析，否则就是 `image_pull_failed`。
   */
  async #ensureImage(image: string): Promise<void> {
    try {
      await this.docker.json("GET", `/images/${encodeURIComponent(image)}/json`, {
        timeoutMs: this.#options.requestTimeoutMs,
      });
      return; // 本地已有
    } catch (error) {
      if (!isNotFound(error)) throw asProviderError(error, "image_inspect");
      // 404：继续往下拉。
    }

    try {
      await this.docker.ndjson(
        "POST",
        "/images/create",
        { query: { fromImage: image }, timeoutMs: this.#options.pullTimeoutMs },
        (message) => {
          // pull 失败时 HTTP 状态码仍然是 200，错误在流里——不看这里就会把
          // "镜像没拉下来"当成成功，然后在 create container 那一步拿到一个更奇怪的 404。
          if (typeof message.error === "string" && message.error !== "") {
            throw new ProviderError("image_pull_failed", `拉镜像失败：${message.error}`, { image });
          }
        },
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (isTimeoutError(error)) {
        throw new ProviderError("image_pull_timeout", `拉镜像超过 ${this.#options.pullTimeoutMs}ms`, { image });
      }
      const cause = error instanceof Error ? error.message : String(error);
      throw new ProviderError("image_pull_failed", `拉镜像失败：${cause}`, { image });
    }
  }

  /** 建工作区卷。卷名带 sandboxId，所以删卷时不需要额外记录。 */
  async #createVolume(volumeName: string, spec: ValidatedSpec, deadline: number): Promise<void> {
    try {
      await this.docker.json<DockerVolumeInfo>("POST", "/volumes/create", {
        body: { Name: volumeName, Labels: buildLabels(spec, "sandbox") },
        timeoutMs: budgetTimeout(deadline),
      });
    } catch (error) {
      throw asProviderError(error, "volume_create");
    }
  }

  /**
   * 建容器，处理名字冲突。**沙箱容器与转发容器共用一个实现**：两者的冲突语义完全一样
   * （"上一次 create 的残留" vs "别人的容器"），写成两份就会出现一个处理了一个没处理——
   * 实测正是如此：只有沙箱容器那一条被处理时，重建流程会卡在转发容器的 409 上。
   *
   * 名字冲突有两种来源，处理方式完全不同：
   *  - 上一次 create 崩在中途、容器没清掉（**我们的**容器）：删掉重来。这是 CP 崩溃恢复的
   *    常见情形，报错只会让调用方多写一份重试逻辑。
   *  - 别人占了这个名字（标签不是我们的）：`container_exists`。**绝不删别人的容器**。
   *
   * @param step 错误分类用（`container_create` / `forwarder_create`），日志里靠它定位。
   */
  async #createContainerWithConflict(
    name: string,
    body: DockerCreateContainerRequest,
    sandboxId: string,
    deadline: number,
    step: string,
  ): Promise<string> {
    try {
      const response = await this.docker.json<DockerCreateResponse>("POST", "/containers/create", {
        query: { name },
        body,
        timeoutMs: budgetTimeout(deadline),
      });
      return response.Id;
    } catch (error) {
      if (!isDockerError(error, 409)) throw asProviderError(error, step);

      const existing = await this.#inspectByName(name);
      if (existing === null || !isOwnedBy(existing, sandboxId)) {
        throw new ProviderError("container_exists", `容器名 ${name} 已被一个不属于本沙箱的容器占用`, {
          name,
          sandboxId,
        });
      }
      this.#log("warn", `容器 ${name} 已经存在（上一次 create 的残留），先删掉再重建`, {
        sandboxId,
      });
      await this.#removeContainerById(existing.Id);
      try {
        const retry = await this.docker.json<DockerCreateResponse>("POST", "/containers/create", {
          query: { name },
          body,
          timeoutMs: budgetTimeout(deadline),
        });
        return retry.Id;
      } catch (retryError) {
        throw asProviderError(retryError, step);
      }
    }
  }

  /** 起容器。304 = 已经在跑（幂等），也当成功。 */
  async #startContainer(containerId: string, deadline: number): Promise<void> {
    try {
      await this.docker.json("POST", `/containers/${containerId}/start`, {
        timeoutMs: budgetTimeout(deadline),
      });
    } catch (error) {
      if (isDockerError(error, 304)) return;
      throw asProviderError(error, "container_start");
    }
  }

  /** darwin：建端口转发容器（见文件头）。 */
  async #createForwarder(spec: ValidatedSpec, sandboxName: string, deadline: number): Promise<string> {
    const name = forwardContainerName(spec.labels.sandboxId);
    const body = buildForwarderContainerRequest({
      spec,
      sandboxId: spec.labels.sandboxId,
      networkName: this.#options.networkName,
      targetHost: sandboxName,
    });
    return this.#createContainerWithConflict(name, body, spec.labels.sandboxId, deadline, "forwarder_create");
  }

  /**
   * 等 endpoint 变得可解析。容器启动后网络/端口信息是异步出现的（尤其 darwin 上
   * 端口发布要等 docker-proxy 起来），所以要轮询而不是查一次就认定失败。
   */
  async #waitForEndpoint(containerId: string, deadline: number): Promise<string> {
    let last: EndpointResult | null = null;
    for (;;) {
      const inspect = await this.#inspectById(containerId);
      last = resolveEndpoint(inspect, {
        platform: this.#options.platform,
        networkName: this.#options.networkName,
        port: AGENT_PORT,
      });
      if (last.ok) return last.endpoint;
      if (Date.now() >= deadline) {
        throw new ProviderError("endpoint_unavailable", `拿不到 agent 的地址：${last.detail}`, {
          containerId,
          reason: last.reason,
        });
      }
      await sleep(Math.min(100, this.#options.healthIntervalMs));
    }
  }

  /**
   * 轮询 `/health` 直到 ready。
   *
   * 语义分三种，不能混：
   *  - `ready` → 成功返回
   *  - `starting` → 继续等（agent 起来了但还在初始化）
   *  - `error` → 立刻失败，不用等满预算（agent 明确说自己坏了）
   *  - 连不上 / 非 200 → 继续等（容器可能还在启动）
   *
   * 预算到点 → `health_timeout`，并把最后一次看到的状态带在 details 里——
   * "等了 15 秒还是 starting" 和 "一次都没答话" 是两种完全不同的故障。
   */
  async #waitForReady(
    endpoint: string,
    token: string,
    deadline: number,
  ): Promise<{ status: AgentStatus; version: string | null; activeExecution: string | null }> {
    let lastStatus: AgentStatus | "no_response" = "no_response";
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ProviderError(
          "health_timeout",
          `agent 在 ${this.#options.createTimeoutMs}ms 内没有变成 ready（最后状态：${lastStatus}）`,
          { endpoint, lastStatus },
        );
      }
      const probe = await this.#probeHealth(endpoint, token, Math.min(this.#options.healthProbeTimeoutMs, remaining));
      if (probe !== null) {
        lastStatus = probe.status;
        if (probe.status === "ready") return probe;
        if (probe.status === "error") {
          throw new ProviderError("agent_error", `agent 报告 status=error`, { endpoint });
        }
      }
      await sleep(Math.min(this.#options.healthIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  /** 反向清理。**吞掉所有异常**：清一个已经没了的容器会 404，那不是新错误。 */
  async #rollback(input: {
    sandboxId: string;
    containerIds: Array<string | null>;
    volumeName: string;
    volumeCreated: boolean;
  }): Promise<void> {
    for (const containerId of input.containerIds) {
      if (containerId === null) continue;
      try {
        await this.#removeContainerById(containerId);
      } catch (error) {
        this.#log("warn", `回滚时删容器失败（留给对账）`, {
          sandboxId: input.sandboxId,
          containerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!input.volumeCreated) return;
    try {
      await this.#removeVolume(input.volumeName);
    } catch (error) {
      this.#log("warn", `回滚时删卷失败（留给对账）`, {
        sandboxId: input.sandboxId,
        volume: input.volumeName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------- 查询与删除的零件

  /** GET /containers/{name}/json；404 → null。 */
  async #inspectByName(name: string): Promise<DockerContainerInspect | null> {
    try {
      return await this.docker.json<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(name)}/json`, {
        timeoutMs: this.#options.requestTimeoutMs,
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw asProviderError(error, "container_inspect");
    }
  }

  /** GET /containers/{id}/json；404 也当异常——id 是我们刚拿到的，不该消失。 */
  async #inspectById(containerId: string): Promise<DockerContainerInspect> {
    try {
      return await this.docker.json<DockerContainerInspect>("GET", `/containers/${containerId}/json`, {
        timeoutMs: this.#options.requestTimeoutMs,
      });
    } catch (error) {
      throw asProviderError(error, "container_inspect");
    }
  }

  /**
   * 按名字找到"我们的"容器；不是我们的或不存在都返回 null。
   * destroy 用这个来决定"要不要动它"——**绝不删不属于自己的容器**。
   */
  async #isOursByName(name: string, sandboxId: string): Promise<DockerContainerInspect | null> {
    const inspect = await this.#inspectByName(name);
    if (inspect === null || !isOwnedBy(inspect, sandboxId)) return null;
    return inspect;
  }

  /** 按名字删容器，名字不是我们的就跳过（返回 false）。 */
  async #removeContainerByName(name: string, sandboxId: string, options: { force: boolean }): Promise<boolean> {
    const inspect = await this.#isOursByName(name, sandboxId);
    if (inspect === null) return false;
    await this.#removeContainerById(inspect.Id, options);
    return true;
  }

  /** DELETE /containers/{id}?force=1。404 当作成功（幂等）。 */
  async #removeContainerById(containerId: string, options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker.json("DELETE", `/containers/${containerId}`, {
        query: { force: options.force === false ? 0 : 1 },
        timeoutMs: this.#options.requestTimeoutMs,
      });
    } catch (error) {
      if (isNotFound(error)) return;
      throw asProviderError(error, "container_remove");
    }
  }

  /**
   * POST /containers/{id}/stop?t=10。
   * 304（已经停了）与 404（已经不在了）都当成功：对账会重复调它。
   */
  async #stopContainer(containerId: string): Promise<void> {
    try {
      await this.docker.json("POST", `/containers/${containerId}/stop`, {
        query: { t: 10 },
        // stop 的耗时上限就是那个 10 秒，请求超时必须比它大，否则我们会先超时、
        // 然后在容器真的停下之前就断言"删不掉"。
        timeoutMs: 20_000,
      });
    } catch (error) {
      if (isDockerError(error, 304) || isNotFound(error)) return;
      throw asProviderError(error, "container_stop");
    }
  }

  /**
   * 删卷。404 当成功；409（还有容器在用）记警告后**返回**——这不是异常，
   * 而是"有一件事没做完"，留给下一次对账。把它抛出去会让整个 destroy 被判定为失败，
   * 而实际上容器已经删了、沙箱也确实不可用了。
   */
  async #removeVolume(volumeName: string): Promise<void> {
    try {
      await this.docker.json("DELETE", `/volumes/${encodeURIComponent(volumeName)}`, {
        timeoutMs: this.#options.requestTimeoutMs,
      });
    } catch (error) {
      if (isNotFound(error)) return;
      if (isDockerError(error, 409)) {
        this.#log("warn", `卷 ${volumeName} 还在被使用，删不掉（留给下次对账）`);
        return;
      }
      throw asProviderError(error, "volume_remove");
    }
  }

  // -------------------------------------------------------------- agent 探活

  /**
   * 探一次 `/health`。
   *
   * 返回 `null` = **连不上或不是我们认识的响应**（调用方按 unreachable 处理）；
   * 返回对象 = agent 答话了（status 是它说的）。
   * 这个区分很重要：`starting` 值得再等一等，`unreachable` 是容器层面的问题。
   */
  async #probeHealth(
    endpoint: string,
    token: string,
    timeoutMs: number,
  ): Promise<{ status: AgentStatus; version: string | null; activeExecution: string | null } | null> {
    try {
      const response = await fetch(`${endpoint}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as AgentHealthPayload;
      const status = payload.status;
      if (status !== "ready" && status !== "starting" && status !== "error") {
        // 认不出就当作 error：它答话了，但说的不是我们约定的东西。
        return { status: "error", version: null, activeExecution: null };
      }
      return {
        status,
        version: typeof payload.version === "string" ? payload.version : null,
        activeExecution: typeof payload.activeExecution === "string" ? payload.activeExecution : null,
      };
    } catch {
      // 连接被拒 / 超时 / DNS：都算"还没答话"。
      return null;
    }
  }

  /**
   * 某个沙箱的 agent 地址。darwin 上要问转发容器要端口，Linux 上问沙箱容器要 IP。
   * 沙箱容器不在时返回失败（调用方按 unreachable 处理，不抛）。
   */
  async #endpointForInspect(
    sandboxId: string,
    sandboxInspect: DockerContainerInspect,
  ): Promise<EndpointResult> {
    if (this.#options.platform === "darwin") {
      const forwarder = await this.#inspectByName(forwardContainerName(sandboxId));
      if (forwarder === null) {
        return { ok: false, reason: "published_port_missing", detail: `转发容器 ${forwardContainerName(sandboxId)} 不存在` };
      }
      return resolveEndpoint(forwarder, {
        platform: "darwin",
        networkName: this.#options.networkName,
        port: AGENT_PORT,
      });
    }
    return resolveEndpoint(sandboxInspect, {
      platform: this.#options.platform,
      networkName: this.#options.networkName,
      port: AGENT_PORT,
    });
  }

  #log(level: ProviderLogLevel, message: string, details?: Record<string, unknown>): void {
    this.#options.log(level, message, details);
  }
}

// ---------------------------------------------------------------- 零件

/**
 * 把任意错误翻译成 `ProviderError`。**所有失败路径都要经过它**，
 * 这样调用方永远只需要看 `reason`，不用去猜错误是谁抛的。
 *
 * `DockerUnavailableError` 必须排在 `DockerApiError` 前面：前者是"daemon 不在"，
 * 后者是"daemon 拒绝了这个请求"，处理方式完全不同。
 */
export function asProviderError(error: unknown, step?: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DockerUnavailableError) {
    return new ProviderError("docker_unavailable", error.message, { step, socketPath: error.socketPath });
  }
  if (isTimeoutError(error)) {
    return new ProviderError("create_timeout", `docker API 调用超时${step === undefined ? "" : `（${step}）`}`, {
      step,
    });
  }
  if (error instanceof Error) {
    const apiStatus = (error as { status?: unknown }).status;
    return new ProviderError("docker_error", error.message, {
      step,
      ...(typeof apiStatus === "number" ? { status: apiStatus } : {}),
    });
  }
  return new ProviderError("docker_error", String(error), { step });
}

/**
 * 建共用内网（幂等）。**导出**是因为它不是沙箱的私事：Phase 6 的 egress-proxy 必须挂在
 * 同一张网络上才能被沙箱用 `reuben-cloud-proxy` 找到，而网络校验不能有第二份实现。
 *
 * 已存在时**校验它真的是 internal**：如果名字被一个普通 bridge 网络占了，这里必须失败
 * 而不是"能用就行"——用错网络的后果是沙箱直接能上公网，而这件事在功能测试里完全看不出来。
 */
export async function ensureInternalNetwork(
  docker: DockerClient,
  networkName: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  try {
    await docker.json("POST", "/networks/create", {
      body: {
        Name: networkName,
        Driver: "bridge",
        Internal: true, // ← 没有出口路由。整个隔离模型的地基。
        Labels: { [LABEL_MANAGED]: "true", [LABEL_ROLE]: "internal-network" },
      },
      timeoutMs: options.timeoutMs,
    });
    return;
  } catch (error) {
    if (!isDockerError(error, 409)) throw asProviderError(error, "network_create");
  }

  // 409 = 已经存在。查它的属性，而不是假设它是对的。
  let info: DockerNetworkInfo;
  try {
    info = await docker.json<DockerNetworkInfo>("GET", `/networks/${encodeURIComponent(networkName)}`, {
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw asProviderError(error, "network_inspect");
  }
  if (info.Internal !== true || (info.Driver ?? "") !== "bridge") {
    throw new ProviderError(
      "network_conflict",
      `网络 ${networkName} 已存在，但它不是 internal bridge（Internal=${String(info.Internal)}, Driver=${String(info.Driver)}）。` +
        `它是沙箱隔离的地基，不能将就。`,
      { network: networkName, internal: info.Internal, driver: info.Driver },
    );
  }
}

/**
 * 标签里的角色 → 强类型的角色。认不出的值一律当 `sandbox`（Phase 5 的旧行为），
 * 但三个已知角色必须显式列出：对账（Phase 8）靠它区分"沙箱本体 / 端口转发 / 出网代理"，
 * 把代理误当成沙箱会产生一类很难查的"对账总是删掉自己的基础设施"故障。
 */
function toContainerRole(value: string | undefined): ContainerRole {
  if (value === "port-forward" || value === "egress-proxy") return value;
  return "sandbox";
}

/** `AbortSignal.timeout()` 与 fetch 超时都会抛这两种名字的错误。直接复用 docker-api 的判据，
 * 免得"什么算超时"在两层里有两种定义。 */
/** 容器是不是我们的、且属于这个 sandboxId。两个条件都要满足。 */
function isOwnedBy(inspect: DockerContainerInspect, sandboxId: string): boolean {
  const labels = inspect.Config?.Labels ?? {};
  return labels[LABEL_MANAGED] === "true" && labels[LABEL_SANDBOX_ID] === sandboxId;
}

/** 从容器的 `Config.Env` 里把 token 读回来（CP 重启后继续跟老沙箱说话的唯一办法）。 */
function readTokenFromInspect(inspect: DockerContainerInspect): string {
  const entry = (inspect.Config?.Env ?? []).find((item) => item.startsWith("SANDBOX_AGENT_TOKEN="));
  return entry === undefined ? "" : entry.slice("SANDBOX_AGENT_TOKEN=".length);
}

/**
 * 剩余预算，作为这次 Docker 调用的超时。
 * 下限 1000ms：预算只剩 0 时也给它一秒钟去把错误说清楚，而不是立刻抛一个
 * 无法分辨来源的超时。
 */
function budgetTimeout(deadline: number): number {
  return Math.max(1_000, deadline - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 默认日志：warn 打到 stderr，info 丢弃。CP 有正式 logger 之前够用，测试可注入记录器。 */
function defaultLog(level: ProviderLogLevel, message: string, details?: Record<string, unknown>): void {
  if (level !== "warn") return;
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.warn(`[local-docker] ${message}${suffix}`);
}
