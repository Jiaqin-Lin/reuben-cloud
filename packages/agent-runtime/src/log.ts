/**
 * `log.ts` —— 日志的最小公共形状（与 CP 的 `log.ts` **同形**，但不是同一个文件）。
 *
 * 【为什么这里再写一份】`agent-runtime` 是一个独立 workspace 包，它的硬约束之一是
 * "不 import CP 的任何模块"（依赖方向单向：CP → agent-runtime）。日志形状是**注入契约**
 * 而不是实现：CP 把自己的 `LogFn` 传进来时，两边结构相同、类型互相兼容，不需要共享包。
 * 为一个三行的类型建 `packages/shared` 会把"沙箱/CP 两层之间只有 HTTP 契约"这条边界
 * 重新打开一次（同样的理由见 CP 侧 `ulid.ts` 的文件头）。
 *
 * 【它不是日志框架】与 CP 那份一样：没有级别过滤、没有 transport，只是"往哪写"的一个函数。
 */

export type LogLevel = "info" | "warn" | "error";

/**
 * 一条日志。`details` 是结构化补充（turn / toolCallId / model 这类），
 * 不参与人读的那句话——它存在的意义是排障时能 grep 到。
 */
export type LogFn = (level: LogLevel, message: string, details?: Record<string, unknown>) => void;

/** 什么都不做的 logger（测试与"没有消费者"的路径用它，比 `() => {}` 表意清楚）。 */
export const noopLog: LogFn = () => {};
