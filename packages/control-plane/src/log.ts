/**
 * 日志的最小公共形状。
 *
 * 【为什么单独一个文件】provider / manager / sweeper / migrate 都要打日志，而它们的
 * 调用方（脚本、测试、将来的 CP 主进程）需要同一种接法：`(level, message, details?)`。
 * 各写一份同形状的类型定义会让"给 log 加一个字段"变成四处改。
 *
 * 【它不是日志框架】没有级别过滤、没有 JSON 格式化、没有 transport——
 * MVP 单实例、日志进 stdout 由 Docker 收走（A-11）。这个文件只做一件事：
 * 让每一层都能被注入一个"往哪写"的函数，测试里就能换成数组。
 */

export type LogLevel = "info" | "warn" | "error";

/**
 * 一条日志。`details` 是结构化补充（sandboxId / reason / endpoint 这类），
 * 不参与人读的那句话——它存在的意义是排障时能 grep 到。
 */
export type LogFn = (level: LogLevel, message: string, details?: Record<string, unknown>) => void;

/** 打到 stdout/stderr 的默认实现。`scope` 是前缀（如 `manager`、`sweeper`）。 */
export function consoleLog(scope: string): LogFn {
  return (level, message, details) => {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    const line = `[${scope}:${level}] ${message}${suffix}`;
    if (level === "error") console.error(line);
    else console.log(line);
  };
}

/** 什么都不做的 logger（测试里不关心日志时用它，比 `() => {}` 表意清楚）。 */
export const noopLog: LogFn = () => {};
