/**
 * sandbox-agent 的对外契约（HTTP + SSE）。
 *
 * 有意与 CP 侧的 types 重复、不共享包：两层之间只有 HTTP 契约，
 * 共享类型会让「沙箱加一个字段」变成「CP 被迫重新编译」（spec §0.4）。
 *
 * 【读法】这个文件全是"类型"，不含任何会执行的代码。TS 的类型只活到编译期，
 * 跑起来之后就跟注释一样没了——所以改类型不会改变运行时行为，改错了只能靠
 * `npm run typecheck` 抓出来。
 */

/** 健康状态三值。Phase 1 实际只会返回 "ready"（见 server.ts 的 healthPayload）。 */
export type HealthStatus = "starting" | "ready" | "error";

/** `GET /health` 的响应体。CP 用它做就绪探针 + 查有没有在跑的执行。 */
export interface HealthResponse {
  /** 当前状态。 */
  status: HealthStatus;
  /** agent 的版本号，来自 config.ts 的 VERSION。 */
  version: string;
  /** 当前占着 BUSY 槽的 execution_id；空闲时为 null。 */
  activeExecution: string | null;
}

/**
 * POST /exec 请求体。全部字段都不可信，一律走 spawn.ts 的校验。
 *
 * 注意 `?` 的含义：这个字段**允许不传**（TS 里叫可选属性），不代表可以不校验。
 * 校验函数会给没传的字段补上默认值。
 */
export interface ExecRequest {
  /** 必填。argv 数组。**没有隐式 shell**：`["npm","test"]` 不等于 `"npm test"`。 */
  cmd: string[];
  /** 必须落在 workspace 根之内（paths.ts 校验）；不传则默认是 root 本身。 */
  cwd?: string;
  /** 叠加在固定最小环境集合之上的额外变量。只放非敏感配置——沙箱里没有凭据可传。 */
  env?: Record<string, string>;
  /** 超时毫秒数。默认 120s，硬上限 600s（超上限返回 400，不静默截断）。 */
  timeoutMs?: number;
  /** 内联事件流的字节预算，默认 1 MiB。超出的内容只进日志文件，不进事件流。 */
  maxOutputBytes?: number;
}

/** `POST /exec` 成功时的响应体。HTTP 状态码是 202（已受理，**不代表已执行完**）。 */
export interface ExecAcceptedResponse {
  /** 本次执行的 id，形如 `exe_01H...`。后面查事件、kill 都用它。 */
  execution_id: string;
  /** 完整日志文件路径。事件流被截断时，CP 拿这个路径去读全文。 */
  log_path: string;
}

/** `POST /exec/{id}/kill` 的响应体。 */
export interface KillResponse {
  execution_id: string;
  /** "killing" 表示已发出终止信号；其余取值即终态（幂等语义）。 */
  status: "killing" | TerminalStatus;
}

/** 终态四种，互斥。退出码非 0 是 completed，不是 failed——判断成败是 CP 的事。 */
export type TerminalStatus = "completed" | "failed" | "timeout" | "killed";

/**
 * 事件流里会出现的事件名，一共 8 种（4 个过程事件 + 4 个终态事件）。
 * 终态事件之后事件流就关闭，不会再有任何事件。
 *
 *  - started   = 进程已经 fork 出来（spawn 失败前也会发一次，见 spawn.ts）
 *  - stdout    = 标准输出的一个文本块（已合并，≤64KiB 或 100ms 一块）
 *  - stderr    = 标准错误的一个文本块（与 stdout 各自独立合并）
 *  - truncated = 有内容没进事件流（输出超预算 / 日志超上限 / 重放有空洞）
 *  - 四种终态  = 见 TerminalStatus
 *
 * 【TS 提示】这不是枚举，是"字符串联合类型"：本质是"只允许这几个字符串字面量"。
 * 写成 `TerminalStatus` 是把上面四种终态也并进来，等于一次声明 8 种取值。
 */
export type ExecEventType = "started" | "stdout" | "stderr" | "truncated" | TerminalStatus;

/** `started` 事件的数据。告诉 CP「命令真的起来了、pid 是多少、在哪儿跑的」。 */
export interface StartedEventData {
  execution_id: string;
  /** spawn 失败（ENOENT）时 Node 不给 pid，此时为 null。 */
  pid: number | null;
  /** ISO 8601 格式的启动时刻，例如 "2026-09-12T03:00:00.123Z"。 */
  ts: string;
  /** 实际生效的工作目录（已解析符号链接）。 */
  cwd: string;
  /** 实际执行的 argv，原样回显，便于对账。 */
  cmd: string[];
}

/** `stdout` / `stderr` 事件的数据。chunk 是**文本**，不是二进制。 */
export interface OutputEventData {
  /** 合并后的文本块。最大 chunkBytes（默认 64 KiB），多字节字符不会被切断。 */
  chunk: string;
}

/** 触发了 truncated 事件的三种原因。 */
export type TruncatedReason = "output_limit" | "log_limit" | "replay_gap";

/** `truncated` 事件的数据。三种原因对应三个不同的"去哪儿找完整内容"。 */
export interface TruncatedEventData {
  reason: TruncatedReason;
  /** output_limit / log_limit：触发上限。 */
  limit?: number;
  /** replay_gap：客户端带来的 Last-Event-ID。 */
  from_id?: number;
  /** 完整内容（或缺失的那一段）在哪个日志文件里——CP 拿它去读文件补全。 */
  log_path: string;
}

/** 四种终态事件共用的数据。字段有重叠是故意的——CP 只解一次结构。 */
export interface TerminalEventData {
  /** 进程退出码；被信号杀死时为 null。 */
  exit_code: number | null;
  /** 杀死进程的信号名（如 "SIGTERM"）；正常退出时为 null。 */
  signal: string | null;
  /** 从 spawn 到终态的真实耗时（毫秒）。 */
  duration_ms: number;
  /** 进程实际产出的原始字节数（不是字符数），与日志文件长度一致。 */
  stdout_bytes: number;
  stderr_bytes: number;
  /** 事件流是否因超过 maxOutputBytes 丢过内容（完整内容在 log_path）。 */
  truncated: boolean;
  /** 日志文件是否因超过 MAX_LOG_BYTES 提前封口。 */
  log_truncated: boolean;
  log_path: string;
  /** 仅 timeout。 */
  timeout_ms?: number;
  /** 仅 failed：spawn 失败的结构化原因（ENOENT 等）。 */
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------- Phase 2：文件 API

/** 一个文件条目的类型。`other` = FIFO / socket / 设备这种既不是普通文件也不是目录的东西。 */
export type FileEntryType = "file" | "dir" | "symlink" | "other";

/** `GET /files` 支持的内容编码。不做二进制探测，用哪个由调用方说了算。 */
export type FileReadEncoding = "utf8" | "base64";

/**
 * `GET /files` 的 JSON 响应（`encoding=utf8` 与 `base64` 长同一个形状）。
 *
 * 注意三个尺寸/哈希字段不是一回事：`size` 是文件总字节数，`bytes` 是本次返回的字节数，
 * `sha256` 只覆盖**本次返回的那段字节**——范围读时算全文哈希没有意义。
 */
export interface FileReadResponse {
  /** 解析符号链接之后的绝对路径。CP 之后要读别的范围就原样传回来。 */
  path: string;
  /** 文件总字节数（不是本次返回的长度）。 */
  size: number;
  /** 本次返回内容的 sha256（十六进制小写）。 */
  sha256: string;
  /** `content` 用哪种编码。 */
  encoding: FileReadEncoding;
  /** 本次读取的起始字节偏移。 */
  offset: number;
  /** 本次返回的字节数（utf8 时等于 `Buffer.byteLength(content)`）。 */
  bytes: number;
  /** 内容本体。`base64` 时是原字节的 base64，不做任何猜测。 */
  content: string;
}

/** `PUT /files` 的响应体。CP 拿 sha256 校验灌入的 tar 完整。 */
export interface FileWriteResponse {
  /** 写入之后的绝对路径（原子 rename 的落点）。 */
  path: string;
  /** 实际收到的字节数。 */
  size: number;
  /** 写入内容的 sha256（十六进制小写）。 */
  sha256: string;
}

/** `GET /files/list` 里的一项。 */
export interface FileEntry {
  /**
   * `depth=1` 时是文件名；`depth>1` 时是**相对本次请求路径**的相对路径（如 `src/a.ts`），
   * 不带前导 `/`。客户端要绝对路径就自己与响应的 `path` 拼。
   */
  name: string;
  type: FileEntryType;
  /** lstat 的 size（符号链接就是链接本体的长度，因为不跟随）。 */
  size: number;
  /** mtime，毫秒时间戳。 */
  mtime: number;
}

/**
 * `GET /files/list` 的响应。故意是对象而不是裸数组：`truncated` 需要一个落点。
 */
export interface FileListResponse {
  /** 被列出目录的绝对路径（符号链接已解析）。 */
  path: string;
  entries: FileEntry[];
  /** 是否因为超过条目上限而没列完（截掉的是条目，不是内容）。 */
  truncated: boolean;
}

/**
 * 所有非 2xx 响应的统一形状。
 * 典型 error 取值：unauthorized / not_found / busy / invalid_cmd / invalid_cwd /
 * path_out_of_bounds / invalid_env / invalid_timeout / timeout_exceeds_max /
 * invalid_max_output_bytes / body_too_large / invalid_json / shutting_down /
 * internal_error；文件 API 另有 missing_path / invalid_path / invalid_range /
 * invalid_encoding / invalid_raw / invalid_depth / invalid_content_type /
 * is_directory / not_a_file / not_directory / invalid_utf8 / too_large /
 * upload_aborted / permission_denied。CP 靠 `error` 字段分支，不靠 HTTP 状态码猜。
 */
export interface ErrorResponse {
  /** 机器可读的错误码，CP 按它决定怎么处理。 */
  error: string;
  /** 人类可读的补充说明，可能没有。 */
  message?: string;
  /**
   * 允许塞额外的结构化字段：busy 会带 activeExecution，超限会带 limit。
   *
   * 【TS 提示】这叫"索引签名"：意思是"除了上面写明的字段，还允许任意其他 key"。
   * 值类型是 unknown，所以读出来必须先判断类型才能用。
   */
  [key: string]: unknown;
}
