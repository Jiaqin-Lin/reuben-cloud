/**
 * 长活任务的公共零件：BUSY 槽 + 总时限 + 断线回收进程组。
 *
 * 【为什么单独一个文件】Phase 3 的 `/diff` 与 `/archive` 都需要同一套东西：
 * 「占 exec 的同一个 BUSY 槽、有 `streamTimeoutMs` 总时限、客户端一断就把整棵进程树带走」。
 * 这套逻辑写两遍就会出现两个不同的进程组回收实现——而进程回收是整个方案里唯一
 * 真正有技术风险的部分（§K），不能有第二份。exec 那边的等价逻辑在 `exec/timeout.ts`，
 * 区别是那边由事件流驱动、这边由 HTTP 响应驱动。
 *
 * 【在链路中的位置】`diff.ts` / `archive.ts` 各调一次 `beginJob()`；之后每条 git/tar
 * 命令都通过 `spawnManaged()` 起。谁调 beginJob 谁负责在 `finally` 里调 `guard.finish()`——
 * 那一步不只是清理，它还是「把 BUSY 槽还回去」的唯一时机，漏了沙箱会永久 409。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { Config } from "./config.ts";
import type { ExecutionRegistry } from "./exec/registry.ts";
import { buildEnv } from "./exec/spawn.ts";
import { killProcessGroup } from "./exec/timeout.ts";
import type { ErrorResponse } from "./types.ts";
import { ulid } from "./ulid.ts";

/**
 * 任务类型。它同时决定两件事：BUSY 槽里 id 的前缀（`diff_…` / `archive_…`，让 409 的
 * 调用方看得出谁占着）和外置 patch 的文件名前缀。
 */
export type JobKind = "diff" | "archive";

/** 子进程 stderr 只保留开头这么多字节：tar 能把同一句警告刷几千行，诊断只需要开头。 */
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * 一次长活任务的执行上下文。三件事：
 *  1. 持着 BUSY 槽（构造前必须先抢到）
 *  2. 有一个总时限，到点杀掉所有登记在案的进程组
 *  3. 客户端断开时立刻做同样的事——不杀的话 tar/git 会继续跑，反复几次就把容器塞满
 *
 * 它**不管进程怎么起、输出怎么流**——那些是 `spawnManaged()` 和调用方的事。
 */
export class JobGuard {
  /** BUSY 槽里的 id，形如 `diff_01H...` / `archive_01H...`。 */
  readonly id: string;
  /** 总时限（毫秒）。504 的措辞和 /health 的占用原因都读它。 */
  readonly timeoutMs: number;
  /**
   * 超时或断线时 resolve。给"等 drain 这类可能永远不来的等待"一个逃生口——
   * 没有它，一次断线就能让任务挂死、BUSY 槽永远不还。
   */
  readonly aborted: Promise<void>;

  #registry: ExecutionRegistry;
  /** 当前登记在案的子进程。超时/断线/收尾时逐个杀进程组。 */
  #children = new Set<ChildProcess>();
  #timer: NodeJS.Timeout;
  #resolveAborted: () => void = () => {};
  /** 优雅退出时的注销函数（registry.shutdown 会调它登记的钩子）。 */
  #unregisterCancellation: () => void = () => {};
  /** finish() 的幂等锁，同时也是"正常收尾"与"意外断线"的判别依据。 */
  #finished = false;
  #timedOut = false;
  #clientGone = false;

  constructor(id: string, registry: ExecutionRegistry, config: Config, res: ServerResponse) {
    this.id = id;
    this.timeoutMs = config.streamTimeoutMs;
    this.#registry = registry;
    this.aborted = new Promise<void>((resolve) => {
      this.#resolveAborted = resolve;
    });

    // SIGTERM 收尾时 registry 会调到这里，把还没跑完的 git/tar 一起带走。
    this.#unregisterCancellation = registry.registerCancellation(() => this.killAll());

    // 总时限。diff/archive 不走 exec 的超时机制（它们没有事件流），这是它们自己的那一层。
    // unref()：别让这个定时器把 agent 进程吊住不退出。
    this.#timer = setTimeout(() => {
      this.#timedOut = true;
      this.#resolveAborted();
      this.killAll();
    }, this.timeoutMs);
    this.#timer.unref();

    res.on("close", () => {
      // 正常收尾（我们主动 end / 流正常结束）也会触发 close，靠 writableFinished 区分。
      // 反过来说：writableFinished 为 false 的 close 就是"对端没了"。
      if (this.#finished || res.writableFinished) return;
      this.#clientGone = true;
      this.#resolveAborted();
      this.killAll();
    });
  }

  /** null = 一切正常；否则是被中止的原因。调用方在每个阶段之间查它。 */
  get abortReason(): "timeout" | "client_gone" | null {
    if (this.#timedOut) return "timeout";
    if (this.#clientGone) return "client_gone";
    return null;
  }

  /**
   * 登记一个子进程，交给超时/断线逻辑管。
   * 登记时已经中止的话立刻补一刀——消掉"spawn 完成"与"收到中止信号"之间的那点竞态。
   */
  track(child: ChildProcess): void {
    this.#children.add(child);
    if (this.abortReason !== null) killProcessGroup(child.pid ?? null, "SIGKILL");
  }

  /** 进程已经退出（或 spawn 失败）时调，免得集合里留死引用。 */
  untrack(child: ChildProcess): void {
    this.#children.delete(child);
  }

  /** 杀掉当前所有在跑的子进程组。超时、断线、输出超限都会用它。 */
  killAll(): void {
    for (const child of this.#children) killProcessGroup(child.pid ?? null, "SIGKILL");
  }

  /**
   * 收尾：清定时器、补杀遗留、把 BUSY 槽还回去。**幂等**。
   * 无论成功、失败、超时还是断线都必须调（调用方写进 finally）。
   */
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#timer);
    // 正常路径下集合已经空了；非空说明有进程没收干净，补一刀再还槽。
    this.killAll();
    this.#unregisterCancellation();
    this.#registry.releaseSlot(this.id);
  }
}

/**
 * `beginJob()` 的结果。失败时直接带着要返回给 CP 的 HTTP 状态码和响应体——
 * 与 `ExecutionRegistry.start()` 的约定一致，知识只存在一层（"什么算 409、什么算 503"）。
 */
export type BeginJobResult =
  | { ok: true; guard: JobGuard }
  | { ok: false; status: number; body: ErrorResponse };

/**
 * 抢 BUSY 槽并建好 JobGuard。`id` 由这里生成（`{kind}_{ulid}`）。
 *
 * @param res 用来监听客户端断开；**必须**是这条请求的响应对象。
 * @returns ok=false 时调用方把 status/body 原样发出去即可。
 */
export function beginJob(
  registry: ExecutionRegistry,
  config: Config,
  res: ServerResponse,
  kind: JobKind,
): BeginJobResult {
  const id = `${kind}_${ulid()}`;
  const slot = registry.acquireSlot(id);
  if (!slot.ok) return slot;
  return { ok: true, guard: new JobGuard(id, registry, config, res) };
}

/** 一次子进程退出的结果。spawn 层面失败时 `code` 是 null、`spawnError` 非 null。 */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** spawn 层面的失败（ENOENT / EACCES / cwd 不存在）。进程起来了之后就是 null。 */
  spawnError: NodeJS.ErrnoException | null;
}

/** 一个受 JobGuard 管理的子进程。 */
export interface ManagedChild {
  /** 原生子进程对象（调用方一般只需要 `pid`）。 */
  child: ChildProcess;
  /** 它的 stdout。stdout/stderr 写死了 pipe，所以一定有值。 */
  stdout: Readable;
  /** 有界的 stderr（只留开头 MAX_STDERR_BYTES 字节）。进程退出后再读。 */
  stderrText(): string;
  /** 等它退出。**spawn 失败也会 resolve**，不会挂住。 */
  exited: Promise<ChildExit>;
}

/** spawnManaged() 的结果。ok=false 表示子进程根本没起来（ENOENT / 同步参数错）。 */
export type SpawnedProcess = { ok: true; proc: ManagedChild } | { ok: false; error: Error };

/**
 * 起一个受管的子进程：固定最小环境、独立进程组、没有 stdin。
 *
 * 与 `exec/spawn.ts` 的 startProcess 有两处刻意的相同和两处刻意的不同：
 *  相同：`detached: true`（进程组组长，`kill(-pid)` 能带走整棵树）、
 *        `shell: false` + argv 数组（注入类 bug 整类消失）、`stdio[0] = "ignore"`。
 *  不同：不接事件总线、不写日志文件——diff/archive 的数据面是 HTTP 响应，不是事件流。
 *
 * 返回 Promise 而不是直接给 child：ENOENT 这种异步失败在这里被收成 `ok:false`，
 * 调用方不必再写一遍 `'error'` 监听，也就能在"一个字节都没发出去"的时候体面地回 500。
 *
 * @param guard 起好之后子进程立刻被登记（超时/断线时会被杀）。
 */
export function spawnManaged(
  guard: JobGuard,
  options: { cmd: string[]; cwd: string; config: Config },
): Promise<SpawnedProcess> {
  let child: ChildProcess;
  try {
    child = spawn(options.cmd[0]!, options.cmd.slice(1), {
      cwd: options.cwd,
      // 和 exec 用同一份固定最小集合：不继承 agent 自己的 process.env。
      // 理由不是防泄密，是确定性——测试里环境变量不随宿主漂移。
      env: buildEnv({}, options.config),
      detached: true, // ← 进程组：断线/超时时一次带走整棵树
      stdio: ["ignore", "pipe", "pipe"], // ← 没有交互式输入通道
      shell: false, // ← 默认值，但写出来
    });
  } catch (error) {
    // 同步失败：cwd 不存在 / argv 非法。异步失败（ENOENT）走下面的 'error' 事件。
    return Promise.resolve({ ok: false, error: error as Error });
  }

  // stdio 写死了两个 "pipe"，所以这两个流必然有值；TS 从类型上推不出来。
  const stdout = child.stdout as Readable;

  // stderr 边来边攒，但有上限：tar 的警告可以是无限行，诊断只要开头。
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_STDERR_BYTES) return;
    const slice = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
    stderrChunks.push(slice);
    stderrBytes += slice.length;
  });

  // 退出这件事只有一份实现：'error' 只记原因，'exit' 和 'close' 谁先到算谁。
  // 为什么要 'close' 兜底：ENOENT 时 Node 只发 'error' + 'close'，**没有 'exit'**
  // （这个坑 Phase 1 的 spawn.ts 已经踩过一次）。
  let spawnError: NodeJS.ErrnoException | null = null;
  const exited = new Promise<ChildExit>((resolve) => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      guard.untrack(child);
      resolve({ code, signal, spawnError });
    };
    child.on("error", (error: Error) => {
      spawnError ??= error as NodeJS.ErrnoException;
    });
    child.on("exit", (code, signal) => settle(code, signal));
    child.on("close", (code, signal) => settle(code, signal));
  });

  return new Promise<SpawnedProcess>((resolve) => {
    // 'spawn' = 进程真的起来了（execve 成功）。这时才登记，避免把一个根本没起来的
    // pid 交给 guard 去 kill。
    child.once("spawn", () => {
      guard.track(child);
      resolve({
        ok: true,
        proc: {
          child,
          stdout,
          exited,
          stderrText: () => Buffer.concat(stderrChunks).toString("utf8"),
        },
      });
    });
    child.once("error", (error: Error) => {
      // 只有"根本没起来"（pid 还是 undefined）才算启动失败；
      // 起来之后再出的错交给 exited（那时调用方已经在读 stdout 了）。
      if (child.pid !== undefined) return;
      resolve({ ok: false, error });
    });
  });
}

/**
 * 等 `res` 的 drain，但**不能死等**：客户端断开时 drain 可能永远不来，任务就会挂住，
 * BUSY 槽也就永远不还。所以同时和 guard.aborted（超时/断线）以及 res 的 'close' 赛跑。
 *
 * 只有 `res.write()` 返回 false（内核缓冲满了）时才需要调它——这是背压的正规用法。
 */
export function waitForDrain(res: ServerResponse, guard: JobGuard): Promise<void> {
  // 先进来就发现已经中止/已经断了：连赛跑都不用跑。
  if (guard.abortReason !== null || res.destroyed) return Promise.resolve();
  return Promise.race([
    once(res, "drain").then(() => undefined),
    once(res, "close").then(() => undefined),
    guard.aborted,
  ]);
}
