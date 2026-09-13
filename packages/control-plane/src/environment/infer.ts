/**
 * `environment/infer.ts` —— 三级推断（spec Phase 5 §4）与环境 Dockerfile 的确定性渲染。
 *
 * 【这一级产出什么】一个 `EnvironmentCandidate`：选中的 Layer 1 基础镜像 + 一份**完整、可构建、
 * 逐字节可复现**的 Dockerfile 文本 + 建议的构建/验证命令 + 降级风险 + 人话说明。
 *
 * 【为什么 Dockerfile 是完整文本而不是片段】"能不能构建"这个问题的答案必须只有一个地方：
 * 片段形态会让答案分散在"拼装代码 + 模板 + 基础镜像内容"三处，而 P6 的 LLM 生成、P7 的
 * 缓存键都要求"这份文本就是事实"。
 *
 * 【为什么 L2 不复用仓库的 Dockerfile】设计文档 §C.3 写的是"复用 + 叠加 agent 必需组件"，
 * M2 的实现是：**只把它的 FROM 当语言信号**，FROM 仍然落在 Layer 1 矩阵里。原因是硬约束
 * 与隔离面：沙箱镜像必须含 sandbox-agent、非 root uid 1000 与环境变量契约，而仓库的
 * Dockerfile `COPY . .` 依赖构建上下文里的仓库内容——那个上下文在环境构建期不存在
 * （仓库是创建沙箱时灌进去的）。这也是 spec 测试要点 7 断言的形态（附录 A-24）。
 *
 * 【为什么要 `checkDockerfileConstraints`】同一套硬约束 P5 的确定性渲染与 P6 的 LLM 输出
 * 都要过。放在这里而不是 P6：约束在"生成"这一侧，而不是"构建"那一侧。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { baseImageRef, BASE_IMAGE_KINDS } from "./base-images.ts";
import type { BaseImageKind, EnvBaseKind } from "./base-images.ts";
import { featureAction, parseDevcontainer } from "./devcontainer.ts";
import type { DevcontainerParseResult, DevcontainerSpec } from "./devcontainer.ts";
import { collectSignals, normalizeIgnored, normalizeSignals } from "./signals.ts";
import type { CollectOptions } from "./signals.ts";
import type { EnvironmentCandidate, InferenceLevel, RepoSignals } from "./types.ts";

/** 语言 → 工具链家族。矩阵里没有的家族（ruby/java/…）在这里就是"认不出"。 */
type Family = "node" | "python" | "go" | "rust";

const LANGUAGE_FAMILY: Record<string, Family> = {
  javascript: "node",
  typescript: "node",
  python: "python",
  go: "go",
  rust: "rust",
};

/** 家族 → 基础镜像档。node+python 的组合另有 fullstack（见 pickBaseKind）。 */
const FAMILY_KIND: Record<Family, EnvBaseKind> = {
  node: "node-dev",
  python: "python-dev",
  go: "go-dev",
  rust: "rust-dev",
};

export interface InferInput {
  signals: RepoSignals;
  /** `parseDevcontainer()` 的结果；`null` = 没有 devcontainer.json。 */
  devcontainer: DevcontainerParseResult | null;
  /** 仓库 Dockerfile（或 devcontainer 的 build.dockerfile）里的 FROM 镜像（已挑过语言）。 */
  dockerfileBaseImage: string | null;
}

export interface InferenceResult {
  /** 采集 + 归一化之后的信号（**已并入 devcontainer 的 ignored**）。 */
  signals: RepoSignals;
  devcontainer: DevcontainerSpec | null;
  dockerfileBaseImage: string | null;
  candidate: EnvironmentCandidate;
}

/**
 * 从一个 clone 目录推断环境。这是 P5 的**主入口**：采集 → 解析 devcontainer →
 * 推断 → 渲染，四步都在这里，调用方（脚本 / P6 / P7 / 测试）不需要知道顺序。
 */
export async function inferFromClone(cloneDir: string, options: CollectOptions = {}): Promise<InferenceResult> {
  const collected = await collectSignals(cloneDir, options);
  const devcontainer = await parseDevcontainer(cloneDir);
  const signals = normalizeSignals({
    ...collected,
    ignored: [...collected.ignored, ...devcontainer.ignored],
  });
  const dockerfileBaseImage = await readDockerfileBaseImage(
    cloneDir,
    devcontainer.spec?.build?.dockerfile ?? "Dockerfile",
  );
  const candidate = inferEnvironment({ signals, devcontainer, dockerfileBaseImage });
  return { signals, devcontainer: devcontainer.spec, dockerfileBaseImage, candidate };
}

/**
 * 纯推断：给定信号与 devcontainer 结果，产出候选。**不碰文件系统**，所以单测可以直接构造输入。
 */
export function inferEnvironment(input: InferInput): EnvironmentCandidate {
  const { signals, devcontainer, dockerfileBaseImage } = input;
  const spec = devcontainer?.spec ?? null;
  const notes: string[] = [];
  const degradedRisks: string[] = [];

  // ---- 三级判定（设计文档 §C.3 的顺序：devcontainer > Dockerfile/compose > 信号）
  let level: InferenceLevel;
  if (spec !== null) {
    level = "devcontainer";
    notes.push("命中 L1：仓库有 .devcontainer/devcontainer.json（作者自己写的环境定义，比任何推断都准）");
  } else if (signals.hasDockerfile || signals.hasCompose) {
    level = "dockerfile";
    notes.push("命中 L2：仓库有 Dockerfile / compose，但没有 devcontainer");
  } else {
    level = "signals";
    notes.push("命中 L3：既没有 devcontainer 也没有 Dockerfile / compose，按仓库信号推断");
  }
  if (devcontainer?.error != null) {
    // 语法错不是异常：降级到下一级，并把原因写出来（spec 测试要点 4）。
    notes.push(`devcontainer.json 读不懂，已降级到 ${level} 级：${devcontainer.error}`);
  }

  // ---- 基础镜像
  const base = pickBaseKind({ signals, spec, dockerfileBaseImage });
  notes.push(...base.notes);
  degradedRisks.push(...base.degradedRisks);

  // ---- devcontainer features 的逐条结论
  // 【为什么在这里而不是 pickBaseKind 里】feature 的四种结论（语言 / 装 / 已有 / 不支持）
  // 都要被记下来；语言那一类只影响基础镜像，其余三类是"用户能看见的降级或动作"。
  for (const feature of spec?.features ?? []) {
    const action = featureAction(feature.raw);
    if (action.kind === "unsupported") {
      notes.push(`devcontainer feature ${feature.id} 不支持：${action.reason}`);
      if (action.degraded !== null) degradedRisks.push(action.degraded);
    } else if (action.kind === "install") {
      notes.push(`devcontainer feature ${feature.id} → 在生成的 Dockerfile 里装（${action.note}）`);
    } else if (action.kind === "builtin") {
      notes.push(`devcontainer feature ${feature.id} 已经是 Layer 1 的一部分：${action.note}`);
    }
  }

  // ---- 忽略项的摘要（明细在 signals.ignored 里，那是 P6 的 prompt 与排障脚本要读的）
  if (signals.ignored.length > 0) {
    const byField = new Map<string, number>();
    for (const item of signals.ignored) byField.set(item.source, (byField.get(item.source) ?? 0) + 1);
    const summary = [...byField.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([source, count]) => `${source}(${count})`)
      .join("、");
    notes.push(`有 ${signals.ignored.length} 条字段被忽略：${summary}（每条的原因见 signals.ignored）`);
  }

  // ---- 命令
  const commands = inferCommands(signals, spec, notes);

  // ---- 服务依赖 → degraded
  for (const service of signals.services) {
    degradedRisks.push(`${service}：compose 里声明了它，而沙箱里起不了服务（M2 不跑 compose）——依赖它的集成测试不可用`);
  }
  if (signals.hasCompose && signals.services.length === 0) {
    degradedRisks.push("有 compose 文件但没解析出服务名（行级扫描）：集成测试能不能跑不确定");
  }
  if (signals.monorepo) {
    notes.push("monorepo：依赖安装与构建命令按根目录一把梭（M2 不做多项目拆分环境）");
  }

  const dockerfile = renderEnvDockerfile({
    level,
    baseImageKind: base.kind,
    signals,
    spec,
    dockerfileBaseImage,
  });

  return {
    level,
    baseImageKind: base.kind,
    baseImage: baseImageRef(base.kind),
    dockerfile,
    buildCommands: commands.buildCommands,
    verifyCommands: commands.verifyCommands,
    degradedRisks: dedupeStable(degradedRisks),
    notes: dedupeStable(notes),
  };
}

// ---------------------------------------------------------------- 基础镜像选择

interface BaseChoice {
  kind: EnvBaseKind;
  notes: string[];
  degradedRisks: string[];
}

/**
 * 挑 Layer 1 的哪一档。
 *
 * 优先级（从高到低）：
 *  ① devcontainer 的 features（作者显式声明的语言工具链）；
 *  ② 仓库 Dockerfile 的 FROM（L2 的"复用"落点：python:3.11-slim → base-python-dev）；
 *  ③ 语言信号（按文件数与入口排过序）。
 *
 * **node + python 一起出现 → fullstack**：这是矩阵里唯一为组合准备的档位，
 * 不选它的话另一个语言就得在会话里现装（而沙箱没有出网）。
 */
function pickBaseKind(input: {
  signals: RepoSignals;
  spec: DevcontainerSpec | null;
  dockerfileBaseImage: string | null;
}): BaseChoice {
  const notes: string[] = [];
  const degradedRisks: string[] = [];
  const families: Family[] = [];
  const push = (family: Family | null): void => {
    if (family !== null && !families.includes(family)) families.push(family);
  };

  // ① devcontainer features：把 feature 声明的语言排在最前（它是作者的显式声明）。
  const featureFamilies: Family[] = [];
  for (const feature of input.spec?.features ?? []) {
    const action = featureAction(feature.raw);
    if (action.kind !== "language") continue;
    if (!featureFamilies.includes(action.language)) featureFamilies.unshift(action.language);
  }
  for (const family of featureFamilies) push(family);
  if (featureFamilies.length > 0) {
    notes.push(`devcontainer feature 声明的语言：${featureFamilies.join(", ")}（优先于语言信号）`);
  }

  // ② 仓库 Dockerfile 的 FROM：没有 feature 声明时它排第一，有 feature 时排第二（两者都算语言声明）。
  const fromFamily = input.dockerfileBaseImage === null ? null : familyFromImage(input.dockerfileBaseImage);
  if (fromFamily !== null) {
    push(fromFamily);
    notes.push(
      `仓库 Dockerfile 的 FROM 是 ${input.dockerfileBaseImage} → ${FAMILY_KIND[fromFamily]}（只取语言，不复用它的构建：附录 A-24）`,
    );
  } else if (input.dockerfileBaseImage !== null) {
    notes.push(`仓库 Dockerfile 的 FROM 是 ${input.dockerfileBaseImage}：认不出语言工具链，只能按信号推断`);
  }

  // ③ 语言信号
  for (const language of input.signals.languages) {
    const family = LANGUAGE_FAMILY[language];
    if (family !== undefined) push(family);
  }

  if (families.length === 0) {
    notes.push("没有认出语言工具链：退化成 ubuntu-dev（它只有 build-essential，装依赖可能要在会话里做）");
    degradedRisks.push("没有认出语言：环境只保证能起 agent 与跑 shell，项目依赖可能装不上");
    return { kind: "ubuntu-dev", notes, degradedRisks };
  }

  if (families.includes("node") && families.includes("python")) {
    notes.push(`语言组合 ${families.join(" + ")} → fullstack（矩阵里唯一同时含 node 与 python 的档位）`);
    return { kind: "fullstack", notes, degradedRisks };
  }

  const primary = families[0]!;
  const kind = FAMILY_KIND[primary];
  notes.push(`基础镜像 ${kind}：主工具链 ${primary}（语言清单：${input.signals.languages.join(", ") || "无"}）`);
  if (families.length > 1) {
    const rest = families.slice(1);
    notes.push(`还认出了 ${rest.join(", ")}，但矩阵里没有这个组合的镜像：取第一个，其余语言要用的工具可能在会话里装不上`);
    degradedRisks.push(`${rest.join(" / ")} 的工具链不在选中的基础镜像里（矩阵没有这个组合）`);
  }
  return { kind, notes, degradedRisks };
}

/**
 * 镜像名 → 家族。
 *
 * 【为什么按分隔符切成 token 再比】镜像名里出现 `go` / `node` 这种短词的概率很高
 * （`typescript-node:20`、`golang:1.22`、`mongo:7`），而子串匹配会把 `mongo` 当成 `go`。
 * 切成 token 之后只有完整片段才算数：`typescript-node` → node，`mongo` → 认不出。
 */
export function familyFromImage(image: string): Family | null {
  const tokens = image.toLowerCase().split(/[/:@.]/).flatMap((piece) => piece.split("-"));
  const has = (names: string[]): boolean => names.some((name) => tokens.includes(name));
  if (has(["node", "nodejs", "bun", "deno"])) return "node";
  if (has(["python", "pypy", "uv"])) return "python";
  if (has(["go", "golang"])) return "go";
  if (has(["rust", "rustup", "cargo"])) return "rust";
  return null;
}

/**
 * 读仓库 Dockerfile（或 devcontainer 指的那个）里的 FROM。
 *
 * 【为什么挑"第一个认识的"而不是最后那个 stage】多阶段构建的最后一个 stage 常是
 * 运行时的瘦镜像（nginx / distroless），而 agent 需要的是**构建工具链**——它在前面的
 * stage 里。所以：优先返回第一个能认出语言的 FROM；都认不出就返回第一个 FROM（至少
 * 让 notes 说出"看到的是什么"）。
 */
export async function readDockerfileBaseImage(cloneDir: string, relativePath: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path.join(cloneDir, relativePath), "utf8");
  } catch {
    return null;
  }
  const images: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*FROM\s+(\S+)/i.exec(line);
    if (match !== null) images.push(match[1]!);
  }
  if (images.length === 0) return null;
  return images.find((image) => familyFromImage(image) !== null) ?? images[0]!;
}

// ---------------------------------------------------------------- 命令推断

/**
 * 建议的构建 / 验证命令。
 *
 * 【为什么 build 与 verify 分开】P7 的健康检查跑 build（装依赖 + 编译），
 * degraded 判据来自 verify（测试 / 编译检查能不能跑）。合成一个列表会让"装依赖成功了
 * 但测试跑不了"这种最重要的情况无法表达——而那正是 degraded 的定义。
 */
function inferCommands(
  signals: RepoSignals,
  spec: DevcontainerSpec | null,
  notes: string[],
): { buildCommands: string[]; verifyCommands: string[] } {
  const buildCommands: string[] = [];
  const verifyCommands: string[] = [];
  const manager = signals.packageManagers[0] ?? null;
  const has = (file: string): boolean => signals.lockfiles.includes(file);

  // devcontainer 的 postCreateCommand 是作者写的"装依赖"步骤，排在最前面。
  if (spec?.postCreateCommand != null) {
    buildCommands.push(spec.postCreateCommand);
    notes.push(`devcontainer 的 postCreateCommand 放在 buildCommands 第一条：${spec.postCreateCommand}`);
  }

  // 装依赖（按包管理器选一条，锁文件决定要不要 --frozen）。
  if (manager === "npm") buildCommands.push(has("package-lock.json") ? "npm ci" : "npm install");
  else if (manager === "pnpm") buildCommands.push(has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install");
  else if (manager === "yarn") buildCommands.push(has("yarn.lock") ? "yarn install --frozen-lockfile" : "yarn install");
  else if (manager === "uv") buildCommands.push("uv sync");
  else if (manager === "poetry") buildCommands.push("poetry install");
  else if (manager === "pip") {
    buildCommands.push(has("requirements.txt") ? "python3 -m pip install -r requirements.txt" : "python3 -m pip install -e .");
  } else if (manager === "cargo") buildCommands.push("cargo fetch");
  else if (manager === "go") buildCommands.push("go mod download");

  // 构建入口：Makefile 优先（它常常是仓库真正的构建入口），然后是 npm scripts。
  if (signals.makeTargets.includes("build")) buildCommands.push("make build");
  if (signals.scripts.includes("build")) buildCommands.push(npmRun(manager, "build"));

  // 验证命令。
  if (signals.makeTargets.includes("test")) verifyCommands.push("make test");
  if (signals.scripts.includes("test")) verifyCommands.push(npmRun(manager, "test"));
  const families = dedupeStable(signals.languages.map((item) => LANGUAGE_FAMILY[item]).filter(Boolean) as Family[]);
  if (families.includes("python")) verifyCommands.push("python3 -m compileall -q .");
  if (families.includes("go")) verifyCommands.push("go build ./...");
  if (families.includes("rust")) verifyCommands.push("cargo check");

  return {
    buildCommands: dedupeStable(buildCommands).slice(0, 6),
    verifyCommands: dedupeStable(verifyCommands).slice(0, 6),
  };
}

/** `npm run build` / `pnpm run build` / `yarn build` —— 各包管理器的"跑一个 script"。 */
function npmRun(manager: string | null, script: string): string {
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "pnpm") return `pnpm run ${script}`;
  return `npm run ${script}`;
}

// ---------------------------------------------------------------- Dockerfile 渲染

export interface RenderInput {
  level: InferenceLevel;
  baseImageKind: EnvBaseKind;
  signals: RepoSignals;
  spec: DevcontainerSpec | null;
  dockerfileBaseImage: string | null;
}

/**
 * 渲染环境 Dockerfile。
 *
 * 硬约束（与 P6 的生成结果共用 `checkDockerfileConstraints`）：
 *  ① 第一条 FROM 必须是 Layer 1 矩阵里的一个；② 不写 CMD / ENTRYPOINT（运行命令由
 *  基础镜像的 CMD 决定）；③ 不 COPY/ADD（构建上下文里没有仓库内容）；④ 任何
 *  `USER root` 之后必须切回非 root；⑤ 不出现凭据；⑥ 不出现 `curl | sh`。
 *
 * **确定性**：没有时间戳、没有随机值、map 全部按 key 排序。同一份输入两次渲染逐字节相同——
 * 这是 P7 的缓存键能命中的前提之一（`dockerfileText` 进 key）。
 */
export function renderEnvDockerfile(input: RenderInput): string {
  const { spec } = input;
  const lines: string[] = [];
  const levelText =
    input.level === "devcontainer" ? "L1 devcontainer" : input.level === "dockerfile" ? "L2 dockerfile" : "L3 signals";

  lines.push(`# 由 reuben-cloud 环境推断生成（Layer 2 · ${levelText}）。**不要手工修改这个文件**：`);
  lines.push("# 它是可复现的产物——改环境要么改推断规则（P5）、要么走 LLM 生成 + 自愈（P6）。");
  lines.push("#");
  lines.push(`# 依据：语言 ${input.signals.languages.join(", ") || "（无）"}` +
    `；包管理器 ${input.signals.packageManagers.join(", ") || "（无）"}` +
    `${input.signals.lockfiles.length > 0 ? `；锁文件 ${input.signals.lockfiles.join(", ")}` : ""}`);
  if (input.dockerfileBaseImage !== null) {
    lines.push(`# 仓库自己的 Dockerfile 起始于 ${input.dockerfileBaseImage}（只用来判断语言，不复用它的构建步骤）`);
  }
  if (input.signals.monorepo) lines.push("# monorepo：命令都在仓库根上跑（M2 一个仓库一个环境）");
  if (input.signals.services.length > 0) {
    lines.push(`# 已知服务依赖（沙箱内不可用，见 degradedRisks）：${input.signals.services.join(", ")}`);
  }
  lines.push(`FROM ${baseImageRef(input.baseImageKind)}`);

  // containerEnv：devcontainer 声明的环境变量照搬（它们是"这个项目怎么跑"的一部分）。
  const envEntries = Object.entries(spec?.containerEnv ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (envEntries.length > 0) {
    lines.push("");
    lines.push("# devcontainer 的 containerEnv");
    for (const [key, value] of envEntries) {
      lines.push(`ENV ${key}=${quoteValue(value)}`);
    }
  }

  // features：要装的东西合成一段 root 区（装完立刻切回 1000:1000）。
  const installs: Array<{ id: string; run: string; note: string }> = [];
  for (const feature of spec?.features ?? []) {
    const action = featureAction(feature.raw);
    if (action.kind === "install") installs.push({ id: feature.id, run: action.run, note: action.note });
  }
  if (installs.length > 0) {
    lines.push("");
    lines.push("# devcontainer features：需要 root 装包，装完立刻切回非 root（契约是 uid 1000）");
    lines.push("USER root");
    for (const install of installs) {
      lines.push(`# ${install.id}：${install.note}`);
      lines.push(install.run);
    }
    lines.push("USER 1000:1000");
  }

  // 命令只作为注释：它们要在沙箱里跑（仓库内容那时才在），构建期跑没有意义。
  if (input.signals.scripts.length > 0 || input.signals.makeTargets.length > 0) {
    lines.push("");
    lines.push(`# 仓库的构建入口（P7 的健康检查在沙箱里跑，不在构建期）：`);
    const entrypoints = [
      ...input.signals.makeTargets.map((target) => `make ${target}`),
      ...input.signals.scripts.map((script) => `npm run ${script}`),
    ];
    for (const entry of entrypoints.slice(0, 12)) lines.push(`#   ${entry}`);
  }

  return `${lines.join("\n")}\n`;
}

/** ENV 的值要能原样交给 shell：一律加双引号并转义 `"` 与 `\`。 */
function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 校验生成结果是否满足硬约束。返回违规说明（空数组 = 通过）。
 *
 * P5 的渲染与 P6 的 LLM 输出走同一个函数：约束只有一份实现，才不会出现
 * "规则生成能过、LLM 生成不能过"这种双标。
 */
export function checkDockerfileConstraints(text: string): string[] {
  const violations: string[] = [];
  const instructions = text
    .split("\n")
    // 续行：以 `\` 结尾的行的下一行属于同一条指令（拼起来才看得清 curl | sh）。
    .reduce<string[]>((acc, line) => {
      if (acc.length > 0 && acc[acc.length - 1]!.endsWith("\\")) acc[acc.length - 1] = `${acc[acc.length - 1]!.slice(0, -1)} ${line.trim()}`;
      else acc.push(line);
      return acc;
    }, [])
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  const allowed = new Set(BASE_IMAGE_KINDS.map((kind: BaseImageKind) => baseImageRef(kind)));
  const froms = instructions.filter((line) => /^FROM\s/i.test(line));
  if (froms.length === 0) violations.push("没有 FROM");
  for (const line of froms) {
    const image = line.replace(/^FROM\s+/i, "").split(/\s+/)[0]!;
    if (!allowed.has(image)) {
      violations.push(`FROM 不是 Layer 1 矩阵里的镜像：${image}（可选：${[...allowed].join(", ")}）`);
    }
  }
  for (const line of instructions) {
    if (/^(CMD|ENTRYPOINT)\b/i.test(line)) violations.push(`出现了 ${line.split(/\s+/)[0]}：运行命令由基础镜像的 CMD 决定`);
    if (/^(COPY|ADD)\b/i.test(line)) violations.push(`出现了 ${line.split(/\s+/)[0]}：构建上下文里没有仓库内容`);
    if (/(curl|wget)[^|]*\|\s*(ba|z)?sh\b/.test(line)) violations.push(`出现了"下载即执行"：${line.slice(0, 60)}…`);
    // 【为什么用子串而不是 \b 词边界】凭据变量名长这样：`GITHUB_TOKEN` / `AWS_SECRET_ACCESS_KEY`。
    // `_` 在正则里是词字符，`\bTOKEN\b` 恰好匹配不上 `GITHUB_TOKEN`——那正是要抓的形态。
    if (/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(line)) {
      violations.push(`疑似凭据出现在镜像里：${line.slice(0, 60)}…`);
    }
  }
  // ④ 默认用户必须非 root，且任何一个 `USER root` 都要在后面切回去（否则整段都在 root 下跑）。
  const users = instructions.filter((line) => /^USER\s/i.test(line)).map((line) => line.replace(/^USER\s+/i, "").trim());
  const isRoot = (user: string): boolean => /^0(:0)?$/.test(user) || user === "root";
  if (users.length > 0 && isRoot(users[users.length - 1]!)) {
    violations.push("最后的 USER 是 root：默认用户必须是非 root（uid 1000）");
  }
  let rootWithoutSwitchBack = false;
  for (const user of users) rootWithoutSwitchBack = isRoot(user);
  if (rootWithoutSwitchBack) violations.push("有一个 USER root 之后再没切回非 root");
  return violations;
}

function dedupeStable(items: readonly string[]): string[] {
  return [...new Set(items)];
}
