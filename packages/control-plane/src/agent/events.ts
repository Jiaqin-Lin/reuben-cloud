/**
 * `events.ts` —— 观察窗的**事件词汇与唯一映射表**（Phase 4）。
 *
 * 【P4 把这里改成了什么】M0 有两套事件：循环的 `AgentEvent`（真相）与给人看的
 * `RunEvent`（翻译）。两套必然漂——M0 出现过"加了一类事件、前端静默丢掉"的问题，
 * 当时只能在 Phase 13 补一条"每个 `RunEvent.type` 都要有前端分支"的单测打补丁
 * （设计文档 §B.5）。现在只有一套：
 *  · **`AgentEvent`（agent-runtime）是循环侧全部可观测信息的唯一来源**——轮次、消息
 *    增量、工具执行、上下文编译、压缩、旁路提示全在它里面；
 *  · 这个文件只剩下三件事：① 三个 **Run 生命周期**事件（CP 侧的编排才知道的信息）；
 *    ② 沙箱命令输出的**映射**（沙箱有自己的事件协议，前端不该认识第二套词汇）；
 *    ③ **AgentEvent/ExecEvent/RunEvent → SSE 帧**的通道选择（下面那张映射表）。
 *
 * 【为什么 SSE 要按事件名分通道，而不是全走 `message`】M0 只有一个 `message` 通道，
 * 前端 `onmessage` 里再 switch 一次 `data.type`——那等于把"通道"这件事藏进数据里，
 * `EventSource` 的 `addEventListener("tool", ...)` 这种最自然的用法就用不上。
 * 分开之后：浏览器按名字只分发有人监听的通道，老客户端不认识的新通道**天然被忽略**
 * （EventSource 的规范行为，正是 spec 要求的"向后兼容"），前端也少一层判别。
 *
 * 【为什么沙箱输出不做成 AgentEvent】沙箱是另一个进程、另一套词汇（`started` /
 * `stdout` / `completed`，snake_case），它在循环之外也存在（P7 的健康检查、P6 的
 * 构建日志都直接用）。硬塞进 AgentEvent 会让"循环事件"这个概念被污染；所以它保持
 * 一个小的、独立的事件族（`ExecEvent`），只在这里被翻译一次。
 */

import type { AgentEvent, AgentEventSink, Usage } from "@reuben-cloud/agent-runtime";
import type { SseEvent } from "../client/sse.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

export type { AgentEventSink };

// ---------------------------------------------------------------- Run 生命周期

/** Run 的三个硬上限（与 `loop.ts` 生效的值一致，前端据此显示进度）。 */
export interface RunLimits {
  maxTurns: number;
  wallClockMs: number;
  outputTokenBudget: number;
  maxTokens: number;
}

/**
 * 一次 Run 的生命周期事件。**只有三个**（设计文档 §B.5：`RunEvent` 这个名字留给
 * 生命周期，工具/消息/命令输出全部走 `AgentEvent`）。
 *
 * 「一条事件必须能被独立渲染」在这里同样成立：`run_start` 自带题面与上限，
 * `run_end` 自带终态、轮数与用量——前端不需要看别的才知道怎么渲染这一条。
 */
export type RunEvent =
  /** Run 开始。`issue` 是题面原文，`repoDir` 是模型心里的工作目录。 */
  | {
      type: "run_start";
      runId: string;
      /** 这次执行挂在哪个会话上（观察窗用它读会话视图）；单跑没有会话时是 null。 */
      sessionId: string | null;
      model: string;
      issue: string;
      repoDir: string;
      limits: RunLimits;
    }
  /** Run 结束。`ok` 只有模型正常收工才是 true（与 `AgentLoopResult.ok` 同一个判断）。 */
  | {
      type: "run_end";
      ok: boolean;
      stopReason: string;
      detail: string;
      turns: number;
      toolCalls: number;
      usage: Usage;
    }
  /** Run 在循环之外就崩了（clone 失败、沙箱建不起来、调用方自己出错）。 */
  | { type: "run_error"; message: string };

/** Run 生命周期事件的出口。 */
export interface RunEventSink {
  emit(event: RunEvent): void;
}

/** 没有观察者时的 sink（与 `noopLog` 同一个用法：比 `{ emit: () => {} }` 表意清楚）。 */
export const noopRunEventSink: RunEventSink = { emit: () => {} };

// ---------------------------------------------------------------- 沙箱命令输出

/**
 * 沙箱里一条命令的三个事件（`mapExecEvent` 的产物）。
 *
 * `executionId` 允许为 null：沙箱的 `stdout` / `stderr` 不带 id（它们本来就在“某次执行”
 * 的流里），映射器靠前面的 `started` 补上；补不上就如实留 null，前端按“最近一个命令”
 * 挂——宁可位置不精确，也不丢输出。
 */
export type ExecEvent =
  /** 命令真的起来了（`executionId` 从沙箱的 `started` 事件里来）。 */
  | { type: "exec_start"; executionId: string | null; cmd: string[]; cwd: string | null }
  /** 命令的输出块。stdout / stderr 分开（终端里是同一个流，这里保留类别给前端上色）。 */
  | { type: "exec_output"; executionId: string | null; stream: "stdout" | "stderr"; text: string }
  /** 命令的终态（completed / failed / timeout / killed）。 */
  | {
      type: "exec_end";
      executionId: string | null;
      state: string;
      exitCode: number | null;
      durationMs: number | null;
      stdoutBytes: number;
      stderrBytes: number;
      truncated: boolean;
      logPath: string | null;
    };

/** 沙箱命令输出的出口（`createSandboxToolkit` 只认这一个口）。 */
export interface ExecEventSink {
  emit(event: ExecEvent): void;
}

/** 没有观察者时的 sink。 */
export const noopExecEventSink: ExecEventSink = { emit: () => {} };

// ---------------------------------------------------------------- 观察窗的一条事件

/**
 * 观察窗缓冲里能出现的一条事件。**三族合流，但各族的来源是明确的**：
 *  · `RunEvent` —— CP 的编排（生命周期）；
 *  · `AgentEvent` —— 循环（唯一真相）；SSE 的 `agent` / `turn` / `message` / `tool` /
 *    `context` / `compaction` / `note` 七个通道全部来自它；
 *  · `ExecEvent` —— 沙箱命令输出。
 */
export type HubEvent = RunEvent | ExecEvent | AgentEvent;

/**
 * 观察窗的出口。**只有 emit**：谁来收、收多少、怎么缓冲是接收端的事。
 *
 * 【为什么这个口比窄口“宽”是有意的】一个收得下三族事件的 sink（hub）当然也能收下
 * 其中任意一族（沙箱适配器只发 `ExecEvent`、循环只发 `AgentEvent`）。方法参数的双向
 * 协变让 `HubEventSink` 可以直接当 `ExecEventSink` / `AgentEventSink` 用，
 * 于是调用方不需要为“同一个观察窗”准备三个包装对象。
 */
export interface HubEventSink {
  emit(event: HubEvent): void;
}

/** 没有观察者时的 sink（同 `noopRunEventSink`）。 */
export const noopHubEventSink: HubEventSink = { emit: () => {} };

/**
 * 安全发射：**消费者的异常不许冒泡**。
 *
 * 【为什么这条不能省】观察窗是**旁路**。一次已经改了 20 分钟代码的 Run 不该因为
 * 一个渲染 bug（或者一个满了的队列）归零——同样的规矩在 `sandbox-manager` 的
 * `onEvent` 上已经写过一次（那里连"消费者抛异常"的注释都一样）。
 *
 * 泛型是为了让三个事件族都走同一个实现：`emitEvent(execSink, execEvent)` 与
 * `emitEvent(hubSink, agentEvent)` 都不需要各自的 try/catch。
 */
export function emitEvent<T extends HubEvent>(
  sink: { emit(event: T): void } | undefined,
  event: T,
  log: LogFn = noopLog,
): void {
  if (sink === undefined) return;
  try {
    sink.emit(event);
  } catch (error) {
    log("warn", `事件流的消费者抛了异常（已忽略，Run 继续）`, {
      event: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------- SSE 通道

/**
 * SSE 的 `event:` 名。**这张表是唯一允许出现"事件名映射"的地方**：前端、测试、
 * 别的客户端都按它对齐；加一族事件时改这里一处，编译期就会指着剩下的漏网之处。
 *
 * 【名字为什么这么短】它进的是 `addEventListener` 与 `curl` 的命令行，不是给人读的
 * 句子；语义由通道里的 `data.type` 承担（`message` 通道里有 start/update/end 三条）。
 */
export const SSE_EVENT_NAMES = [
  "run",
  "agent",
  "turn",
  "message",
  "tool",
  "context",
  "compaction",
  "note",
  "exec",
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

export interface SseFrame {
  event: SseEventName;
  data: HubEvent;
}

/**
 * 一条事件 → 一个 SSE 通道。**switch 全枚举 + `never` 兜底**：新增一种事件而忘了
 * 映射时，这里编译不过（不是等前端静默丢一类）。
 *
 * 映射表（spec P4 的那张）：
 *
 * | 事件 | 通道 | 前端行为 |
 * |---|---|---|
 * | `run_start` / `run_end` / `run_error` | `run` | Run 卡片与终态 |
 * | `agent_start` / `agent_end` | `agent` | 状态行 |
 * | `turn_start` / `turn_end` | `turn` | 轮次计数 |
 * | `message_*` | `message` | 打字机、工具调用卡片 |
 * | `tool_execution_*` | `tool` | 卡片状态更新 |
 * | `context_compiled` | `context` | 上下文面板 |
 * | `compaction` | `compaction` | "已压缩"分隔线 |
 * | `note` | `note` | 旁路提示 |
 * | `exec_*` | `exec` | 命令输出着色 |
 */
export function sseFrameOf(event: HubEvent): SseFrame {
  switch (event.type) {
    // ---- Run 生命周期（CP 编排）
    case "run_start":
    case "run_end":
    case "run_error":
      return { event: "run", data: event };

    // ---- 沙箱命令输出
    case "exec_start":
    case "exec_output":
    case "exec_end":
      return { event: "exec", data: event };

    // ---- 循环的原生事件（唯一真相）
    case "agent_start":
    case "agent_end":
      return { event: "agent", data: event };
    case "turn_start":
    case "turn_end":
      return { event: "turn", data: event };
    case "message_start":
    case "message_update":
    case "message_end":
      return { event: "message", data: event };
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return { event: "tool", data: event };
    case "context_compiled":
      return { event: "context", data: event };
    case "compaction":
      return { event: "compaction", data: event };
    case "note":
      return { event: "note", data: event };
    default:
      return assertNever(event);
  }
}

/** 穷尽性兜底：走到这里说明有一族事件没进映射表（编译期就会红）。 */
function assertNever(value: never): never {
  throw new Error(`事件协议里有没进映射表的类型：${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------- 沙箱事件 → 观察窗事件

/** 映射器跨事件保留的状态。**只有 executionId 一个**，见 `createExecEventMapper`。 */
export interface ExecEventState {
  /** 当前的执行 id。`started` 事件带来它，之后的输出事件借用。 */
  executionId: string | null;
}

/**
 * 沙箱的 `stdout` / `stderr` 事件**不带** executionId（它们本来就在"某次执行"的流里），
 * 而前端需要它才能把输出归到某条命令上。沙箱的第一条事件是 `started`（Phase 1 的顺序
 * 保证），所以映射器把 id 记在心里，后面的输出事件就有 id 了——**每个 exec 一个映射器**
 * （`createExecEventMapper()`），不要跨执行复用。
 */
export function createExecEventMapper(): (event: SseEvent) => HubEvent[] {
  const state: ExecEventState = { executionId: null };
  return (event) => mapExecEvent(event, state);
}

/**
 * 一条沙箱事件 → 0..n 条观察窗事件。认不出 / 解不开时返回一条 **`AgentEvent` note**
 * 而不是抛异常：协议漂了要能看见（note 会进 entries 与页面），但不能弄死一个正在跑的 Run。
 *
 * 【为什么"认不出"也发出去】如果只静默跳过，沙箱加了事件类型而这里没跟上时，
 * 页面上是"命令跑到一半没输出"，排查的人会先怀疑沙箱。一条 note 把问题指到正确的地方。
 */
export function mapExecEvent(event: SseEvent, state: ExecEventState): HubEvent[] {
  const data = parseData(event);
  if (data === null) {
    return [noteEvent("exec_unparsed", `沙箱事件 ${event.event} 的 data 不是合法 JSON，已跳过`)];
  }

  switch (event.event) {
    case "started": {
      state.executionId = stringField(data, "execution_id") ?? state.executionId;
      return [
        {
          type: "exec_start",
          executionId: state.executionId,
          cmd: stringArrayField(data, "cmd"),
          cwd: stringField(data, "cwd"),
        },
      ];
    }
    case "stdout":
    case "stderr":
      return [
        {
          type: "exec_output",
          executionId: state.executionId,
          stream: event.event,
          text: stringField(data, "chunk") ?? "",
        },
      ];
    case "truncated": {
      const reason = stringField(data, "reason") ?? "unknown";
      const logPath = stringField(data, "log_path");
      return [
        noteEvent(
          "exec_truncated",
          `命令输出太长，事件流里只保留了一部分（${reason}）` +
            (logPath === null ? "" : `。完整输出在沙箱的 ${logPath}`),
        ),
      ];
    }
    case "completed":
    case "failed":
    case "timeout":
    case "killed":
      return [
        {
          type: "exec_end",
          executionId: state.executionId,
          state: event.event,
          exitCode: numberField(data, "exit_code"),
          durationMs: numberField(data, "duration_ms"),
          stdoutBytes: numberField(data, "stdout_bytes") ?? 0,
          stderrBytes: numberField(data, "stderr_bytes") ?? 0,
          truncated: data["truncated"] === true,
          logPath: stringField(data, "log_path"),
        },
      ];
    default:
      // 认不出的事件名：留一条 note。沙箱加了事件类型而这里没跟上时，页面上一眼能看见。
      return [noteEvent("exec_unknown", `认不出的沙箱事件：${event.event}`)];
  }
}

/** 旁路提示：走 `AgentEvent` 的 note 通道（与前端的 `note` 分支同一条路）。 */
function noteEvent(kind: string, message: string): AgentEvent {
  return { type: "note", kind, message };
}

function parseData(event: SseEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function numberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
