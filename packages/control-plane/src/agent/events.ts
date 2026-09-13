/**
 * `events.ts` —— 一次 Run 的**观察窗**（Phase 13 的事件词汇）。
 *
 * 【它与 transcript 的分工】两者都在同一批位置发射，但受众不同：
 *  - `transcript.ts` 是**事后取证**：每轮完整的 system + tools + messages，几十 MB 也照写，
 *    目的是"模型当初到底看到了什么"必须能原样重现。
 *  - 这个文件是**实时观察**：一条事件一个 JSON，浏览器的 EventSource 直接吃。
 *    所以它必须小、必须有判别式 `type`（前端一个 switch 就能渲染）、必须**有界**。
 * 一份数据不能同时满足两种受众：把 transcript 的记录直接推给浏览器，等于把每轮几百 KB 的
 * messages 反复推一遍；把事件流当证据存，又会丢掉完整上下文。
 *
 * 【为什么事件是文字而不是"已经渲染好的 HTML"】渲染属于前端（`packages/web`）。
 * CP 这边只保证"发生了什么"，不预设页面长什么样——同一个流将来接 TUI、接测试、接别的
 * 前端都不用改。这也是为什么这里没有一条事件带样式信息。
 *
 * 【为什么 sink 只做加法】`RunEventSink` 只有一个 `emit`，实现方（`web/hub.ts` 的 RunHub）
 * 决定缓冲、合并、订阅。**发射方永远不等待消费者**：一个慢浏览器不能拖慢一次 Run。
 * 这条规矩的落地是 `emitEvent()`：消费者的异常只记一条 warn，绝不冒泡进循环。
 *
 * 【沙箱命令输出为什么要在这里做一层映射】沙箱的事件（§Phase 1：started / stdout /
 * stderr / truncated / 四种终态）是**那个系统**的词汇，字段名是 snake_case、事件名是
 * "completed"。前端不该认识第二套协议，所以映射收在这一个文件里（`createExecEventMapper`），
 * `bash.ts` 只负责把沙箱事件喂进来。
 */

import type { SseEvent } from "../client/sse.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { Usage } from "@reuben-cloud/agent-runtime";

// ---------------------------------------------------------------- 事件

/** Run 的三个硬上限（与 `loop.ts` 生效的值一致，前端据此显示进度）。 */
export interface RunLimits {
  maxTurns: number;
  wallClockMs: number;
  outputTokenBudget: number;
  maxTokens: number;
}

/**
 * 一次 Run 的事件。**判别式联合**，`type` 是唯一的判别键。
 *
 * 「一条事件必须能被独立渲染」是这里的设计约束：每一条都自带它需要的上下文
 * （`turn` / `id` / `executionId`），前端不需要看前一条才知道怎么渲染这一条。
 * 代价是几字节的重复，收益是前端没有"状态机"、乱序/丢失也不会渲染错位。
 */
export type RunEvent =
  /** Run 开始。`issue` 是题面原文，`repoDir` 是模型心里的工作目录。 */
  | { type: "run_start"; runId: string; model: string; issue: string; repoDir: string; limits: RunLimits }
  /** 第 N 轮模型调用开始（`turn` 从 1 起）。 */
  | { type: "turn"; turn: number }
  /**
   * 模型文字增量（**唯一的高频事件**，`web/hub.ts` 会按时间合并）。
   * 不带 `turn`：它总是属于"最近一条 turn"，前端按流里的顺序归组即可。
   */
  | { type: "text"; delta: string }
  /** 模型要求调用工具（**在工具真的跑起来之前**发出，这样 UI 能看到"正在跑"）。 */
  | { type: "tool_call"; turn: number; id: string; name: string; input: unknown }
  /** 工具返回。`content` 是**完整**结果（最长 50 KiB，见 §3.5）；前端负责折叠显示。 */
  | { type: "tool_result"; turn: number; id: string; name: string; isError: boolean; bytes: number; content: string }
  /** 沙箱里的命令真的起来了（`executionId` 从沙箱的 `started` 事件里来）。 */
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
    }
  /** 循环自己的说明（重复调用提示、上下文裁剪、输出截断、模型错误）。 */
  | { type: "note"; turn: number | null; kind: string; message: string }
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

/** 发射端拿到的东西。**只有 emit**：谁来收、收多少、怎么缓冲是接收端的事。 */
export interface RunEventSink {
  emit(event: RunEvent): void;
}

/** 没有观察者时的 sink（与 `noopLog` 同一个用法：比 `{ emit: () => {} }` 表意清楚）。 */
export const noopRunEventSink: RunEventSink = { emit: () => {} };

/**
 * 安全发射：**消费者的异常不许冒泡**。
 *
 * 【为什么这条不能省】观察窗是**旁路**。一次已经改了 20 分钟代码的 Run 不该因为
 * 一个渲染 bug（或者一个满了的队列）归零——同样的规矩在 `sandbox-manager` 的
 * `onEvent` 上已经写过一次（那里连"消费者抛异常"的注释都一样）。
 */
export function emitEvent(sink: RunEventSink | undefined, event: RunEvent, log: LogFn = noopLog): void {
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

// ---------------------------------------------------------------- 沙箱事件 → RunEvent

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
export function createExecEventMapper(): (event: SseEvent) => RunEvent[] {
  const state: ExecEventState = { executionId: null };
  return (event) => mapExecEvent(event, state);
}

/**
 * 一条沙箱事件 → 0..n 条 RunEvent。认不出 / 解不开时返回一条 note 而不是抛异常：
 * 协议漂了要能看见，但不能弄死一个正在跑的 Run。
 */
export function mapExecEvent(event: SseEvent, state: ExecEventState): RunEvent[] {
  const data = parseData(event);
  if (data === null) {
    return [
      {
        type: "note",
        turn: null,
        kind: "exec_unparsed",
        message: `沙箱事件 ${event.event} 的 data 不是合法 JSON，已跳过`,
      },
    ];
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
        {
          type: "note",
          turn: null,
          kind: "exec_truncated",
          message:
            `命令输出太长，事件流里只保留了一部分（${reason}）` +
            (logPath === null ? "" : `。完整输出在沙箱的 ${logPath}`),
        },
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
      return [{ type: "note", turn: null, kind: "exec_unknown", message: `认不出的沙箱事件：${event.event}` }];
  }
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
