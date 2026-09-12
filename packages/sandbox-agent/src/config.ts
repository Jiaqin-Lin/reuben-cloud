/**
 * 启动配置：全部来自环境变量，全部显式。
 *
 * 两条原则：
 *  1) 没有默认 token。缺失就退出——镜像里写个默认 token 等于所有沙箱共用一个公开凭据。
 *  2) 子进程环境**不继承** agent 自己的 process.env（见 spawn.ts buildEnv）。
 *     这里配置的 basePath/home/lang/term 就是那份固定集合的来源。
 */

export const VERSION = "0.0.1";

/** 单条命令默认 / 硬上限（§C.2、§D）。超上限不静默截断，直接 400。 */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

/** 内联事件总量上限（超出部分只进日志文件）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const MAX_MAX_OUTPUT_BYTES = 268_435_456;

/** 输出合并：≥64KiB 或 ≥100ms 就 flush（§C.2）。 */
export const DEFAULT_CHUNK_BYTES = 65_536;
export const DEFAULT_FLUSH_INTERVAL_MS = 100;

/** 事件环形缓冲：1000 条或 1 MiB，先到为准（§C.2）。 */
export const DEFAULT_EVENT_BUFFER_MAX_EVENTS = 1000;
export const DEFAULT_EVENT_BUFFER_MAX_BYTES = 1_048_576;

/**
 * 单次执行日志上限。日志落在 tmpfs 上，tmpfs 页面计入 cgroup 内存，
 * 不设上限时一个 `yes` 就能把容器自己 OOM 掉（附录 A-9）。
 */
export const DEFAULT_MAX_LOG_BYTES = 268_435_456;

/** 心跳：空闲超过 15s 发一行注释帧，防止中间层掐掉长连接。 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** 超时/主动 kill 的优雅窗口：SIGTERM → 5s → SIGKILL 进程组（§D）。 */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * 直接子进程退出后，等待 stdout/stderr 见 EOF 的宽限期。
 *
 * 为什么需要它：后台进程（`nohup ./dev-server &`）会继承管道写端，
 * 于是子进程 exit 之后管道**永远不会** EOF。等它就会让终态事件永远不发。
 * 宽限期内数据已经全部送达，到点强拆读端，终态照常发——§C.2「exec 正常结束时不禁子进程」。
 */
export const DEFAULT_EXIT_DRAIN_MS = 250;

/** 固定最小 PATH：裸跑与容器里都够用（/usr/local/bin 有 node，/usr/bin 有 python3/git）。 */
export const DEFAULT_BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const DEFAULT_HOME = "/tmp/agent";
export const DEFAULT_LANG = "C.UTF-8";
export const DEFAULT_TERM = "dumb";

export interface Config {
  token: string;
  port: number;
  host: string;
  /** 工作区根。裸跑指向临时目录，容器里是 /workspace —— 同一套路径逻辑。 */
  workspaceRoot: string;
  logRoot: string;
  /** 子进程 HOME。agent 启动时 mkdir -p。 */
  home: string;
  basePath: string;
  lang: string;
  term: string;
  maxLogBytes: number;
  eventBufferMaxEvents: number;
  eventBufferMaxBytes: number;
  exitDrainMs: number;
  chunkBytes: number;
  flushIntervalMs: number;
  heartbeatMs: number;
  killGraceMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.SANDBOX_AGENT_TOKEN;
  if (token === undefined || token === "") {
    throw new Error(
      "SANDBOX_AGENT_TOKEN is required (no default token: every sandbox must get its own). " +
        "Refusing to start.",
    );
  }

  return {
    token,
    port: intEnv(env, "SANDBOX_AGENT_PORT", 8080),
    host: env.SANDBOX_AGENT_HOST ?? "127.0.0.1",
    workspaceRoot: env.SANDBOX_WORKSPACE_ROOT ?? "/workspace",
    logRoot: env.SANDBOX_LOG_ROOT ?? "/tmp/reuben-cloud/exec",
    home: env.SANDBOX_AGENT_HOME ?? DEFAULT_HOME,
    basePath: env.SANDBOX_AGENT_BASE_PATH ?? DEFAULT_BASE_PATH,
    lang: env.SANDBOX_AGENT_LANG ?? DEFAULT_LANG,
    term: env.SANDBOX_AGENT_TERM ?? DEFAULT_TERM,
    maxLogBytes: intEnv(env, "SANDBOX_AGENT_MAX_LOG_BYTES", DEFAULT_MAX_LOG_BYTES),
    eventBufferMaxEvents: intEnv(
      env,
      "SANDBOX_AGENT_EVENT_BUFFER_MAX_EVENTS",
      DEFAULT_EVENT_BUFFER_MAX_EVENTS,
    ),
    eventBufferMaxBytes: intEnv(
      env,
      "SANDBOX_AGENT_EVENT_BUFFER_MAX_BYTES",
      DEFAULT_EVENT_BUFFER_MAX_BYTES,
    ),
    exitDrainMs: intEnv(env, "SANDBOX_AGENT_EXIT_DRAIN_MS", DEFAULT_EXIT_DRAIN_MS),
    chunkBytes: intEnv(env, "SANDBOX_AGENT_CHUNK_BYTES", DEFAULT_CHUNK_BYTES),
    flushIntervalMs: intEnv(env, "SANDBOX_AGENT_FLUSH_INTERVAL_MS", DEFAULT_FLUSH_INTERVAL_MS),
    heartbeatMs: intEnv(env, "SANDBOX_AGENT_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
    killGraceMs: intEnv(env, "SANDBOX_AGENT_KILL_GRACE_MS", DEFAULT_KILL_GRACE_MS),
  };
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
