/**
 * `task.ts` —— 第一条 user 消息：issue 原文 + 任务书（Phase 1；从 M0 的 `prompt.ts` 迁出）。
 *
 * 【为什么任务书是 user 消息而不是 system】system 是缓存前缀的一部分，放进去会让
 * "缓存能命中"的前提变成"同一个 issue"——而每个 Run 的 issue 都不一样，等于每条前缀
 * 都要重写一次（设计文档 §E.1）。
 *
 * 【为什么任务书要写得这么具体】它是**唯一**能约束"模型行为"的地方（system 讲的是环境，
 * 工具 description 讲的是参数）。这里写的每一条都是 M0 真出过问题的地方：
 *  · "先读代码再动手"——不读就直接改，改错文件；
 *  · "改动尽量小"——把无关文件一起格式化；
 *  · "最后必须跑一次验证"——报告"已完成"而没有任何证据；
 *  · "不要 git commit/push"——改动是由外部程序取 diff 的，模型自己提交会打乱那条链路。
 */

import type { AgentMessage, UserMessage } from "../types.ts";
import { REPO_DIR } from "./system.ts";

export interface TaskPromptOptions {
  /** 覆盖仓库目录（测试用；生产不给）。 */
  repoDir?: string;
}

/**
 * 任务书。`issue` 是题面原文（PR 正文、重试时都用同一份）。
 *
 * 分隔线用 `---- issue ----` 而不是 Markdown 标题：issue 里本来可能有任何 Markdown，
 * 固定分隔线让"模型看到的是哪一段"没有歧义。
 */
export function buildTaskPrompt(issue: string, options: TaskPromptOptions = {}): string {
  const repoDir = options.repoDir ?? REPO_DIR;
  return [
    "请解决下面这个 issue。",
    "",
    "要求：",
    `- 先读代码搞清楚现状（ls / read / bash 都可以用），再动手。`,
    `- 改动尽量小，只碰和这个 issue 有关的文件。`,
    `- 最后必须跑一次测试或验证命令，并在总结里写出命令与结果。`,
    `- 不要执行 git commit / git push / git checkout：产出的形式是由外部程序从 ${repoDir} 取 diff。`,
    "",
    "---- issue ----",
    issue.trim(),
    "---- issue 结束 ----",
  ].join("\n");
}

/** 拼成循环的初始消息数组（`agentLoop` 的第一个参数）。 */
export function initialMessages(issue: string, options: TaskPromptOptions = {}): AgentMessage[] {
  const message: UserMessage = { role: "user", content: buildTaskPrompt(issue, options) };
  return [message];
}
