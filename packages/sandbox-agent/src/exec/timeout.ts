/**
 * 进程组的终止与超时。
 *
 * `detached: true` 让子进程成为进程组组长（setsid），于是 `process.kill(-pid, sig)`
 * 一次带走整棵树——这是 Node 里拿到进程组 id 的正规做法，不用调 setsid 二进制。
 *
 * 阶梯固定：SIGTERM → 5s → SIGKILL，两步都要对**整组**发（§C.2 / §D）。
 * 所有定时器都 unref()，免得 agent 进程被它们吊住。
 *
 * 【在链路中的位置】被 spawn.ts 调用（超时、主动 kill）和 registry.ts 调用（优雅退出）。
 * 「谁在什么时候杀谁」的决策不在这里，这里只负责"把信号发出去"这一个动作。
 */

/**
 * 向进程组发信号。
 *
 * @param pid 组长进程（就是 spawn 出来的直接子进程）的 pid。传 null / 非法值直接返回 false。
 * @param signal 要发的信号名，如 "SIGTERM" / "SIGKILL"。
 * @returns 是否真的送到了。`false` 有四种来源，调用方不需要区分：pid 非法、
 *          进程已经自己退干净了（ESRCH，最常见也完全正常）、没权限（EPERM）、
 *          以及任何其他 errno。
 *
 * 【为什么是 `-pid` 而不是 `pid`】Node 沿用 POSIX 的约定：负数 pid = 发给整个进程组。
 * 因为 spawn 时开了 `detached: true`，直接子进程自己就是一个组的组长，
 * 所以 `-pid` 正好覆盖「它 + 它 fork 的所有孙子进程」。
 */
export function killProcessGroup(pid: number | null, signal: NodeJS.Signals): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    return process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM 之类：记不了日志也无所谓，调用方还有 SIGKILL 和 destroy 兜底。
    return false;
  }
}

/**
 * "先礼后兵"的句柄。调用方拿到它，只能干两件事：查 escalation 状态（测试用）、cancel。
 */
export interface KillEscalation {
  /** 已经升级到 SIGKILL 了吗（5s 宽限期过完了）。 */
  readonly escalated: boolean;
  /** 取消还没发出的 SIGKILL（进程已经自己退干净了就调它）。 */
  cancel(): void;
}

/**
 * 执行"先礼后兵"：立刻发 SIGTERM，宽限期到了还没人 cancel 就发 SIGKILL。
 *
 * @param pid 进程组组长的 pid。
 * @param graceMs 宽限毫秒数（来自 config.killGraceMs，默认 5000）。
 * @returns 一个句柄，用来在进程提前退出时 cancel 掉那颗 SIGKILL 定时炸弹。
 *
 * 为什么要有 SIGTERM 这一步、不直接 SIGKILL：直接 SIGKILL 会让被杀的进程没机会
 * 自己收尾（关数据库连接、删临时文件），而且它 fork 出来的孙子进程可能活下来。
 * 所以是"先请求它退，不退再强杀"。
 */
export function escalateKill(pid: number, graceMs: number): KillEscalation {
  killProcessGroup(pid, "SIGTERM");

  let escalated = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    escalated = true;
    killProcessGroup(pid, "SIGKILL");
  }, graceMs);
  timer.unref();

  return {
    get escalated() {
      return escalated;
    },
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}

/** 超时定时器的句柄，只需要能取消。 */
export interface ScheduledTimeout {
  cancel(): void;
}

/**
 * 安排一个"到点执行 onFire"的定时器（exec 超时用）。
 *
 * @param timeoutMs 多少毫秒之后触发。
 * @param onFire 触发时干什么——在 spawn.ts 里是"请求杀掉这个执行"。
 * @returns 句柄，进程提前退出时 cancel 掉它。
 *
 * 定时器同样 unref()：否则一个 600s 的超时会把 agent 进程卡住不退出。
 */
export function scheduleTimeout(timeoutMs: number, onFire: () => void): ScheduledTimeout {
  const timer = setTimeout(onFire, timeoutMs);
  timer.unref();
  return {
    cancel() {
      clearTimeout(timer);
    },
  };
}
