/**
 * 进程组的终止与超时。
 *
 * `detached: true` 让子进程成为进程组组长（setsid），于是 `process.kill(-pid, sig)`
 * 一次带走整棵树——这是 Node 里拿到进程组 id 的正规做法，不用调 setsid 二进制。
 *
 * 阶梯固定：SIGTERM → 5s → SIGKILL，两步都要对**整组**发（§C.2 / §D）。
 * 所有定时器都 unref()，免得 agent 进程被它们吊住。
 */

/** 向进程组发信号。ESRCH（刚好自己退了）是正常情况，不当错误。 */
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

export interface KillEscalation {
  readonly escalated: boolean;
  cancel(): void;
}

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

export interface ScheduledTimeout {
  cancel(): void;
}

export function scheduleTimeout(timeoutMs: number, onFire: () => void): ScheduledTimeout {
  const timer = setTimeout(onFire, timeoutMs);
  timer.unref();
  return {
    cancel() {
      clearTimeout(timer);
    },
  };
}
