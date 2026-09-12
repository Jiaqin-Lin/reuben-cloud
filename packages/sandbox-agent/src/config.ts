/**
 * 启动配置：全部来自环境变量，全部显式。
 *
 * 两条原则：
 *  1) 没有默认 token。缺失就退出——镜像里写个默认 token 等于所有沙箱共用一个公开凭据。
 *  2) 子进程环境**不继承** agent 自己的 process.env（见 spawn.ts buildEnv）。
 *     这里配置的 basePath/home/lang/term 就是那份固定集合的来源。
 */

// 下面这一片常量分两类，读之前先分清，否则很容易迷惑：
//   DEFAULT_*  = 请求没写这个字段时，用什么值。（"默认档位"）
//   MAX_*      = 请求允许填的最大值，超了直接返回 400，**不是**帮调用方截断。
// 所有 DEFAULT_* 都能被同名环境变量覆盖，覆盖入口在文件末尾的 loadConfig。
// `120_000` 里的下划线是 JS/TS 的数字分隔符，纯粹给人看的，等于 120000。

export const VERSION = "0.0.1";

/** 单条命令默认 / 硬上限（§C.2、§D）。超上限不静默截断，直接 400。 */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

/**
 * 内联事件总量上限（超出部分只进日志文件）。
 * "内联" = 走 SSE 事件流发出去的内容；一个 `npm install` 能刷几百 MB，
 * 不可能全部塞进事件流，所以有这条线。默认 1 MiB，硬上限 256 MiB。
 */
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
/** 子进程的 HOME。注意它和 request 里的 env 合并时，request 里的同名 key 会覆盖它。 */
export const DEFAULT_HOME = "/tmp/agent";
/** C.UTF-8 而不是 zh_CN.UTF-8：容器里没有 locale 数据，能被所有程序接受的通用值只有这个。 */
export const DEFAULT_LANG = "C.UTF-8";
/** `dumb` = 告诉程序"对面不是真终端"，于是它不会输出颜色转义和光标控制序列（否则日志里全是乱码）。 */
export const DEFAULT_TERM = "dumb";

/**
 * 整个 agent 的运行参数。**只有两种方式产生它**：
 *  - 生产：index.ts 里的 loadConfig()（从环境变量读）
 *  - 测试：harness.ts 里 loadConfig(一堆 env) 再用 `{...config, 覆盖项}` 改几个字段
 * 没有任何一处硬编码配置，这是"裸跑和容器里跑同一套逻辑"的前提。
 */
export interface Config {
  /** 鉴权 token。**必填且无默认值**：镜像里写默认 token = 所有沙箱共用一个公开凭据。 */
  token: string;
  /** HTTP 监听端口。测试里传 0 表示"随便给个空闲端口"。 */
  port: number;
  /** 监听地址。默认 127.0.0.1（裸跑）；容器里要设 0.0.0.0 才能被 CP 访问。 */
  host: string;
  /** 工作区根。裸跑指向临时目录，容器里是 /workspace —— 同一套路径逻辑。 */
  workspaceRoot: string;
  /** 执行日志目录，一次执行一个 `{id}.log`。容器里在 tmpfs 上，所以必须限大小。 */
  logRoot: string;
  /** 子进程 HOME。agent 启动时 mkdir -p。 */
  home: string;
  /** 子进程的 PATH。固定值，不继承宿主，理由见 spawn.ts 的 buildEnv。 */
  basePath: string;
  /** 子进程的 LANG。 */
  lang: string;
  /** 子进程的 TERM。 */
  term: string;
  /** 单个日志文件的上限。到顶就停写（但仍继续跑命令），见 logfile.ts。 */
  maxLogBytes: number;
  /** 事件环形缓冲的条数上限。 */
  eventBufferMaxEvents: number;
  /** 事件环形缓冲的字节上限。与上面"先到为准"——两个都超了才淘汰最老的。 */
  eventBufferMaxBytes: number;
  /** 直接子进程退出后，等 stdout/stderr 收到 EOF 的宽限期。后台进程会拖住管道，见 spawn.ts。 */
  exitDrainMs: number;
  /** 输出合并器：单次 flush 的字节阈值。 */
  chunkBytes: number;
  /** 输出合并器：距上次 flush 的毫秒阈值。 */
  flushIntervalMs: number;
  /** SSE 心跳间隔：空闲超过它就发一行注释帧，防止中间代理掐长连接。 */
  heartbeatMs: number;
  /** 杀进程组时 SIGTERM 到 SIGKILL 之间的宽限时间。 */
  killGraceMs: number;
}

/**
 * 环境变量 → Config。
 *
 * @param env 默认取 `process.env`（真实启动）；测试会自己造一个干净的对象传进来，
 *            这样测试行为不随宿主机的环境变量漂移。
 * @throws 缺 token 或某个数值 env 不是非负整数时直接抛。main 里捕获后打印并 exit(1)。
 */
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

/**
 * 读一个数字型环境变量。所有数值配置都走这里，保证校验规则只有一份。
 * 没设 / 空字符串 → 用 fallback；设了但不是非负整数 → 抛（宁可启动失败，不要带着
 * 一个诡异的数字跑起来）。
 */
function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}
