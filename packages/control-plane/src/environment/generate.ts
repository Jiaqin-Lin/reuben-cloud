/**
 * `environment/generate.ts` —— LLM 生成环境 Dockerfile（spec Phase 6 §1）。
 *
 * 【这一层负责什么、不负责什么】它把"仓库信号 + 上一次的失败诊断"变成一段 prompt、把模型的
 * 回复变成一份 Dockerfile、并用同一套硬约束校验它。它**不**调 docker、不写数据库、不决定
 * 重试——那是 `build.ts` 与 `queue.ts` 的事。这样切的理由是可测性：prompt 的内容、代码块的
 * 解析、约束的拦截，都能用脚本化模型在没有网络、没有 docker 的情况下逐条断言。
 *
 * 【为什么生成请求要 `cache: "none"`】与 P3 的摘要同一条理由：一次性请求（同一份 prompt
 * 不会第二次出现），而缓存的断点在 system 那一个块上——写缓存比读贵，开了就是纯粹多花钱。
 *
 * 【为什么硬约束只有一份实现】约束的检查函数在 `infer.ts`（P5 的确定性渲染与 P6 的 LLM 输出
 * 走同一个 `checkDockerfileConstraints`）。附录 A-27 已经说明它为什么按"USER root 要切回"
 * 实现；这里只做转发，避免第二份规则表与第一份慢慢漂开。
 *
 * 【为什么 prompt 里要放"规则生成的基线"】P5 的推断已经把 FROM、devcontainer 的 features、
 * containerEnv 都落在了纸面上，这些是**仓库作者的事实**；让模型在它们之上加东西（系统库、
 * 全局工具），比让它从零写一份更稳，也更容易保住沙箱契约（sandbox-agent / uid 1000）。
 */

import { maxTokensFor } from "@reuben-cloud/agent-runtime";
import type { Content, ModelClient, ModelRequest, Usage } from "@reuben-cloud/agent-runtime";
import { baseImageRef, ENV_BASE_KINDS } from "./base-images.ts";
import type { BuildFailure } from "./build.ts";
import { logTail } from "./build.ts";
import { checkDockerfileConstraints } from "./infer.ts";
import type { RepoSignals } from "./types.ts";

/**
 * 生成逻辑的版本号。**P7 的缓存键要用它**（`cache.ts` 的 `BUILDER_VERSION`）。
 *
 * 【为什么由 P6 维护】它要回答的问题是"改了生成 prompt、改了 Layer 1、改了约束之后，
 * 旧的构建缓存还算数吗"。这三件事都在 P6 的范围内，所以常量跟着它们走；P7 只消费它。
 * 每次改 prompt / 约束 / 基础镜像矩阵，手动 +1。
 */
export const BUILDER_VERSION = 1;

/** 生成请求的输出上限：一份 Dockerfile 用不了多少；取模型上限与 8k 中较小的那个。 */
export const GENERATION_MAX_TOKENS = 8192;

/** prompt 里每个数组字段最多列多少项（信号是启发式采集的，长尾没有信息量）。 */
const PROMPT_LIST_LIMIT = 20;

/** prompt 里每行最多多少个字符（CI 命令可能是整段脚本）。 */
const PROMPT_LINE_LIMIT = 200;

// ---------------------------------------------------------------- 生成阶段的结构化失败

export type GenerationErrorReason =
  /** 模型调用失败（网络 / 401 / 400……）。 */
  | "model_error"
  /** 调用了、但没有可用的 Dockerfile 代码块。 */
  | "no_dockerfile_block"
  /** 被取消。 */
  | "aborted";

export class GenerationError extends Error {
  readonly reason: GenerationErrorReason;
  /** 模型返回的原文（可能为空）。`env_builds.dockerfile` 在生成失败时用它兜底。 */
  readonly raw: string;
  /** 调用失败前已经产生的用量（有就记进账本，没有就不记）。 */
  readonly usage: Usage | null;

  constructor(reason: GenerationErrorReason, message: string, options: { raw?: string; usage?: Usage | null } = {}) {
    super(message);
    this.name = "GenerationError";
    this.reason = reason;
    this.raw = options.raw ?? "";
    this.usage = options.usage ?? null;
  }
}

// ---------------------------------------------------------------- 端口

/** 一次生成请求：信号 + 规则基线 +（第 2 轮起）上一次的失败。 */
export interface GenerateInput {
  signals: RepoSignals;
  /** P5 的规则渲染结果（作为起点，见文件头）。 */
  baseline: string;
  /** 第二次及以后的尝试才有值。 */
  retry?: {
    previousDockerfile: string;
    failure: BuildFailure;
    /** 上一次构建日志的尾部（40 行）。 */
    logTail: string;
  } | null;
  signal?: AbortSignal;
}

export interface DockerfileGeneration {
  dockerfile: string;
  /** 模型返回的原文（记录与排障；`env_builds.dockerfile` 存的是清洗后的 dockerfile）。 */
  raw: string;
  usage: Usage | null;
  provider: string;
  model: string;
}

/** 生成器端口。真实现是 `ModelDockerfileGenerator`；脚本化假模型在测试里实现同一个接口。 */
export interface DockerfileGenerator {
  readonly provider: string;
  readonly model: string;
  generate(input: GenerateInput): Promise<DockerfileGeneration>;
}

// ---------------------------------------------------------------- prompt

export const ENV_GENERATION_SYSTEM_PROMPT = [
  "你是 reuben-cloud 的环境构建器：读一个仓库的信号，产出一份 Dockerfile。",
  "",
  "这个镜像的用途：在隔离沙箱里跑编码 agent（仓库内容会在之后灌进沙箱）。所以你装的是",
  "**系统级**依赖与工具（apt 包、全局 CLI、Python / Node 的系统库）；项目自己的依赖",
  "（npm ci / pip install / poetry install）由沙箱在启动时安装，不在这里做——构建上下文里",
  "没有仓库内容，那些命令在这里也跑不起来。",
  "",
  "硬约束（违反任何一条，这次结果会被直接拒绝，不会进入构建）：",
  `1. 第一条 FROM 必须是 Layer 1 镜像之一：${ENV_BASE_KINDS.map((kind) => baseImageRef(kind)).join("、")}`,
  "2. 不写 CMD / ENTRYPOINT：容器的启动命令由基础镜像决定",
  "3. 不写 COPY / ADD：构建上下文里只有这个 Dockerfile，没有仓库内容",
  "4. 需要 root 的步骤写成 USER root，并在装完后立刻 USER 1000:1000（默认用户必须非 root）",
  "5. 不写任何凭据（token / secret / password / private key / api key）",
  "6. 不写 `curl … | sh` / `wget … | sh` 这类下载即执行；要装工具走 apt / npm -g / pip",
  "7. 只装依赖与环境，不跑测试、不跑仓库里的构建命令",
  "",
  "输出：只输出一个 ```dockerfile 代码块，不要任何解释。",
].join("\n");

/** 一行一个事实的清单渲染（空数组给"（无）"，避免模型把空列表当成"这里可以随便发挥"）。 */
function bullet(label: string, values: readonly string[]): string {
  const items = values.slice(0, PROMPT_LIST_LIMIT).map((item) => item.replace(/\s+/g, " ").slice(0, PROMPT_LINE_LIMIT));
  const more = values.length > PROMPT_LIST_LIMIT ? `（还有 ${values.length - PROMPT_LIST_LIMIT} 条）` : "";
  return `- ${label}：${items.length === 0 ? "（无）" : `${items.join("、")}${more}`}`;
}

/** 把信号渲染成 prompt 的一段。**确定性**：只有输入的顺序（采集侧已归一化）。 */
export function renderSignalsForPrompt(signals: RepoSignals): string {
  const versions = Object.entries(signals.runtimeVersions)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([language, version]) => `${language} ${version}`);
  const lines = [
    "## 仓库信号",
    bullet("语言", signals.languages),
    bullet("包管理器", signals.packageManagers),
    bullet("运行时版本", versions),
    bullet("锁文件", signals.lockfiles),
    bullet("构建/测试入口（在沙箱里跑，不要在构建期跑）", [
      ...signals.makeTargets.map((target) => `make ${target}`),
      ...signals.scripts.map((script) => `npm run ${script}`),
    ]),
    bullet("CI 命令", signals.ciCommands),
    bullet("compose 服务（沙箱内起不了；依赖它们的测试会 degraded）", signals.services),
    `- 有 Dockerfile：${signals.hasDockerfile ? "是" : "否"}；有 compose：${signals.hasCompose ? "是" : "否"}；有 devcontainer：${signals.hasDevcontainer ? "是" : "否"}`,
    `- monorepo：${signals.monorepo ? "是（一个仓库一个环境，命令在根目录跑）" : "否"}`,
  ];
  if (signals.ignored.length > 0) {
    // 忽略项是"仓库里写了、但推断没吃下"的事实。不列出来，模型会把缺失当成"仓库没有"。
    const ignored = signals.ignored
      .slice(0, PROMPT_LIST_LIMIT)
      .map((item) => `${item.source}#${item.field}（${item.reason}）`)
      .join("；");
    const more = signals.ignored.length > PROMPT_LIST_LIMIT ? `（还有 ${signals.ignored.length - PROMPT_LIST_LIMIT} 条）` : "";
    lines.push(`- 未采纳的字段：${ignored}${more}`);
  }
  return lines.join("\n");
}

/** 第 2 轮起的"上一次尝试"段落：分类 + 一句诊断 + 日志尾部。 */
export function renderRetryForPrompt(retry: NonNullable<GenerateInput["retry"]>): string {
  const detail = retry.failure.detail === null ? "" : `（${retry.failure.detail}）`;
  const tail = logTail(retry.logTail);
  const lines = [
    "## 上一次尝试（这一份没有成功）",
    `错误分类：${retry.failure.klass}`,
    `诊断${detail}：${retry.failure.advice}`,
    "",
    "上一次的 Dockerfile：",
    "```dockerfile",
    retry.previousDockerfile.trimEnd(),
    "```",
  ];
  if (tail.trim() === "") {
    // 生成失败 / 约束违规的那一轮没进过构建：别给模型看一个空日志块，那会被当成"没有输出"。
    lines.push("", "（这一轮没有构建日志：上一次没有进入构建。）");
  } else {
    lines.push("", "构建日志尾部：", "```", tail, "```");
  }
  return lines.join("\n");
}

/** 完整的用户消息（system 之外的一切）。 */
export function buildGenerationUserMessage(input: GenerateInput): string {
  const parts = [
    renderSignalsForPrompt(input.signals),
    "",
    "## 规则生成的基线（可以原样保留；要改就整份输出）",
    "```dockerfile",
    input.baseline.trimEnd(),
    "```",
  ];
  if (input.retry !== undefined && input.retry !== null) {
    parts.push("", renderRetryForPrompt(input.retry));
  }
  parts.push("", "现在输出你决定的 Dockerfile（一个 ```dockerfile 代码块，不要解释）。");
  return parts.join("\n");
}

// ---------------------------------------------------------------- 回复解析

export type ParseResult = { ok: true; dockerfile: string } | { ok: false; error: string };

/**
 * 从模型回复里取出 Dockerfile。
 *
 * 两种形态都接受：带围栏的代码块（prompt 要求的形态）、以及"整段回复就是 Dockerfile"
 * （以注释或 FROM 开头）。**后者不是宽容，是省一次尝试**：模型漏了围栏时内容往往是对的，
 * 为格式重跑一轮要花一次构建 + 一次模型调用。
 * 其余情况如实失败（`generation_failed`），由自愈循环把"没有代码块"这条诊断喂回去。
 */
export function parseDockerfileBlock(text: string): ParseResult {
  const fenced = /```[ \t]*[A-Za-z]*[ \t]*\r?\n([\s\S]*?)```/.exec(text);
  if (fenced !== null) {
    const body = fenced[1]!.trim();
    if (body === "") return { ok: false, error: "```dockerfile 代码块是空的" };
    return { ok: true, dockerfile: ensureTrailingNewline(body) };
  }
  const bare = text.trim();
  if (bare !== "" && looksLikeDockerfile(bare)) {
    return { ok: true, dockerfile: ensureTrailingNewline(bare) };
  }
  return { ok: false, error: "回复里没有 ```dockerfile 代码块（也没有以 FROM 开头的内容）" };
}

/** 第一条有内容的指令是不是 FROM（注释与空行不算）——"整段就是 Dockerfile"的判据。 */
function looksLikeDockerfile(text: string): boolean {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return /^FROM\b/i.test(trimmed);
  }
  return false;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** 硬约束校验（转发到 P5 的实现：约束只有一份，见文件头）。空数组 = 通过。 */
export function validateGeneratedDockerfile(text: string): string[] {
  return checkDockerfileConstraints(text);
}

// ---------------------------------------------------------------- 模型实现

export interface ModelDockerfileGeneratorOptions {
  /** 生成用的模型。缺省由调用方给 `modelFromEnv()`（CP 是唯一读 key 的地方）。 */
  model: ModelClient;
  maxTokens?: number;
}

/** 真生成器：一次流式调用取终态（与 P3 的摘要同一条路径：流是唯一真相）。 */
export class ModelDockerfileGenerator implements DockerfileGenerator {
  readonly #model: ModelClient;
  readonly #maxTokens: number;

  constructor(options: ModelDockerfileGeneratorOptions) {
    this.#model = options.model;
    this.#maxTokens = options.maxTokens ?? Math.min(GENERATION_MAX_TOKENS, maxTokensFor(options.model.model));
  }

  get provider(): string {
    return this.#model.provider;
  }

  get model(): string {
    return this.#model.model;
  }

  async generate(input: GenerateInput): Promise<DockerfileGeneration> {
    const request: ModelRequest = {
      system: ENV_GENERATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: buildGenerationUserMessage(input) }] }],
      tools: [],
      maxTokens: this.#maxTokens,
      // 一次性请求：不写 prompt cache（与 P3 的摘要同一条理由，见文件头）。
      cache: "none",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const stream = this.#model.stream(request);
    // 只要终态；消费流是因为"流是唯一真相"。
    for await (const _event of stream) {
      // 不需要中间事件。
    }
    const message = await stream.result();
    const raw = textOf(message.content).trim();
    const usage = message.usage ?? null;

    if (message.stopReason === "aborted") {
      throw new GenerationError("aborted", "生成请求被取消", { raw, usage });
    }
    if (message.stopReason === "error" || message.stopReason === undefined) {
      throw new GenerationError("model_error", `生成请求失败：${message.errorMessage ?? "未知原因"}`, { raw, usage });
    }
    const parsed = parseDockerfileBlock(raw);
    if (!parsed.ok) {
      throw new GenerationError("no_dockerfile_block", parsed.error, { raw, usage });
    }
    return { dockerfile: parsed.dockerfile, raw, usage, provider: this.provider, model: this.model };
  }
}

/** 文本块拼接（与 compaction 的 contentText 同语义；不导出内容类型的内部细节）。 */
function textOf(content: readonly Content[]): string {
  return content
    .filter((block): block is Extract<Content, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
