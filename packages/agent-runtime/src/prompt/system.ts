/**
 * `system.ts` —— 系统提示词的**分区组装**（Phase 1；M0 是一整段拼接的常量）。
 *
 * 【为什么要分分区】每块内容的更新频率、来源、预算都不一样：角色与规则是常量，
 * 沙箱事实来自环境构建（P7），技能清单来自仓库（P12），已改动文件来自工具调用（P10）。
 * 一整段拼接的结果是"改任何一处都要读整段"，而且没法单独测试某一块。
 *
 * 【缓存契约（不能破）】`buildSystemPrompt()` 的输出**必须字节稳定**：它每一轮都进
 * 缓存前缀（tools → system → messages，见 `model/client.ts` 的文件头）。所以：
 *  · 不支持 runId / 时间戳 / 当前 commit 这类会变的东西——要放就放**第一条 user 消息**里；
 *  · 分区顺序固定（这里是唯一出处）；
 *  · 同一个输入两次构造必须逐字节相同（有单测兜底）。
 *
 * 【这里只写模型从别处得不到的信息】"路径相对仓库根解析""没有网络出口""结果会被截断"
 * 这类事实在 schema description 或工具报错里说不到（或者说到时已经太晚）。凡是
 * schema description 能说清的事（参数形状、offset 语义），这里都不重复——重复只会让
 * 两处慢慢漂开（M0 的教训）。
 */

import { MAX_TOOL_BYTES, MAX_TOOL_LINES } from "../tools/truncate.ts";

/** 仓库在沙箱里的落点。工具层与提示词共用这一个常量（见文件头）。 */
export const REPO_DIR = "/workspace/repo";

/** 沙箱里的出网事实（P5-P7 会传更具体的白名单；P1 用这条默认）。 */
export const DEFAULT_EGRESS_NOTE =
  "沙箱里没有网络出口，只有依赖源（npm/pypi 等）可达；github.com 不可达，不要试图 git clone 或者 curl GitHub。";

export interface SandboxFacts {
  /** 模型心里的工作目录。 */
  repoDir: string;
  /** 出网事实。 */
  egress: string;
  /**
   * 环境健康事实（P7 的 degraded 说明）。`null` = 没有额外要说的。
   * 它是"结构化事实"而不是建议：degraded 环境下模型应当跳过集成测试。
   */
  health: string | null;
}

export interface SystemPromptSections {
  /** 沙箱事实（repoDir / egress / health）。缺省用默认值。 */
  sandbox?: Partial<SandboxFacts>;
  /** 技能清单（P12 的 XML；P1 一般为空）。 */
  skills?: string | null;
  /** 本次 Run 已改动的文件（P10 传；P1 不用）。**顺序由调用方排好**（确定性）。 */
  changedFiles?: readonly string[];
  /** 任务无关的追加提醒（例如"代理只放行依赖源"）。**必须字节稳定**。 */
  notes?: readonly string[];
}

/**
 * 角色与规则。**分区顺序的第一块**，也是唯一写死的一段。
 *
 * 规则里的每一条都对应一个真实踩过的坑（M0 的注释在各自文件里）；这里只保留
 * "模型不看就会犯错、且别处说不到"的那些。
 */
export const ROLE_PROMPT = [
  "你是一个在隔离沙箱里工作的编码 agent。你的每一轮工具调用都由外部程序执行，你只看到结果。",
  "",
  "规则：",
  "1. bash 收的是 shell 字符串：管道、重定向、&&、通配符都照常写（例如 \"npm test 2>&1 | tail -50\"）。",
  "2. 没有交互式 stdin：需要确认的命令要带 -y（如 npm init -y），任何等输入的程序会立刻读到 EOF 失败。",
  "3. 用 read 的 offset/limit 读大文件，不要用 cat；不要用 bash 递归列整个仓库，要列目录用 ls。",
  `4. 工具结果会被截断：单次最多 ${MAX_TOOL_LINES} 行或 ${Math.round(MAX_TOOL_BYTES / 1024)} KB。看到 "Use offset=N to continue" 就接着读；看到 "Full output: <path>" 就用 read 去读那个文件，不要重复跑同一条命令。`,
  "5. 改完代码要跑测试（或至少跑一个能证明改动有效的命令），然后才收工。失败就说清失败在哪，不要假装成功。",
  "6. 一次响应里可以并行发起多个工具调用；它们的结果会在同一条消息里回来。",
  "7. 结束时用一段简短的话说明：你改了什么、跑过什么命令、结果如何、还有什么没解决。",
].join("\n");

/** 沙箱事实分区。 */
export function buildSandboxSection(sandbox: Partial<SandboxFacts> = {}): string {
  const repoDir = sandbox.repoDir ?? REPO_DIR;
  const egress = sandbox.egress ?? DEFAULT_EGRESS_NOTE;
  const lines = [`工作目录是 ${repoDir}（相对路径按它解析，绝对路径也可以用）。${egress}`];
  if (sandbox.health !== null && sandbox.health !== undefined && sandbox.health !== "") {
    lines.push(sandbox.health);
  }
  return lines.join("\n");
}

/** 技能清单分区（P12 会产出 XML；这里只负责"放在哪、怎么拼"）。 */
export function buildSkillsSection(skills: string | null | undefined): string | null {
  if (skills === null || skills === undefined || skills.trim() === "") return null;
  return skills.trim();
}

/** "已改动文件"分区（P10 用它提醒模型"地图可能过期"）。 */
export function buildChangedFilesSection(changedFiles: readonly string[] | undefined): string | null {
  if (changedFiles === undefined || changedFiles.length === 0) return null;
  return `# 本次 Run 已改动（仓库地图可能过期）：${changedFiles.join(", ")}`;
}

/**
 * 组装系统提示词。**分区的顺序是契约**（缓存前缀按字节比较）：
 * 角色 → 沙箱事实 → 技能 → 已改动文件 → 追加提醒。
 *
 * 空分区**不产生空行**：不配置技能时，产物与"没有这一段代码"逐字节相同
 * （P10 的测试要点 11 就是这条：预留分区不能改变现状）。
 */
export function buildSystemPrompt(sections: SystemPromptSections = {}): string {
  const parts: string[] = [ROLE_PROMPT, buildSandboxSection(sections.sandbox)];
  const skills = buildSkillsSection(sections.skills);
  if (skills !== null) parts.push(skills);
  const changed = buildChangedFilesSection(sections.changedFiles);
  if (changed !== null) parts.push(changed);
  for (const note of sections.notes ?? []) {
    if (note.trim() !== "") parts.push(note.trim());
  }
  return parts.join("\n\n");
}
