/**
 * `environment/devcontainer.ts` —— devcontainer.json 的容错解析 + 子集提取（spec Phase 5 §3）。
 *
 * 【为什么只做"子集"而不是接 devcontainer CLI】整套规范包含 feature 的安装编排、生命周期
 * 脚本、端口转发、挂载……那是一个独立产品的体量（设计文档 §C.3 也这么说）。M2 要的是
 * "仓库作者写下的环境事实"里最有用的几项：语言工具链、环境变量、安装命令。
 *
 * 【不支持的字段必须显式记录】这是设计文档 §C.3 的硬要求，也是这个文件最重要的输出之一：
 * `ignored[]` 里每一条都带原因，用户问"为什么我的 devcontainer 没生效"时不用读代码。
 *
 * 【为什么要自己解析 JSONC】真实仓库里的 devcontainer.json 几乎都带注释（VS Code 写出来的
 * 就是 JSONC）。Node 没有内置 JSONC 解析器，而 spec §0.2 的依赖表里没有 JSON5/jsonc-parser——
 * 于是这里有一个 40 行的容错解析器：**只做两件事**（去注释、去尾逗号），其余交给 JSON.parse；
 * 解析失败**不抛**，返回 `error` 让调用方降级到 L2/L3 并记 note（spec 测试要点 4）。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IgnoredField } from "./types.ts";

/** M2 只认这一个位置（命名变体——`.devcontainer/<name>/devcontainer.json`——留给以后）。 */
export const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";

export interface DevcontainerFeature {
  /** 规范化之后的 feature 身份（去掉版本/digest）：`ghcr.io/devcontainers/features/node`。 */
  id: string;
  /** 原始写法（保留给排障信息与 prompt）。 */
  raw: string;
  options: Record<string, string>;
}

export interface DevcontainerBuild {
  /** 相对仓库根的 Dockerfile 路径（用来读它的 FROM，不拿它当构建输入——见附录 A-24）。 */
  dockerfile: string | null;
  context: string | null;
  args: Record<string, string>;
}

export interface DevcontainerSpec {
  /** 相对仓库根（永远等于输入的那个路径；留着是为了 ignored[] 与 note 的 source 一致）。 */
  path: string;
  image: string | null;
  build: DevcontainerBuild | null;
  features: DevcontainerFeature[];
  containerEnv: Record<string, string>;
  postCreateCommand: string | null;
  /** 原始对象。P6 的生成 prompt 要"作者到底写了什么"，而不是我们的投影。 */
  raw: Record<string, unknown>;
}

export interface DevcontainerParseResult {
  spec: DevcontainerSpec | null;
  ignored: IgnoredField[];
  /**
   * 文件在、但读不懂（JSONC 语法错 / 顶层不是对象）。**这不是异常**：调用方据此
   * 降级到下一级推断并记一条 note（spec 测试要点 4）。
   */
  error: string | null;
}

/** M2 支持的字段（其余一律进 ignored[]）。 */
const SUPPORTED_FIELDS = new Set(["image", "build", "features", "containerEnv", "postCreateCommand", "name"]);

/** 认识但明确不支持的字段：给一句**有信息量**的原因，而不是"不支持"。 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  mounts: "为了隔离：宿主路径不挂进沙箱（设计文档 §C.3 明确忽略）",
  forwardPorts: "沙箱不对外暴露端口：CP 通过内网 HTTP 访问它",
  portsAttributes: "同上：端口不转发",
  otherPortsAttributes: "同上：端口不转发",
  runArgs: "容器加固参数只在 provider 侧决定（sandbox.md §F.1），devcontainer 的 runArgs 一律不生效",
  dockerComposeFile: "M2 不起 compose：服务依赖只用来判定 degraded（见 compose 的扫描结果）",
  initializeCommand: "不在构建阶段执行仓库里的命令（构建期执行的代码属于不可信内容，设计文档 §C.7）",
  onCreateCommand: "M2 只支持 postCreateCommand；更早的生命周期没有对应时机",
  updateContentCommand: "同上：M2 只在会话里跑 postCreateCommand",
  postStartCommand: "同上：容器每次启动都跑它不适合我们的租约模型（容器会热着复用）",
  remoteUser: "非 root uid 1000 是运行时契约，不能被 devcontainer 覆盖",
  containerUser: "同上：运行用户由 Layer 1 决定",
  workspaceFolder: "仓库永远灌在 /workspace/repo（M0 §0.1 的路径约定）",
  workspaceMount: "同上：工作区挂载由 provider 决定",
  hostRequirements: "M2 不做宿主资源校验（资源上限由 sandbox limits 表达）",
};

// ---------------------------------------------------------------- JSONC

/**
 * 解析 JSONC（带注释与尾逗号的 JSON）。
 *
 * 【为什么手写】见文件头。实现只做两件事，而且**扫描时跳过字符串字面量**——
 * 一个注释开关写在字符串里（`"// not a comment"`）或者尾逗号长在字符串里
 * （`"a,}"`）都是真实存在的情况，用正则去处理它们必然出错。
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    // 字符串字面量整段复制（含转义序列），注释与尾逗号都不会在这里面生效。
    if (char === '"') {
      const end = findStringEnd(text, i);
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline; // 保留换行：报语法错时行号才有意义
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("块注释没有收尾（少了 */）");
      // 块注释里的换行要保留，否则 JSON.parse 的行号会飘。
      out += "\n".repeat((text.slice(i, end).match(/\n/g) ?? []).length);
      i = end + 2;
      continue;
    }
    if (char === ",") {
      // 尾逗号：往后看第一个非空白字符，是 } 或 ] 就把这个逗号扔掉。
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return JSON.parse(out);
}

/** 从 `start`（一个 `"`）找到配对的收尾引号下标。字符串没结束时抛。 */
function findStringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === '"') return i;
    if (char === "\n") break; // JSON 的字符串不能跨行：这是一处语法错
    i += 1;
  }
  throw new Error("字符串没有收尾（少了一个引号）");
}

// ---------------------------------------------------------------- feature 映射表

/**
 * 一个 feature 在生成的 Dockerfile 里变成什么。
 *
 * 四类：语言工具链（影响基础镜像选择）、要执行的安装（一段固定 RUN 模板）、
 * Layer 1 已有的（什么都不做）、不支持的（进 degradedRisks）。
 */
export type FeatureAction =
  | { kind: "language"; language: "node" | "python" | "go" | "rust"; note: string }
  | { kind: "install"; run: string; note: string }
  | { kind: "builtin"; note: string }
  | { kind: "unsupported"; reason: string; degraded: string | null };

const GITHUB_CLI_RUN = [
  "RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\",
  "      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \\",
  " && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \\",
  ' && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\',
  "      > /etc/apt/sources.list.d/github-cli.list \\",
  " && apt-get update && apt-get install -y --no-install-recommends gh \\",
  " && rm -rf /var/lib/apt/lists/*",
].join("\n");

/** 官方 registry 的 common 类 feature → 动作。**写死在代码里**（spec §3 的原话）。 */
const FEATURE_ACTIONS: Record<string, FeatureAction> = {
  "ghcr.io/devcontainers/features/common-utils": {
    kind: "builtin",
    note: "Layer 1 已含 git/curl/tar/gzip/procps 与非 root uid 1000",
  },
  "ghcr.io/devcontainers/features/git": { kind: "builtin", note: "Layer 1 已装 git" },
  "ghcr.io/devcontainers/features/node": { kind: "language", language: "node", note: "改用 base-node-dev" },
  "ghcr.io/devcontainers/features/python": { kind: "language", language: "python", note: "改用 base-python-dev" },
  "ghcr.io/devcontainers/features/go": { kind: "language", language: "go", note: "改用 base-go-dev" },
  "ghcr.io/devcontainers/features/rust": { kind: "language", language: "rust", note: "改用 base-rust-dev" },
  "ghcr.io/devcontainers/features/github-cli": {
    kind: "install",
    run: GITHUB_CLI_RUN,
    note: "按官方 apt 仓库装 gh（不用 curl|sh）",
  },
  "ghcr.io/devcontainers/features/git-lfs": {
    kind: "install",
    run: "RUN apt-get update && apt-get install -y --no-install-recommends git-lfs && rm -rf /var/lib/apt/lists/*",
    note: "装 git-lfs",
  },
  "ghcr.io/devcontainers/features/java": {
    kind: "unsupported",
    reason: "Layer 1 矩阵里没有 java 基础镜像",
    degraded: "需要 Java（devcontainer feature）：M2 不装，相关构建/测试跑不了",
  },
  "ghcr.io/devcontainers/features/docker-in-docker": {
    kind: "unsupported",
    reason: "需要一个特权容器，与沙箱的加固参数（--cap-drop ALL / 非 root）互斥",
    degraded: "需要 docker（devcontainer feature docker-in-docker）：沙箱内没有 docker，依赖它的测试跑不了",
  },
  "ghcr.io/devcontainers/features/docker-outside-of-docker": {
    kind: "unsupported",
    reason: "需要把宿主的 docker socket 暴露给沙箱——那等于给沙箱宿主权限",
    degraded: "需要 docker：沙箱内没有 docker，依赖它的测试跑不了",
  },
  "ghcr.io/devcontainers/features/sshd": {
    kind: "unsupported",
    reason: "沙箱只经 CP 的内网 HTTP 服务，不需要 sshd",
    degraded: null,
  },
  "ghcr.io/devcontainers/features/desktop-lite": {
    kind: "unsupported",
    reason: "桌面环境对编码 agent 没有用途",
    degraded: null,
  },
};

/**
 * feature → 动作。规范化身份（去掉版本与 digest）之后查表；查不到就是"未支持"。
 *
 * 【为什么不支持"本地 feature"（`./features/x`）与第三方 registry】它们的安装逻辑是
 * 任意代码（devcontainer CLI 会在构建阶段执行），而 M2 的构建阶段已经接受了"执行仓库
 * 内容"的风险（§C.7）——再让它执行一个我们理解不了的安装脚本，代价与收益不成比例。
 */
export function featureAction(rawId: string): FeatureAction {
  if (rawId.startsWith("./") || rawId.startsWith("../") || rawId.startsWith("/")) {
    return {
      kind: "unsupported",
      reason: "本地 feature 目录（要执行仓库里的安装脚本）不在 M2 的子集里",
      degraded: `devcontainer 用了本地 feature ${rawId}：其中的工具链没有装上`,
    };
  }
  const key = featureKey(rawId);
  const known = FEATURE_ACTIONS[key];
  if (known !== undefined) return known;
  return {
    kind: "unsupported",
    reason: `不在 M2 的 feature 映射表里（只支持官方 registry 的 common 类）`,
    degraded: `devcontainer feature ${key} 没有支持：其中的工具链没有装上`,
  };
}

/** `ghcr.io/devcontainers/features/node:1.6.1@sha256:…` → `ghcr.io/devcontainers/features/node`。 */
export function featureKey(rawId: string): string {
  const withoutDigest = rawId.split("@")[0]!;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

// ---------------------------------------------------------------- 解析

/**
 * 读并解析 `.devcontainer/devcontainer.json`。
 *
 * 三种结局：不在（`spec: null, error: null`）、在但读不懂（`error` 有值）、解析成功。
 * 调用方（`infer.ts`）对前两种的处理不同：不在 = 正常的 L2/L3；读不懂 = 降级 + note。
 */
export async function parseDevcontainer(
  cloneDir: string,
  relativePath: string = DEVCONTAINER_PATH,
): Promise<DevcontainerParseResult> {
  let text: string;
  try {
    text = await readFile(path.join(cloneDir, relativePath), "utf8");
  } catch {
    return { spec: null, ignored: [], error: null };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { spec: null, ignored: [], error: `${relativePath} 不是合法 JSONC：${message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { spec: null, ignored: [], error: `${relativePath} 的顶层必须是对象` };
  }
  return extractDevcontainerSpec(parsed as Record<string, unknown>, relativePath);
}

/**
 * 从解析好的对象里提取 M2 子集（导出是为了单测能直接喂一个对象，不必写文件）。
 * 返回值里的 `ignored` 是**这个文件产生**的忽略项，调用方要把它们并进信号的 ignored。
 */
export function extractDevcontainerSpec(
  raw: Record<string, unknown>,
  relativePath: string = DEVCONTAINER_PATH,
): DevcontainerParseResult {
  const ignored: IgnoredField[] = [];
  const ignore = (field: string, reason: string): void => {
    ignored.push({ source: relativePath, field, reason });
  };

  for (const key of Object.keys(raw)) {
    if (SUPPORTED_FIELDS.has(key)) continue;
    const known = KNOWN_UNSUPPORTED[key];
    if (known !== undefined) ignore(key, known);
    else ignore(key, "不在 M2 的 devcontainer 子集里（设计文档 §C.3 的子集清单之外）");
  }

  const image = typeof raw["image"] === "string" ? raw["image"] : null;
  if (typeof raw["image"] === "string") {
    // `image` 是被"看到并使用"的（作为语言提示），但它不会是 FROM——这一点要写清楚，
    // 否则用户会以为环境就是那个镜像。
    ignore(
      "image",
      `声明的是 ${raw["image"]}；M2 不从任意镜像起步（那会丢掉 sandbox-agent 与非 root 契约），` +
        "只把它当语言提示，FROM 落在 Layer 1 矩阵里（附录 A-24）",
    );
  }

  return {
    spec: {
      path: relativePath,
      image,
      build: extractBuild(raw["build"], ignore),
      features: extractFeatures(raw["features"], ignore),
      containerEnv: extractContainerEnv(raw["containerEnv"], ignore),
      postCreateCommand: normalizeCommand(raw["postCreateCommand"]),
      raw,
    },
    ignored,
    error: null,
  };
}

function extractBuild(value: unknown, ignore: (field: string, reason: string) => void): DevcontainerBuild | null {
  if (typeof value === "string") return { dockerfile: value, context: null, args: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const args: Record<string, string> = {};
  if (typeof record["args"] === "object" && record["args"] !== null && !Array.isArray(record["args"])) {
    for (const [key, item] of Object.entries(record["args"] as Record<string, unknown>)) {
      if (typeof item === "string") args[key] = item;
      else if (typeof item === "number" || typeof item === "boolean") args[key] = String(item);
    }
  }
  if (Object.keys(args).length > 0) {
    // 构建参数只在"真的用它构建"时有意义，而 M2 不拿仓库 Dockerfile 当构建输入。
    ignore("build.args", "M2 不拿仓库的 Dockerfile 当构建输入：build.args 没有落点");
  }
  return {
    dockerfile: typeof record["dockerfile"] === "string" ? record["dockerfile"] : null,
    context: typeof record["context"] === "string" ? record["context"] : null,
    args,
  };
}

function extractFeatures(value: unknown, ignore: (field: string, reason: string) => void): DevcontainerFeature[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const features: DevcontainerFeature[] = [];
  for (const [rawId, options] of Object.entries(value as Record<string, unknown>)) {
    const feature: DevcontainerFeature = {
      id: featureKey(rawId),
      raw: rawId,
      options: {},
    };
    if (typeof options === "object" && options !== null && !Array.isArray(options)) {
      for (const [key, item] of Object.entries(options as Record<string, unknown>)) {
        if (typeof item === "string") feature.options[key] = item;
        else if (typeof item === "number" || typeof item === "boolean") feature.options[key] = String(item);
      }
    } else if (typeof options === "string") {
      feature.options["version"] = options;
    }
    // 版本选项是唯一会被用到的 option（挑基础镜像时参考）；其余记下来但用不到。
    const extra = Object.keys(feature.options).filter((key) => key !== "version");
    if (extra.length > 0) {
      ignore(`${rawId}#options`, `feature 的选项（${extra.join(", ")}）不在 M2 子集里：只参考 version`);
    }
    features.push(feature);
  }
  return features;
}

function extractContainerEnv(value: unknown, ignore: (field: string, reason: string) => void): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      env[key] = String(item);
      continue;
    }
    ignore(`containerEnv.${key}`, `${typeof item} 不是字符串/数字/布尔（devcontainer 允许 localEnv 这类插值，M2 不解析）`);
  }
  return env;
}

/**
 * `postCreateCommand` 可以是字符串、数组（依次跑）或对象（按序跑）。
 * 统一成一条 `a && b` 的命令——它与 shell 的语义一致，也是唯一能被原样交给沙箱的形式。
 */
function normalizeCommand(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return parts.length === 0 ? null : parts.join(" && ");
  }
  if (typeof value === "object" && value !== null) {
    const parts: string[] = [];
    for (const item of Object.values(value as Record<string, unknown>)) {
      const command = normalizeCommand(item);
      if (command !== null) parts.push(command);
    }
    return parts.length === 0 ? null : parts.join(" && ");
  }
  return null;
}
