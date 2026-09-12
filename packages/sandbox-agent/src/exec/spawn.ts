/**
 * argv 校验 → 进程组 → 管道接线 → 终态收尾。
 *
 * 这个文件负责的是整个方案里唯一真正有技术风险的部分（§K）：进程组回收、
 * 输出合并、终态与日志落盘的顺序。
 *
 * 三条不能动的规则：
 *  - `shell: false` + argv 数组：注入类 bug 整类消失。要管道就显式写 ["bash","-lc",...]
 *  - `stdio[0] = "ignore"`：没有交互式输入通道。需要交互的程序会立刻读到 EOF 失败——
 *    这是设计边界，不是 bug。
 *  - 终态事件必须在**进程真的死了、日志真的落盘之后**才发。
 *
 * 【在链路中的位置】registry.start() 校验完就调 startProcess()；之后所有"进程发生了什么"
 * 都从这个文件流出去。对外只导出四个东西：validateExecRequest / startProcess /
 * requestKill / buildEnv。内部的 finalize / maybeComplete 是这个文件的私事。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  type Config,
} from "../config.ts";
import type { RootResolver } from "../paths.ts";
import type { ErrorResponse, TerminalEventData, TerminalStatus } from "../types.ts";
import { OutputMerger } from "./output.ts";
import type { ExecutionRecord } from "./registry.ts";
import { escalateKill, scheduleTimeout } from "./timeout.ts";

/**
 * 校验**通过之后**的请求。和 ExecRequest 的差别就一件事：可选字段全部被填上了默认值。
 * 之后的所有代码（建记录、spawn）都只认这个类型，不再判 undefined。
 * 这也是“先把外部输入洗成内部类型，再往下传”这个套路的体现。
 */
export interface ValidatedExecRequest {
  /** 已确认非空、且每个元素都是 string 的 argv。 */
  cmd: string[];
  /** 已经过 paths.ts 校验与符号链接解析的绝对路径（保证在 workspace 根之内）。 */
  cwd: string;
  /** 请求里带的额外环境变量（不含 buildEnv() 会补的那个固定最小集合）。 */
  env: Record<string, string>;
  /** 已确认是正整数且 ≤ MAX_TIMEOUT_MS。 */
  timeoutMs: number;
  /** 已确认是 1..MAX_MAX_OUTPUT_BYTES 之间的整数。 */
  maxOutputBytes: number;
}

/**
 * 校验结果。失败时直接带上要返回给 CP 的响应体。
 *
 * 【TS 提示】这是个“可辨识联合类型”（discriminated union）：两个分支用 `ok` 字段区分。
 * 调用方 `if (!result.ok)` 之后，TS 就自动知道能访问 `result.body`——这是 TS 里最常见
 * 的“带错误信息的返回值”写法，比抛异常好：错误是正常流程，不应该用异常传递。
 */
export type ValidationResult =
  | { ok: true; request: ValidatedExecRequest }
  | { ok: false; body: ErrorResponse };

/**
 * 把不可信的 HTTP body 校验成一个可用的请求。
 * **所有入口都必须过这里**（包括未来 Phase 2 的文件 API，它们也用同一个 root 校验）。
 *
 * 校验风格：只要有一个字段不对就立即返回 400，**不做部分接受、不做静默截断**。
 * 错误码区分得很细，因为 CP 的错误处理分支要区分它们——
 * “越界”（策略违规）和“root 之内但不存在”（运行期事实）必须是两个不同的码。
 *
 * @param raw `JSON.parse` 的结果，类型是 unknown——因为解析出来的东西根本无法保证形状
 * @throws 本函数不抛异常，所有失败都通过返回值表达
 */
export function validateExecRequest(
  raw: unknown,
  config: Config,
  roots: RootResolver,
): ValidationResult {
  // 第一关：必须是个普通对象。Array.isArray 要单独判，因为 typeof [] === "object"。
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("invalid_body", "request body must be a JSON object");
  }
  // 断言成 Record<string, unknown>：只是告诉 TS“我要按字典取字段了”，
  // 不代表它真的是——所以下面每个字段都还在逐个判类型。
  const body = raw as Record<string, unknown>;

  // 第二关：cmd 必须是“非空的纯字符串数组”。空数组会让 argv[0] 取不到；
  // 元素不是字符串或者带 NUL 字节都是非法输入（NUL 会被底层 C 接口截断）。
  const cmd = body.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0) {
    return invalid("invalid_cmd", "cmd must be a non-empty array of strings (argv, not a shell string)");
  }
  for (const part of cmd) {
    if (typeof part !== "string") return invalid("invalid_cmd", "every cmd element must be a string");
    if (part.includes("\0")) return invalid("invalid_cmd", "cmd must not contain NUL bytes");
  }
  if (cmd[0] === "") return invalid("invalid_cmd", "cmd[0] must not be empty");

  // 第三关：cwd。不传就默认用 workspace 根（大多数场景 CP 不传）。
  // 下面所有“越界 / 不存在”的区分都发生在这里，且只发生这一次。
  let cwd = roots.realRoot;
  if (body.cwd !== undefined) {
    const resolved = roots.resolve(body.cwd);
    if (!resolved.ok) {
      if (resolved.reason === "out_of_bounds") {
        return {
          ok: false,
          body: { error: "path_out_of_bounds", message: `cwd must stay inside ${roots.realRoot}` },
        };
      }
      return invalid("invalid_cwd", `cwd is not usable: ${resolved.reason}`);
    }
    // 注意：越界是策略违规（400），root 之内但磁盘上不存在是运行期事实（→ failed 事件）。
    // 这个区分决定了 CP 的错误处理分支，不要合并它们。
    cwd = resolved.abs;
  }

  // 第四关：env。只能传 string → string，否则拒绝。
  // 注意这里**不校验** key 的合法性（比如不能以数字开头），那是调用方的事；
  // 沙箱不负责当 shell，它只管“别把非法字节交给 spawn”。
  const env: Record<string, string> = {};
  if (body.env !== undefined) {
    if (body.env === null || typeof body.env !== "object" || Array.isArray(body.env)) {
      return invalid("invalid_env", "env must be an object of string values");
    }
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof value !== "string") return invalid("invalid_env", `env.${key} must be a string`);
      if (key.includes("\0") || value.includes("\0")) {
        return invalid("invalid_env", `env.${key} must not contain NUL bytes`);
      }
      env[key] = value;
    }
  }

  // 第五关：超时。三道门：是正整数、不超过硬上限；没传就用默认值。
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    const value = body.timeoutMs;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return invalid("invalid_timeout", "timeoutMs must be a positive integer");
    }
    if (value > MAX_TIMEOUT_MS) {
      // 不静默截断：静默截断会让调用方以为自己拿到了 30 分钟。
      return {
        ok: false,
        body: { error: "timeout_exceeds_max", limit: MAX_TIMEOUT_MS },
      };
    }
    timeoutMs = value;
  }

  // 第六关：内联输出预算。和超时不一样：这里超上限直接算“参数不合法”。
  let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
  if (body.maxOutputBytes !== undefined) {
    const value = body.maxOutputBytes;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_MAX_OUTPUT_BYTES) {
      return invalid("invalid_max_output_bytes", `maxOutputBytes must be an integer in 1..${MAX_MAX_OUTPUT_BYTES}`);
    }
    maxOutputBytes = value;
  }

  // `cmd as string[]`：上面已经逐个检查过每个元素都是字符串了，但 TS 推不出来，
  // 所以要手动断言一下。这是“我已经亲自验过了”的标记，不能随便用。
  return { ok: true, request: { cmd: cmd as string[], cwd, env, timeoutMs, maxOutputBytes } };
}

/**
 * 真正把进程跑起来，并把 stdout/stderr/exit/error 四条线全部接到事件总线上。
 * 同步返回（不阻塞请求）——命令跑多久跟这个函数无关了。
 *
 * @param record 已经建好的状态记录（日志文件、事件总线都已经在里面）
 * @param config 只读配置
 *
 * 这个函数只被 registry.start() 调一次。上面校验、下面接线，中间就是这一次 spawn。
 */
export function startProcess(record: ExecutionRecord, config: Config): void {
  let child: ChildProcess;
  // 注意 spawn 的两种失败方式不一样，这是 Node 的老坑：
  //  - 参数级错误（cwd 不存在、env 里有非法值）→ 同步抛异常，走 catch
  //  - 命令不存在（ENOENT）→ 不抛，而是异步发 'error' 事件（见下面）
  try {
    child = spawn(record.cmd[0]!, record.cmd.slice(1), {
      cwd: record.cwd,
      env: buildEnv(record.env, config),
      detached: true, // ← 关键：子进程成为进程组组长（setsid）
      stdio: ["ignore", "pipe", "pipe"],
      shell: false, // ← 默认值，但写出来
    });
  } catch (err) {
    record.spawnError = { message: (err as Error).message };
    // `void` 的意思是“我知道这是 Promise，故意不等它”——收尾有自己的状态机，
    // 这里等它会卡住 HTTP 响应；终态会异步发到事件流里。
    void finalize(record, config);
    return;
  }

  // 注意：即使 spawn 失败（ENOENT），child 对象也是存在的，只是 pid 为 undefined。
  record.child = child;
  // `??` 是 null 合并运算符：只有左侧是 null/undefined 才取右侧。
  // 不用 `||`：这里碰巧效果一样，但 `||` 会把 0 和 "" 也当成“空”而错误地取右侧。
  record.pid = child.pid ?? null;
  // started 事件在创建合并器之前就发：CP 最早收到的一个事件永远是它，
  // 它承担“命令真的起来了”这个信号（也包括“起不来但 pid 是 null”的情况）。
  record.bus.publish("started", {
    execution_id: record.id,
    pid: record.pid,
    ts: new Date().toISOString(),
    cwd: record.cwd,
    cmd: record.cmd,
  });

  // 两个流各一个合并器，互相独立（合并在一起就分不清哪句话是谁说的了）。
  // 回调里把文本交给 emitChunk——它负责第二个预算：inlineBytes 上限。
  const out = new OutputMerger({
    chunkBytes: config.chunkBytes,
    flushIntervalMs: config.flushIntervalMs,
    onChunk: (text, bytes) => emitChunk(record, "stdout", text, bytes),
  });
  const err = new OutputMerger({
    chunkBytes: config.chunkBytes,
    flushIntervalMs: config.flushIntervalMs,
    onChunk: (text, bytes) => emitChunk(record, "stderr", text, bytes),
  });
  record.mergers = { out, err };

  // `!` 非空断言：上面 stdio 写死了两个 "pipe"，所以这两个可空字段运行时必然有值。
  const stdout = child.stdout!;
  const stderr = child.stderr!;
  // 每收到一块数据，三处同时写：
  //   ① 字节计数（终态事件要报） ② 日志文件（完整内容） ③ 合并器→事件流（截断版）
  // 注意顺序：计数和日志都是先写，无论后面事件流截不截断，日志都是全的。
  stdout.on("data", (buf: Buffer) => {
    record.stdoutBytes += buf.length;
    record.log.write(buf);
    out.push(buf);
  });
  stderr.on("data", (buf: Buffer) => {
    record.stderrBytes += buf.length;
    record.log.write(buf);
    err.push(buf);
  });
  // 两个流分别 EOF。注意“两路都 EOF”只是终态的**必要条件之一**，
  // 还得等子进程真的 exit——所以每件事都调一次 maybeComplete 去评估状态。
  stdout.on("end", () => {
    record.stdoutEnded = true;
    out.end();
    maybeComplete(record, config);
  });
  stderr.on("end", () => {
    record.stderrEnded = true;
    err.end();
    maybeComplete(record, config);
  });

  child.on("error", (error: Error) => {
    // ENOENT 走这条路：spawn 本身不抛，且不会有 exit 事件。
    record.spawnError = { code: (error as NodeJS.ErrnoException).code, message: error.message };
    void finalize(record, config);
  });

  // exit = 直接子进程没了。但“输出收完没”是另一件事（见 maybeComplete），
  // 所以这里只记结果，不直接定终态。
  child.on("exit", (code, signal) => {
    record.childExited = true;
    record.exitCode = code;
    record.signal = signal;
    maybeComplete(record, config);
  });

  // 超时定时器。它只是“到点调 requestKill”，真正的下降测试在 kill 那一路。
  if (record.timeoutMs > 0) {
    record.timers.timeout = scheduleTimeout(record.timeoutMs, () => {
      requestKill(record, "timeout", config);
    });
  }
}

/**
 * 请求杀掉一个执行（超时、/kill、优雅退出都走这里）。
 * SIGTERM → 5s → SIGKILL，整组。幂等：已经在终态就直接返回。
 *
 * @param reason 先发生的终止原因说了算——被 /kill 之后又撞上超时，终态是 killed。
 *
 * 注意本函数**不发终态事件**：它只是把 SIGTERM 发出去，剩下的等进程真的死了
 * 由 maybeComplete → finalize 处理。因为“信号发出去了”不等于“进程死了”，
 * 直接发 killed 会让 CP 在进程还在写日志的时候就去读日志。
 */
export function requestKill(
  record: ExecutionRecord,
  reason: "killed" | "timeout",
  config: Config,
): void {
  if (record.status !== "running" || record.finishing) return;
  if (record.killReason === null) record.killReason = reason; // 先发生的终止原因说了算

  // 已经在杀它了，超时定时器没意义了，拆掉免得它到点又来调一次。
  record.timers.timeout?.cancel();
  record.timers.timeout = undefined;

  // 已经攒在合并器里的输出立刻冲出去，不等 100ms 窗口。
  // （下面两个 `?.` 是可选链：合并器可能还没建好就失败了，那时直接跳过。）
  record.mergers?.out.flush();
  record.mergers?.err.flush();

  // 只在“还没开始升级”的时候启动升级链：重复调 requestKill 不应该反复发 SIGTERM。
  if (record.pid !== null && record.timers.escalation === undefined) {
    record.timers.escalation = escalateKill(record.pid, config.killGraceMs);
  }
}

/**
 * 唯一的收尾函数：把执行定成终态。
 *
 * 三步的顺序是整个文件最重要的一行：
 *  1. 先把合并器里残留的输出吐干净（end()）——终态事件必须排在所有内容事件之后
 *  2. await 日志落盘
 *  3. 发终态事件 → 关事件总线 → 释放 BUSY 槽 → resolve #finished
 *
 * `record.finishing` 是幂等锁：exit / error / drain 三条路可能同时进来，
 * 谁先置上它谁负责收尾，其他人直接返回。
 */
async function finalize(record: ExecutionRecord, config: Config): Promise<void> {
  if (record.finishing) return;
  record.finishing = true;
  clearTimers(record);

  // 先吐干净残留输出，再定终态——终态事件必须排在所有内容事件之后。
  record.mergers?.out.end();
  record.mergers?.err.end();

  const status: TerminalStatus =
    // 优先级：spawn 失败 > 被杀的原因 > 正常结束。
    record.spawnError !== null ? "failed" : (record.killReason ?? "completed");
  record.status = status;
  record.endedAt = Date.now();

  // 日志落盘之后才发终态：CP 一收到终态事件就会去读 log_path。
  await record.log.end();

  // 先发终态事件，再关总线（反过来的话这条事件发不出去）。
  record.bus.publish(status, terminalData(record, status));
  record.bus.close();
  // 这两步在总线关闭之后：释放 BUSY 槽（否则沙箱永久 409）、resolve shutdown 的等待。
  record.onFinish?.();
  record.resolveFinished();
}

/**
 * 终态的条件：直接子进程已经退出，且两路管道都到 EOF——或宽限期用完。
 *
 * 为什么需要宽限期：后台进程会继承管道写端，`nohup ./dev-server &` 之后
 * 管道永远不会 EOF。死等就会让终态事件永远不发（§C.2：exec 正常结束时不禁子进程）。
 */
function maybeComplete(record: ExecutionRecord, config: Config): void {
  if (record.finishing || record.status !== "running") return;
  if (!record.childExited) return;

  if (record.stdoutEnded && record.stderrEnded) {
    void finalize(record, config);
    return;
  }
  if (record.timers.drain !== undefined) return;

  // 宽限期就是 exitDrainMs（默认 250ms）。这期间数据还能收，到点就强拆读端。
  const drain = setTimeout(() => {
    record.timers.drain = undefined;
    record.mergers?.out.end();
    record.mergers?.err.end();
    // 后台进程之后的输出就丢了——它不属于这次执行的结果。
    record.child?.stdout?.destroy();
    record.child?.stderr?.destroy();
    void finalize(record, config);
  }, config.exitDrainMs);
  drain.unref();
  record.timers.drain = drain;
}

/** 清掉还没到点的三个定时器。收尾时必须调，否则它们迟早会去动一个已经结束的执行。 */
function clearTimers(record: ExecutionRecord): void {
  record.timers.timeout?.cancel();
  record.timers.timeout = undefined;
  record.timers.escalation?.cancel();
  record.timers.escalation = undefined;
  if (record.timers.drain !== undefined) {
    clearTimeout(record.timers.drain);
    record.timers.drain = undefined;
  }
}

/**
 * 内联事件的字节预算。超限后事件流不再发内容，只发一条 truncated——
 * 但日志文件继续写（§C.2：完整内容始终在日志文件）。
 */
function emitChunk(
  record: ExecutionRecord,
  stream: "stdout" | "stderr",
  text: string,
  bytes: number,
): void {
  // 已经截断过或已经在收尾 → 之后的内容一律不再进事件流（日志不受影响）。
  if (record.truncated || record.finishing) return;

  // 还剩多少字节可以进事件流。stdout 和 stderr 共享这一个额度。
  const remaining = record.maxOutputBytes - record.inlineBytes;
  if (bytes > remaining) {
    // 正好越线：先把能塞下的前缀发出去，再发 truncated。
    // 这个顺序保证“发出去的内容”是连续且完整的开头，不会中间挖个洞。
    const prefix = takePrefixBytes(text, remaining);
    if (prefix.length > 0) {
      record.inlineBytes += Buffer.byteLength(prefix, "utf8");
      record.bus.publish(stream, { chunk: prefix });
    }
    record.truncated = true;
    record.bus.publish("truncated", {
      reason: "output_limit",
      limit: record.maxOutputBytes,
      log_path: record.logPath,
    });
    return;
  }

  record.inlineBytes += bytes;
  record.bus.publish(stream, { chunk: text });
}

/** 按码点截断，绝不切在代理对中间。只在触发截断时走一次。 */
function takePrefixBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let prefix = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    prefix += char;
  }
  return prefix;
}

/** 一个执行到底没到底：退出码 + 两路管道 + 一条超时。 */
function terminalData(record: ExecutionRecord, status: TerminalStatus): TerminalEventData {
  const data: TerminalEventData = {
    exit_code: record.exitCode,
    signal: record.signal,
    duration_ms: (record.endedAt ?? Date.now()) - record.startedAt,
    stdout_bytes: record.stdoutBytes,
    stderr_bytes: record.stderrBytes,
    truncated: record.truncated,
    log_truncated: record.log.truncated,
    log_path: record.logPath,
  };
  if (status === "timeout") data.timeout_ms = record.timeoutMs;
  if (status === "failed") {
    data.error = record.spawnError?.code ?? "spawn_failed";
    data.message = record.spawnError?.message ?? "failed to spawn command";
  }
  return data;
}

/**
 * 固定的最小环境集合 + 请求里的 env。
 * **不继承** agent 自己的 process.env：理由不是防泄密（容器里本来没秘密），
 * 而是确定性——测试里环境变量不随宿主漂移。顺带保证 SANDBOX_AGENT_TOKEN
 * 不可能从环境里漏进被执行的命令。
 *
 * 【为什么 PYTHONUNBUFFERED 在这里】镜像里那行 `ENV PYTHONUNBUFFERED=1` 到不了被执行的
 * 命令——子进程环境是这份固定集合，agent 自己的环境不在其中。而 python 往管道写时默认
 * 整块缓冲，表现为“命令跑完才一次性出结果”，被 timeout 杀掉时甚至什么都看不到。
 * 写进固定集合是唯一既保住确定性（常量，不随宿主漂移）又让镜像那句承诺生效的位置。
 * 注意它不是“把 agent 的环境透传进来”：这里只是恰好取了同一个值。
 *
 * @param requestEnv 请求里带的额外变量，**可以覆盖**下面的固定值。
 *                     这不是漏洞：能传 env 的调用方本来就有执行权。
 */
export function buildEnv(requestEnv: Record<string, string>, config: Config): Record<string, string> {
  return {
    PATH: config.basePath,
    HOME: config.home,
    LANG: config.lang,
    TERM: config.term,
    PYTHONUNBUFFERED: "1",
    ...requestEnv,
  };
}

/** 统一构造 400 响应体，少写一层嵌套。 */
function invalid(error: string, message: string): ValidationResult {
  return { ok: false, body: { error, message } };
}
