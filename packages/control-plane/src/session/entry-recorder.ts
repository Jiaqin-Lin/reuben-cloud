/**
 * `session/entry-recorder.ts` —— 把循环的事件流转成会话存储操作（Phase 2 §5）。
 *
 * 【为什么从 `session-run.ts` 里拆出来】两个调用方需要同一套记录：会话编排
 * （`createSessionTurnRunner`，多轮）与 `agent:run` 脚本（单轮的手工验收驱动）。
 * 复制一份的后果是"手工跑能落库、产品路径落的是另一套"——M0 已经因为这种事吃过一次
 * （Phase 11 的 `workspaceDir` 漏传）。所以记录只有这一份实现。
 *
 * 【它记什么】
 *  · `message_end`：user / assistant / toolResult 三类消息 → entries；
 *    assistant 的那条**与 usage 同事务**（`appendEntry` 带 usage，见 store 的契约）；
 *  · `tool_execution_start` 之前：一条 intent（`tool_invocations`，带预留的结果 entry id），
 *    结果在 `message_end` 里结算（同一个事务落 entry + 推 status）；
 *  · `note`：旁路信息存成 `forModel:false` 的 custom entry。
 *
 * 【leaf 为什么由它持有】"下一条挂在哪"是这一层唯一需要跨事件记住的东西。存储层不猜
 * （`appendEntry` 不改 sessions.leaf_entry_id），编排在结束时用 `leafEntryId` 一次写清。
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  SessionStore,
  ToolResultMessage,
  Usage,
  UsageRow,
} from "@reuben-cloud/agent-runtime";
import {
  accumulateUsage,
  emptyUsage,
  entryForMessage,
  entryForNote,
} from "@reuben-cloud/agent-runtime";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

export interface EntryRecorderOptions {
  store: SessionStore;
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  /** 本轮开始前的 leaf（`runs.start_entry_id`）。 */
  leafEntryId: string | null;
  /**
   * 每次"活动"（轮次开始）时的续时钩子。会话层用它把 `sandbox_last_used_at` 推到当前，
   * 单轮脚本可以不传。
   */
  onActivity?: () => Promise<void>;
  log?: LogFn;
}

/**
 * 记录器。**一个 Run 一个实例**（它持有 leaf 游标）。
 *
 * 【为什么 `onAgentEvent` 不吞异常】它跑在 `run.ts` 的 handleEvent 里，那里已经有一层
 * try/catch（旁路失败只记 warn）。存储真出问题时，我们希望 Run 继续、日志里有痕迹，
 * 而不是在这里静默。
 */
export class EntryRecorder {
  readonly #store: SessionStore;
  readonly #sessionId: string;
  readonly #runId: string;
  readonly #provider: string;
  readonly #model: string;
  readonly #onActivity: (() => Promise<void>) | null;
  readonly #log: LogFn;

  #leaf: string | null;
  #turn = 0;
  /** 本轮里第几个工具调用 = assistant 消息里的源码顺序（`source_index`）。 */
  #toolIndex = 0;
  #toolCalls = 0;
  readonly #invocations = new Map<string, string>();
  readonly #usage = emptyUsage();

  constructor(options: EntryRecorderOptions) {
    this.#store = options.store;
    this.#sessionId = options.sessionId;
    this.#runId = options.runId;
    this.#provider = options.provider;
    this.#model = options.model;
    this.#leaf = options.leafEntryId;
    this.#onActivity = options.onActivity ?? null;
    this.#log = options.log ?? noopLog;
  }

  /** 当前 leaf（`runs.end_entry_id` / `updateSessionHead` 用它）。 */
  get leafEntryId(): string | null {
    return this.#leaf;
  }

  /** 累计用量（Run 结果里要写它）。 */
  get usage(): Usage {
    return this.#usage;
  }

  /** 工具调用次数（含失败的）。 */
  get toolCalls(): number {
    return this.#toolCalls;
  }

  /** 当前轮次（从 1 起）。 */
  get turn(): number {
    return this.#turn;
  }

  /**
   * 循环的原生事件 → 存储。挂到 `AgentLoopOptions.onAgentEvent`。
   */
  async onAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "turn_start":
        this.#turn += 1;
        this.#toolIndex = 0;
        if (this.#onActivity !== null) await this.#onActivity();
        return;
      case "message_end": {
        const message = event.message;
        if (message.role === "user") {
          await this.#append(message);
          return;
        }
        if (message.role === "assistant") {
          const usage = message.usage;
          await this.#append(message, {
            usage: {
              kind: "main",
              provider: this.#provider,
              model: this.#model,
              inputTokens: usage?.inputTokens ?? 0,
              outputTokens: usage?.outputTokens ?? 0,
              cacheReadTokens: usage?.cacheReadInputTokens ?? 0,
              cacheWriteTokens: usage?.cacheCreationInputTokens ?? 0,
            },
          });
          if (usage !== undefined) accumulateUsage(this.#usage, usage);
          return;
        }
        if (message.role === "toolResult") {
          this.#toolCalls += 1;
          await this.#settle(message);
          return;
        }
        return;
      }
      case "note":
        this.#leaf = await this.#store.appendEntry(
          this.#sessionId,
          this.#runId,
          entryForNote(event.kind, event.message, { turn: this.#turn, parentId: this.#leaf }),
        );
        return;
      default:
        return;
    }
  }

  /**
   * 包装工具：**执行之前**记一条 intent（带预留的结果 entry id）。
   * 失败（execute 抛异常）不在这里结算——循环会把异常变成 `isError` 的 toolResult，
   * 由 `message_end` 那条路统一结算。"有结果就有结算"只有一处实现。
   */
  wrapTools(tools: readonly AgentTool[]): AgentTool[] {
    return tools.map((tool) => this.#wrapTool(tool));
  }

  /**
   * 收尾：还停在 intent 的调用标成 `interrupted`。
   * M2 只保证它们**可见**（M3 才做恢复动作，设计文档 §G.3）。
   */
  async interruptRemaining(): Promise<void> {
    for (const invocation of await this.#store.listInvocations(this.#runId, "intent")) {
      await this.#store.interruptInvocation(invocation.id);
    }
  }

  // -------------------------------------------------------------- 内部

  async #append(message: AgentMessage, opts?: { usage?: Omit<UsageRow, "entryId"> }): Promise<void> {
    this.#leaf = await this.#store.appendEntry(
      this.#sessionId,
      this.#runId,
      entryForMessage(message, { parentId: this.#leaf }),
      opts === undefined ? {} : { usage: opts.usage },
    );
  }

  /** 工具结果：有 intent 就结算（同事务落 entry），没有就当成普通消息追加。 */
  async #settle(message: ToolResultMessage): Promise<void> {
    const invocationId = this.#invocations.get(message.toolCallId) ?? null;
    if (invocationId === null) {
      // 工具**没执行**（名字不存在 / 参数校验失败 / 被守卫拦下）：没有 intent 可结算，
      // 但结果仍要进历史（模型下一轮要看得到"它为什么失败"）。
      await this.#append(message);
      return;
    }
    this.#invocations.delete(message.toolCallId);
    this.#leaf = await this.#store.settleToolInvocation(invocationId, {
      entry: entryForMessage(message, { parentId: this.#leaf }),
      isError: message.isError,
      bytes: resultBytesOf(message),
    });
  }

  #wrapTool(tool: AgentTool): AgentTool {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const sourceIndex = this.#toolIndex;
        this.#toolIndex += 1;
        const invocationId = await this.#store.beginToolInvocation({
          sessionId: this.#sessionId,
          runId: this.#runId,
          turn: Math.max(this.#turn, 1),
          sourceIndex,
          tool: tool.name,
          args: params,
          replay: tool.replay ?? "never",
        });
        this.#invocations.set(toolCallId, invocationId);
        this.#log("info", `工具 ${tool.name} 记了一条 intent`, { invocationId, sourceIndex, turn: this.#turn });
        return tool.execute(toolCallId, params as never, signal, onUpdate);
      },
    } as AgentTool;
  }
}

/** 工具结果的正文字节数（`result_bytes`）。按 M0 的口径：文本块的 UTF-8 字节。 */
export function resultBytesOf(message: Pick<ToolResultMessage, "content">): number {
  let bytes = 0;
  for (const block of message.content) {
    if (block.type === "text") bytes += Buffer.byteLength(block.text, "utf8");
  }
  return bytes;
}
