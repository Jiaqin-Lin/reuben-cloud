/**
 * `prompt.ts` —— 系统提示词与任务提示词（Phase 11 §6）。
 *
 * 【为什么这么短】提示词是要迭代的东西，第一版写长了反而不好改（§6 的原话）。
 * 这里只写**模型从别处得不到的信息**：它在哪、`cmd` 是 argv、没有 stdin、没有 GitHub、
 * 改完要跑测试、输出要节制、工具结果会被截断。凡是 schema description 或工具报错能说清
 * 的事（参数形状、offset 语义），这里都不重复——重复只会让两处慢慢漂开。
 *
 * 【为什么 REPO_DIR 是个常量而不是配置】它是**契约**：工具层把相对路径按它解析
 * （`path.resolve(REPO_DIR, input)`），system prompt 说的工作目录也是它，Phase 9 的
 * 灌入落点还是它。三处必须字面一致，所以只有一个出处。
 *
 * 【缓存注意】`buildSystemPrompt()` 的输出**必须字节稳定**：它每一轮都进缓存前缀
 * （tools → system，见 `model.ts` 的文件头）。所以这里不接受 runId / 时间戳 / 当前
 * commit 之类的参数——要放这些信息就放**第一条 user 消息**里。
 */

import type { Message } from "./model.ts";

/** 仓库在沙箱里的落点。工具层与提示词共用这一个常量（见文件头）。 */
export const REPO_DIR = "/workspace/repo";

/** 工具结果的硬上限（与 `tools/truncate.ts` 同源，这里只用来说给模型听）。 */
export const TOOL_LINE_LIMIT = 2000;
export const TOOL_BYTE_LIMIT = 50 * 1024;

export interface SystemPromptOptions {
  /** 覆盖仓库目录（测试用；生产不给）。 */
  repoDir?: string;
  /** 追加的部署相关提醒（例如"代理只放行依赖源"）。**必须字节稳定**。 */
  notes?: readonly string[];
}

/**
 * 系统提示词。每一轮都原样重发，且是缓存前缀的一部分——**不要在这里插会变的东西**。
 */
export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  const repoDir = options.repoDir ?? REPO_DIR;
  const lines = [
    "你是一个在隔离沙箱里工作的编码 agent。你的每一轮工具调用都由外部程序执行，你只看到结果。",
    "",
    `工作目录是 ${repoDir}（相对路径按它解析，绝对路径也可以用）。沙箱里没有网络出口，只有依赖源（npm/pypi 等）可达；github.com 不可达，不要试图 git clone 或者 curl GitHub。`,
    "",
    "规则：",
    `1. bash 的 cmd 是 argv 数组，不是 shell 字符串。需要管道、重定向、&& 时显式写 ["bash","-lc","…"]。`,
    "2. 没有交互式 stdin：需要确认的命令要带 -y（如 npm init -y），任何等输入的程序会立刻读到 EOF 失败。",
    "3. 用 read 的 offset/limit 读大文件，不要用 cat；不要 ls -R 整个仓库。",
    `4. 工具结果会被截断：单次最多 ${TOOL_LINE_LIMIT} 行或 ${Math.round(TOOL_BYTE_LIMIT / 1024)} KB。看到 "Use offset=N to continue" 就接着读；看到 "Full output: <path>" 就用 read 去读那个文件，不要重复跑同一条命令。`,
    "5. 改完代码要跑测试（或至少跑一个能证明改动有效的命令），然后才收工。失败就说清失败在哪，不要假装成功。",
    "6. 一次响应里可以并行发起多个工具调用；它们的结果会在同一条消息里回来。",
    "7. 结束时用一段简短的话说明：你改了什么、跑过什么命令、结果如何、还有什么没解决。",
  ];
  if (options.notes !== undefined && options.notes.length > 0) {
    lines.push("", ...options.notes);
  }
  return lines.join("\n");
}

/**
 * 第一条 user 消息：issue 原文 + 任务说明。
 *
 * 【为什么 issue 放这里而不是 system】system 是缓存前缀，放进去会让缓存命中的前提变成
 * "同一个 issue"——而每个 Run 的 issue 都不一样，等于每条前缀都要重写一次（§6）。
 */
export function buildTaskPrompt(issue: string, options: SystemPromptOptions = {}): string {
  const repoDir = options.repoDir ?? REPO_DIR;
  return [
    "请解决下面这个 issue。",
    "",
    "要求：",
    `- 先读代码搞清楚现状（list / read / bash 都可以用），再动手。`,
    `- 改动尽量小，只碰和这个 issue 有关的文件。`,
    `- 最后必须跑一次测试或验证命令，并在总结里写出命令与结果。`,
    `- 不要执行 git commit / git push / git checkout：产出的形式是由外部程序从 ${repoDir} 取 diff。`,
    "",
    "---- issue ----",
    issue.trim(),
    "---- issue 结束 ----",
  ].join("\n");
}

/** 把两条提示词拼成循环的初始消息数组。 */
export function initialMessages(issue: string, options: SystemPromptOptions = {}): Message[] {
  return [{ role: "user", content: buildTaskPrompt(issue, options) }];
}
