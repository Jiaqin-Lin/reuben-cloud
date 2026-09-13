/**
 * `session/requests.ts` —— 每轮模型调用看到的编译产物落库（Phase 2；spec P2 §4）。
 *
 * 【这张表回答什么问题】"第 7 轮模型到底收到了什么"。transcript（M0）回答过一次，
 * 但它是一次 Run 一个文件、事后上传对象存储；进了 Postgres 之后，回放（P10 的
 * `replayContext`）才能从 `(session, run, turn)` 直接取到那一轮的输入，而不是靠"翻文件"。
 *
 * 【内联还是对象存储：256 KiB 是唯一的判据】
 * ```
 * serialized_messages ≤ 256 KiB  →  inline_messages（jsonb）
 * 否则                            →  对象存储 key = requests/<session>/<run>/<turn>.json.gz
 * ```
 * 【为什么 key 比 spec 多一段 run_id】spec 写的是 `requests/{session_id}/{turn}.json.gz`，
 * 但 turn 只在一次执行内唯一——同一个会话的第二轮 Run 会覆写第一轮的输入，回放直接错。
 * 带上 run_id 之后 key 是"一次执行的某一轮"，与"entries 挂会话、run 标段落"是同一套结构。
 *
 * 【没配对象存储怎么办】内联。理由：object 存储是可选的部署形态（本地开发、单测），
 * 而"这一轮的输入"是回放的唯一证据；宁可让一行 jsonb 大一点，也不要一个空洞。
 * 记一条 warn 让容量问题可见（真出现几 MB 的 request，说明该配对象存储了）。
 *
 * 【compiled_hash 由谁算】P10 的 ContextCompiler 会给一个（分区的 hash + system +
 * tools_hash + 消息序列化）。在它出现之前，这里按**同一个公式**自己算一份——
 * "相同输入必须得到相同 hash"这条性质从 P2 就要成立，否则 P10 的回放测试没法比。
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import type { LlmMessage, SectionStat } from "@reuben-cloud/agent-runtime";
import type { SessionStore } from "@reuben-cloud/agent-runtime";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

/** 内联的上限（spec 的 256 KiB）。超过就走对象存储。 */
export const INLINE_LIMIT_BYTES = 256 * 1024;

/** 对象存储里 key 的前缀。只允许这一个前缀被读回（与 Phase 7 的日志代理同一条规矩）。 */
export const REQUEST_KEY_PREFIX = "requests/";

export interface RecordRequestInput {
  sessionId: string;
  runId: string;
  /** 本次执行内的轮次号（从 1 起，与 transcript / entries 的口径一致）。 */
  turn: number;
  /** 这一轮真的发给模型的 system。 */
  system: string;
  /** 这一轮真的发给模型的消息（`convertToLlm` 之后）。 */
  messages: LlmMessage[];
  /** 发给模型的工具定义（用来算 tools_hash 与分区统计）。 */
  tools?: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>;
  /** 分区统计（P10 的 ContextCompiler 给）。不给就按 system / tools / history 三块估一份。 */
  sections?: SectionStat[];
  /** 覆盖 tools_hash（P10 用编译产物的）。 */
  toolsHash?: string;
  /** 覆盖 compiled_hash（P10 用编译产物的）。 */
  compiledHash?: string;
  /** 这一轮的主用量行 id（有就写上，回放与账本对得上）。 */
  usageId?: string | null;
}

export interface RequestRecorderOptions {
  store: SessionStore;
  /** 对象存储。不给 = 一律内联（见文件头）。 */
  artifactStore?: ArtifactStore | null;
  inlineLimitBytes?: number;
  log?: LogFn;
}

/**
 * 记录器。**每轮调用一次**，失败只记日志（不抛）：落不下"模型看到了什么"是证据链
 * 的折扣，不该让一次已经跑了几十分钟的执行归零（与 transcript 的写失败同一条规矩）。
 */
export class RequestRecorder {
  readonly #store: SessionStore;
  readonly #artifactStore: ArtifactStore | null;
  readonly #inlineLimitBytes: number;
  readonly #log: LogFn;

  constructor(options: RequestRecorderOptions) {
    this.#store = options.store;
    this.#artifactStore = options.artifactStore ?? null;
    this.#inlineLimitBytes = options.inlineLimitBytes ?? INLINE_LIMIT_BYTES;
    this.#log = options.log ?? noopLog;
  }

  /** 记一轮。失败只记日志（不抛）——证据链的折扣不该让一次执行归零。 */
  async record(input: RecordRequestInput): Promise<void> {
    try {
      await this.#record(input);
    } catch (error) {
      this.#log("warn", `model_requests 落库失败（回放会缺这一轮）`, {
        sessionId: input.sessionId,
        runId: input.runId,
        turn: input.turn,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  async #record(input: RecordRequestInput): Promise<void> {
    const serializedMessages = JSON.stringify(input.messages ?? null);
    const bytes = Buffer.byteLength(serializedMessages, "utf8");
    const toolsHash = input.toolsHash ?? hashTools(input.tools);
    const sections = input.sections ?? estimateSections(input);
    const compiledHash =
      input.compiledHash ?? computeCompiledHash({ sections, system: input.system, toolsHash, serializedMessages });

    const spill = bytes > this.#inlineLimitBytes;
    let inlineMessages: unknown = null;
    let objectKey: string | null = null;
    if (!spill) {
      inlineMessages = input.messages ?? null;
    } else if (this.#artifactStore === null) {
      inlineMessages = input.messages ?? null;
      this.#log("warn", `这一轮的输入有 ${bytes} 字节但没配对象存储，仍然内联（回放完整，代价是行很大）`, {
        runId: input.runId,
        turn: input.turn,
      });
    } else {
      objectKey = requestObjectKey(input.sessionId, input.runId, input.turn);
      await this.#artifactStore.put(objectKey, Readable.from([gzipSync(Buffer.from(serializedMessages, "utf8"))]));
    }

    await this.#store.recordRequest({
      sessionId: input.sessionId,
      runId: input.runId,
      turn: input.turn,
      compiledHash,
      sections,
      system: input.system,
      toolsHash,
      usageId: input.usageId ?? null,
      inlineMessages,
      objectKey,
      bytes,
    });
  }

  /**
   * 读回外置的 messages（导出与 P10 的 `replayContext` 用）。
   * **只允许 `requests/` 前缀**：这个读取器将来可能被一个 HTTP 回放接口复用，
   * 前缀限制是那里的第一道门（现在是这里唯一的一道）。
   */
  async readSpilled(objectKey: string): Promise<unknown | null> {
    if (!objectKey.startsWith(REQUEST_KEY_PREFIX)) {
      throw new Error(`只允许读 ${REQUEST_KEY_PREFIX} 前缀的对象：${objectKey}`);
    }
    if (this.#artifactStore === null) return null;
    const stream = await this.#artifactStore.get(objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")) as unknown;
  }
}

/** 对象 key：`requests/<session>/<run>/<turn>.json.gz`（比 spec 多一段 run_id，见文件头）。 */
export function requestObjectKey(sessionId: string, runId: string, turn: number): string {
  return `${REQUEST_KEY_PREFIX}${sessionId}/${runId}/${String(turn).padStart(3, "0")}.json.gz`;
}

// ---------------------------------------------------------------- 哈希与统计

/**
 * `compiled_hash` 的公式（spec P2 §4）：sections 的 hash 列表 + system + tools_hash +
 * 消息序列化。**顺序固定**，所以相同输入必然得到相同 hash——它是"上下文是否真的稳定"
 * 的唯一客观证据。
 */
export function computeCompiledHash(input: {
  sections: readonly SectionStat[];
  system: string;
  toolsHash: string;
  serializedMessages: string;
}): string {
  const parts = [
    ...input.sections.map((section) => `${section.name}:${section.hash}`),
    input.system,
    input.toolsHash,
    input.serializedMessages,
  ];
  return sha256(parts.join("\n"));
}

/** 工具定义的 hash：按名字排序后逐个拼，**顺序无关**（registry 的推荐顺序不该影响指纹）。 */
export function hashTools(tools?: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>): string {
  if (tools === undefined || tools.length === 0) return sha256("");
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(sorted.map((tool) => `${tool.name}:${tool.description}:${JSON.stringify(tool.inputSchema)}`).join("\n"));
}

/**
 * P2 的三块占位统计（P10 的 ContextCompiler 会传真正的分区表）。
 * token 用 `chars/4` 估——与 P3 的 `tokens.ts` 同一个口径（届时那份实现会成为唯一出处）。
 */
export function estimateSections(input: Pick<RecordRequestInput, "system" | "messages" | "tools">): SectionStat[] {
  const system = input.system;
  const tools = JSON.stringify(input.tools ?? []);
  const history = JSON.stringify(input.messages ?? []);
  return [
    { name: "system", tokens: estimateTokens(system), hash: sha256(system) },
    { name: "tools", tokens: estimateTokens(tools), hash: sha256(tools) },
    { name: "history", tokens: estimateTokens(history), hash: sha256(history) },
  ];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
