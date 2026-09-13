/**
 * `environment/signals.ts` —— 从 clone 目录采集仓库信号（spec Phase 5 §2）。
 *
 * 【三条硬性质，破一条都会在后面以怪现象暴露】
 *  ① **只读，不执行**：Makefile / package.json / CI 配置是**文本**，不是要跑的程序。
 *     沙箱内外都不该因为"推断环境"而执行仓库里的东西（spec 测试要点 8）。
 *  ② **不抛**：读不到、读不懂、解析失败都只影响那一项信号，别的照采。一个坏文件让整次
 *     推断失败，等于把"环境能不能建"押在仓库里最脏的那个文件上。
 *  ③ **确定**：同一个仓库两次采集 → 序列化字节相同（设计文档 §C.5 的缓存键靠这条）。
 *     所以这里所有数组都排序、所有对象都用固定键序，绝不把 readdir 的顺序漏出去。
 *
 * 【为什么不用 YAML 库】要读 YAML 的只有两处（compose 的服务名、workflow 的 run 行），
 * 而且都是启发式：错了顶多少一条信号，而 `ignored[]` 里会写明"只做了行级扫描"。
 * spec §0.2 的依赖表里没有 YAML，为一个启发式引一个依赖不划算；真要读结构化 YAML
 * （比如 compose 的 depends_on 关系）时再引，那时驱动它的会是真需求。
 *
 * 【事实与结论分开】`lockfiles` / `makeTargets` 是事实（仓库里有什么），
 * `packageManagers` / `services` 是结论（按优先级挑出来的、canonical 化的）。
 * 排查"为什么没走 pnpm"看事实，构建缓存键用结论。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DEVCONTAINER_PATH } from "./devcontainer.ts";
import type { IgnoredField, RepoSignals } from "./types.ts";

/** 采集时的上限。默认值够覆盖中位仓库，又不至于让"一个 5 万文件的大仓"拖死推断。 */
export interface CollectOptions {
  /** 扫描的文件数上限。超过之后按排序截断，并在 `ignored[]` 里留一条（确定性）。 */
  maxFiles?: number;
}

export const DEFAULT_MAX_FILES = 5_000;

/**
 * 不进的目录。分三类：依赖与构建产物（不是仓库自己的代码）、语言缓存、
 * 编辑器的本地状态。**`vendor` 也在这里**：Go 的 vendor 目录可能有几万个文件，
 * 而它 100% 是别人代码。
 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".gradle",
  ".terraform",
]);

// ---------------------------------------------------------------- 扫描

interface RepoScan {
  root: string;
  /** 相对路径，**已排序**（字典序 = 与文件系统无关的确定顺序）。 */
  files: string[];
  /** 相对目录，已排序。monorepo 判定要按目录数包。 */
  dirs: string[];
  truncated: boolean;
}

/**
 * 扫一遍 clone 目录，拿到文件与目录清单。
 *
 * 【为什么自己写而不是引 glob】要的语义只有"跳过几个目录 + 排序 + 有上限"，
 * 而 walk 的核心风险（符号链接成环、权限错误）在这里都有明确答案：
 * 不跟随符号链接（`withFileTypes` 里的 `isSymbolicLink()` 直接跳过）、
 * 读不动的目录当不存在（catch 掉，反正这是启发式采集）。
 */
export async function scanRepo(root: string, options: CollectOptions = {}): Promise<RepoScan> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files: string[] = [];
  const dirs: string[] = [];
  /** 显式栈（不是递归），深度上限由真实目录结构决定，不会爆栈。 */
  const queue: string[] = [""];
  let truncated = false;

  while (queue.length > 0) {
    const relativeDir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue; // 读不动（权限 / 不是目录）当它不存在
    }
    // 排序之后再遍历：截断发生时"截到哪里"才与文件系统顺序无关。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue; // 不跟符号链接：成环与"链到仓库外"都不值得处理
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        dirs.push(relative);
        queue.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }
      files.push(relative);
    }
  }

  files.sort();
  dirs.sort();
  return { root, files, dirs, truncated };
}

/** 读一个文本文件；不存在 / 读不动 / 太大都返回 null（采集不会因此中断）。 */
async function readTextIfExists(scan: RepoScan, relative: string, maxBytes = 256 * 1024): Promise<string | null> {
  const absolute = path.join(scan.root, relative);
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(absolute, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 语言

/** 扩展名 → 语言。只收"能当主语言"的那些；json/yaml/md/css 之类的配置格式不算语言。 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".sh": "shell",
  ".sql": "sql",
  ".ex": "elixir",
  ".exs": "elixir",
  ".scala": "scala",
};

/**
 * 清单文件 → 语言，**权重按"这行写下就意味着一个工程入口"给**（spec §C.3 的
 * "是不是入口"）。权重故意小（2），因为一个 20 个文件的 Python 仓库不该被
 * 一个顺手的 `package.json`（前端工具链产物）压过去。
 */
const ENTRY_MANIFESTS: Array<{ file: string; language: string }> = [
  { file: "package.json", language: "javascript" },
  { file: "pyproject.toml", language: "python" },
  { file: "requirements.txt", language: "python" },
  { file: "setup.py", language: "python" },
  { file: "go.mod", language: "go" },
  { file: "Cargo.toml", language: "rust" },
  { file: "Gemfile", language: "ruby" },
  { file: "composer.json", language: "php" },
  { file: "pom.xml", language: "java" },
  { file: "build.gradle", language: "java" },
];

const ENTRY_WEIGHT = 2;

/**
 * 按"文件数 + 入口"排序的语言清单（最可能的语言在前）。
 *
 * 排序键是 `(权重降序, 名字升序)`——名字升序是为了确定：权重相同时不能靠出现顺序。
 */
export function readLanguages(scan: Pick<RepoScan, "files">): string[] {
  const weights = new Map<string, number>();
  for (const file of scan.files) {
    const extension = path.extname(file).toLowerCase();
    const language = EXTENSION_LANGUAGES[extension];
    if (language === undefined) continue;
    weights.set(language, (weights.get(language) ?? 0) + 1);
  }
  for (const manifest of ENTRY_MANIFESTS) {
    const present = scan.files.some((file) => file === manifest.file || file.endsWith(`/${manifest.file}`));
    if (!present) continue;
    weights.set(manifest.language, (weights.get(manifest.language) ?? 0) + ENTRY_WEIGHT);
  }
  return [...weights.entries()]
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .map(([language]) => language);
}

// ---------------------------------------------------------------- 包管理器

/** 锁文件 → 包管理器。**这个数组的顺序就是生态内的优先级**（见 pickPackageManagers）。 */
const LOCKFILES: Array<{ file: string; manager: string; ecosystem: string }> = [
  // JS：pnpm-lock 优先于 npm 优先于 yarn。理由是"两个同时存在"的常见成因：
  // 仓库从 npm/yarn 迁到 pnpm 时旧锁文件常被留在树里，而 pnpm-lock 才是 CI 真正用的那份。
  // （spec 测试要点 2 只要求 npm 压过 yarn，与这个顺序一致。）
  { file: "pnpm-lock.yaml", manager: "pnpm", ecosystem: "js" },
  { file: "package-lock.json", manager: "npm", ecosystem: "js" },
  { file: "yarn.lock", manager: "yarn", ecosystem: "js" },
  // Python：uv / poetry 的锁文件都比 requirements.txt 权威（后者没有完整的传递依赖）。
  { file: "uv.lock", manager: "uv", ecosystem: "python" },
  { file: "poetry.lock", manager: "poetry", ecosystem: "python" },
  { file: "Pipfile.lock", manager: "pipenv", ecosystem: "python" },
  { file: "requirements.txt", manager: "pip", ecosystem: "python" },
  { file: "Cargo.lock", manager: "cargo", ecosystem: "rust" },
  { file: "go.sum", manager: "go", ecosystem: "go" },
];

/**
 * 生态的**固定顺序**：JS → Python → Rust → Go（与 spec §C.3 的枚举顺序一致）。
 *
 * 【为什么固定而不是按语言权重】`packageManagers[0]` 会被下游当成"主包管理器"去拼命令，
 * 而它在缓存键里。让它随语言统计漂移，等于同一个仓库改一个文件就换一份环境——
 * 固定顺序的代价是"polyglot 仓库里 JS 总排第一"，这个代价是确定的。
 */
const ECOSYSTEM_ORDER = ["js", "python", "rust", "go"];

const LOCK_FILE_PATTERN = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|requirements\.txt|Cargo\.lock|go\.sum)$/;

interface PackageManagerResult {
  packageManagers: string[];
  lockfiles: string[];
  ignored: IgnoredField[];
}

/**
 * 挑出包管理器。生态内按 `LOCKFILES` 的优先级取第一个，其余进 `ignored[]` 并说明原因
 * （spec 测试要点 2：同时有 `package-lock.json` 与 `yarn.lock` → 取 npm 并记一条）。
 *
 * 【没有锁文件时也要有结论】很多库仓库不提交锁文件（`Cargo.toml` / `pyproject.toml` /
 * `go.mod` 在，锁不在）。这时按清单文件给一个保守的结论（cargo / pip / go），
 * 并在 `ignored[]` 里写明"没有锁文件，按清单文件推断"——健康检查那一步会知道的更清楚。
 */
export async function readPackageManagers(scan: RepoScan): Promise<PackageManagerResult> {
  const ignored: IgnoredField[] = [];
  const present = LOCKFILES.filter((entry) => scan.files.includes(entry.file));
  const lockfiles = present.map((entry) => entry.file).sort();

  // 子目录里的锁文件（monorepo 的每个子包一个）必须被**看见但不用**：
  // M2 一个仓库一个环境，读它们只会得到一堆互相冲突的结论（而冲突本身就是信息）。
  for (const file of scan.files) {
    if (!file.includes("/") || !LOCK_FILE_PATTERN.test(file)) continue;
    ignored.push({
      source: file,
      field: "lockfile",
      reason: "只读仓库根的锁文件（M2 一个仓库一个环境，不做多项目拆分）",
    });
  }

  const chosen: string[] = [];
  for (const ecosystem of ECOSYSTEM_ORDER) {
    const candidates = present.filter((entry) => entry.ecosystem === ecosystem);
    if (candidates.length > 0) {
      const winner = candidates[0]!;
      chosen.push(winner.manager);
      for (const loser of candidates.slice(1)) {
        ignored.push({
          source: loser.file,
          field: "packageManager",
          reason: `同时存在 ${winner.file}：按优先级取 ${winner.manager}`,
        });
      }
      continue;
    }
    // 没有锁文件：看清单文件。
    const fallback = await fallbackManager(scan, ecosystem);
    if (fallback !== null) {
      chosen.push(fallback.manager);
      ignored.push({
        source: fallback.source,
        field: "lockfile",
        reason: "没有锁文件，按清单文件推断包管理器（依赖版本不确定，P7 的健康检查会暴露）",
      });
    }
  }

  return { packageManagers: chosen, lockfiles, ignored };
}

async function fallbackManager(scan: RepoScan, ecosystem: string): Promise<{ manager: string; source: string } | null> {
  if (ecosystem === "rust") {
    return scan.files.includes("Cargo.toml") ? { manager: "cargo", source: "Cargo.toml" } : null;
  }
  if (ecosystem === "go") {
    return scan.files.includes("go.mod") ? { manager: "go", source: "go.mod" } : null;
  }
  if (ecosystem === "js") {
    return scan.files.includes("package.json") ? { manager: "npm", source: "package.json" } : null;
  }
  // Python：pyproject 里带 [tool.poetry] → poetry；否则按 pip 处理（PEP 517 也能装）。
  const pyproject = await readTextIfExists(scan, "pyproject.toml");
  if (pyproject !== null && /\[tool\.poetry\]/.test(pyproject)) return { manager: "poetry", source: "pyproject.toml" };
  if (pyproject !== null) return { manager: "pip", source: "pyproject.toml" };
  return scan.files.includes("setup.py") ? { manager: "pip", source: "setup.py" } : null;
}

// ---------------------------------------------------------------- 运行时版本

/** 一条版本候选：先按 language 分组，组内按 `priority` 取第一个。 */
interface VersionCandidate {
  language: string;
  priority: number;
  source: string;
  raw: string;
}

const VERSION_LANGUAGES = ["node", "python", "go", "rust"] as const;

/**
 * 采集运行时版本。
 *
 * 【优先级怎么定】专用版本文件（`.nvmrc` / `.python-version` / `rust-toolchain.toml`）
 * 比 `engines` / `requires-python` 这种"范围声明"更具体，比 CI 里的版本（行级扫描的
 * 启发式）更权威。所以顺序是：版本文件 → 声明 → CI hint。
 *
 * 【为什么要记冲突】"仓库里写着 3.11，为什么环境是 3.12"必须有答案。被跳过的来源进
 * `ignored[]`，reason 里点名胜出者。
 */
export async function readRuntimeVersions(scan: RepoScan): Promise<{
  runtimeVersions: Record<string, string>;
  ignored: IgnoredField[];
}> {
  const ignored: IgnoredField[] = [];
  const candidates: VersionCandidate[] = [];
  const add = (language: string, priority: number, source: string, raw: string | null | undefined): void => {
    if (raw === null || raw === undefined) return;
    candidates.push({ language, priority, source, raw });
  };

  // ---- 专用版本文件
  add("node", 10, ".nvmrc", await readTextIfExists(scan, ".nvmrc"));
  add("python", 10, ".python-version", await readTextIfExists(scan, ".python-version"));
  add("node", 11, ".tool-versions", toolVersionsEntry(await readTextIfExists(scan, ".tool-versions"), "nodejs"));
  add("python", 11, ".tool-versions", toolVersionsEntry(await readTextIfExists(scan, ".tool-versions"), "python"));
  add("node", 12, "mise.toml", misEntry(await readTextIfExists(scan, "mise.toml"), "node"));
  add("python", 12, "mise.toml", misEntry(await readTextIfExists(scan, "mise.toml"), "python"));
  add("node", 12, ".mise.toml", misEntry(await readTextIfExists(scan, ".mise.toml"), "node"));
  add("python", 12, ".mise.toml", misEntry(await readTextIfExists(scan, ".mise.toml"), "python"));
  add("rust", 10, "rust-toolchain.toml", tomlStringValue(await readTextIfExists(scan, "rust-toolchain.toml"), "channel"));
  add("rust", 11, "rust-toolchain", await readTextIfExists(scan, "rust-toolchain"));

  // ---- 清单文件里的声明
  const packageJson = parseJson(await readTextIfExists(scan, "package.json"));
  if (packageJson !== null) {
    const engines = (packageJson as { engines?: { node?: unknown } }).engines;
    if (typeof engines?.node === "string") add("node", 20, "package.json#engines.node", engines.node);
  }
  add(
    "python",
    20,
    "pyproject.toml#requires-python",
    tomlStringValue(await readTextIfExists(scan, "pyproject.toml"), "requires-python"),
  );
  // poetry 的写法是 `[tool.poetry.dependencies]` 下的 `python = "^3.11"`（PEP 621 的
  // requires-python 在 poetry 仓库里常常没有）。两个都读，优先级略低。
  add("python", 22, "pyproject.toml#tool.poetry.dependencies.python", poetryPython(await readTextIfExists(scan, "pyproject.toml")));
  add("python", 21, "runtime.txt", await readTextIfExists(scan, "runtime.txt"));
  const goMod = await readTextIfExists(scan, "go.mod");
  if (goMod !== null) {
    const match = /^go\s+(\S+)/m.exec(goMod);
    if (match !== null) add("go", 20, "go.mod", match[1]!);
  }

  // ---- CI hint（最后才用）
  const ci = await readCiHints(scan);
  add("node", 30, ".github/workflows", ci.versions["node"]);
  add("python", 30, ".github/workflows", ci.versions["python"]);

  const runtimeVersions: Record<string, string> = {};
  for (const language of VERSION_LANGUAGES) {
    const group = candidates
      .filter((item) => item.language === language)
      .sort((a, b) => a.priority - b.priority);
    let picked: { source: string; version: string } | null = null;
    for (const candidate of group) {
      const version = normalizeVersion(candidate.raw);
      if (version === null) {
        ignored.push({
          source: candidate.source,
          field: language,
          reason: `"${candidate.raw.trim().slice(0, 40)}" 不是具体版本（滚动标签对推断没有用）`,
        });
        continue;
      }
      if (picked === null) picked = { source: candidate.source, version };
      else {
        ignored.push({
          source: candidate.source,
          field: language,
          reason: `已由 ${picked.source} 提供版本（${picked.version}）`,
        });
      }
    }
    if (picked !== null) runtimeVersions[language] = picked.version;
  }

  return { runtimeVersions, ignored };
}

/** `.tool-versions` 是 `<plugin> <version>` 一行一条。 */
function toolVersionsEntry(text: string | null, plugin: string): string | null {
  if (text === null) return null;
  for (const line of text.split("\n")) {
    const match = new RegExp(`^\\s*${plugin}\\s+(\\S+)`).exec(line);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** `mise.toml` 里是 `node = "20"` 这种键值。 */
function misEntry(text: string | null, key: string): string | null {
  return tomlStringValue(text, key);
}

/** 行级扫描 TOML 的 `key = "value"`（不引 TOML 库，理由见文件头）。 */
function tomlStringValue(text: string | null, key: string): string | null {
  if (text === null) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*["']([^"']+)["']`, "m").exec(text);
  return match?.[1] ?? null;
}

/** poetry 的 `[tool.poetry.dependencies]` 里的 `python = "^3.11"`。 */
function poetryPython(text: string | null): string | null {
  if (text === null || !/\[tool\.poetry\]/.test(text)) return null;
  const match = /^\s*python\s*=\s*["']([^"']+)["']/m.exec(text);
  return match?.[1] ?? null;
}

/** 解析 JSON，坏了就当没有（`package.json` 有注释的仓库是真存在的）。 */
function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 从 `"^20.11.0"` / `">=3.9,<4"` / `"v18"` / `"lts/*"` 里取出一个具体版本号。
 * 取不到（滚动标签、范围里一个数字都没有）返回 null——**宁可没有版本，也不要一个假版本**。
 */
export function normalizeVersion(raw: string): string | null {
  const trimmed = raw.trim().replace(/^v/i, "");
  if (trimmed === "") return null;
  const match = /\d+(?:\.\d+)*/.exec(trimmed);
  if (match === null) return null;
  const version = match[0];
  // "3.11.x" 这种写成 .x 的：截到 x 之前。
  return version.endsWith(".") ? version.slice(0, -1) : version;
}

// ---------------------------------------------------------------- 构建入口与 CI

/**
 * 构建入口：Makefile / justfile 的目标 + `package.json` 的 scripts 键。
 *
 * 【为什么 scripts 单独一个字段】spec 的 `RepoSignals` 只有 `makeTargets`，但设计文档
 * §C.3 的"构建入口"一行列了三个来源。把 npm scripts 塞进 `makeTargets` 会让下游分不清
 * `build` 到底是 `make build` 还是 `npm run build`（见附录 A-26）。
 */
export async function readBuildEntrypoints(scan: RepoScan): Promise<{ makeTargets: string[]; scripts: string[] }> {
  const makeTargets = new Set<string>();
  const makefile = await readTextIfExists(scan, "Makefile");
  if (makefile !== null) {
    for (const target of makeTargetNames(makefile)) makeTargets.add(target);
  }
  const justfile = (await readTextIfExists(scan, "justfile")) ?? (await readTextIfExists(scan, "Justfile"));
  if (justfile !== null) {
    for (const target of makeTargetNames(justfile)) makeTargets.add(target);
  }

  const scripts: string[] = [];
  const packageJson = parseJson(await readTextIfExists(scan, "package.json"));
  const scriptMap = (packageJson as { scripts?: Record<string, unknown> } | null)?.scripts;
  if (typeof scriptMap === "object" && scriptMap !== null) {
    for (const key of Object.keys(scriptMap)) {
      if (typeof scriptMap[key] === "string") scripts.push(key);
    }
  }

  return { makeTargets: [...makeTargets].sort(), scripts: scripts.sort() };
}

/**
 * 从 Makefile / justfile 里取目标名。
 *
 * 【要排除什么】变量赋值（`CC := gcc`）、`.PHONY` 这类特殊目标、以及缩进的行
 * （那是配方体，不是目标）。够用就好：这是启发式，错的代价是多一条构建命令，
 * 而构建命令最终还要过 P7 的健康检查。
 */
function makeTargetNames(text: string): string[] {
  const targets: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("\t") || line.startsWith(" ")) continue;
    const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (match === null) continue;
    const name = match[1]!;
    if (name.startsWith(".") || name === "Makefile" || name === "justfile") continue;
    targets.push(name);
  }
  return targets;
}

interface CiHints {
  commands: string[];
  versions: Record<string, string>;
}

/**
 * 从 `.github/workflows/*.yml` 里读 `run:` 行与版本号（**行级扫描**，见文件头）。
 *
 * 【为什么不解析 YAML】见文件头。这里能拿到的东西的价值是"CI 怎么跑，本地就该怎么跑"
 * （设计文档 §C.3 的原话），行级足以回答；`run: |` 这种块状写法会进 `ignored[]`，
 * 而不是被静默跳过。
 */
export async function readCiHints(scan: RepoScan): Promise<CiHints> {
  const commands: string[] = [];
  const versions: Record<string, string> = {};
  const workflows = scan.files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  for (const workflow of workflows) {
    const text = await readTextIfExists(scan, workflow);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const run = /^\s*-?\s*run:\s*(.*)$/.exec(line);
      if (run !== null) {
        const value = run[1]!.trim();
        if (value === "" || value.startsWith("|") || value.startsWith(">")) continue; // 块状，采不到
        commands.push(value.replace(/^["']|["']$/g, ""));
      }
      const node = /^\s*node-version:\s*["']?([^"'\s]+)/.exec(line);
      if (node !== null && versions["node"] === undefined) versions["node"] = node[1]!;
      const venv = /^\s*python-version:\s*["']?([^"'\s]+)/.exec(line);
      if (venv !== null && versions["python"] === undefined) versions["python"] = venv[1]!;
    }
  }
  return {
    commands: [...new Set(commands)].sort().slice(0, 50),
    versions,
  };
}

// ---------------------------------------------------------------- 服务依赖

/** compose 文件（按这个顺序找，只读存在的那些）。 */
const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  ".devcontainer/compose.yaml",
  ".devcontainer/docker-compose.yaml",
  ".devcontainer/docker-compose.yml",
];

/** 已知镜像 → canonical 服务名。这张表决定了 `services[]` 里写的是 `postgres` 还是 `db`。 */
const KNOWN_SERVICES: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /^postgres/, service: "postgres" },
  { pattern: /^mysql/, service: "mysql" },
  { pattern: /^mariadb/, service: "mariadb" },
  { pattern: /^mongo/, service: "mongodb" },
  { pattern: /^redis/, service: "redis" },
  { pattern: /^valkey/, service: "valkey" },
  { pattern: /^minio/, service: "minio" },
  { pattern: /^rabbitmq/, service: "rabbitmq" },
  { pattern: /^elasticsearch/, service: "elasticsearch" },
  { pattern: /^opensearch/, service: "opensearch" },
  { pattern: /^kafka|^confluentinc/, service: "kafka" },
  { pattern: /^memcached/, service: "memcached" },
  { pattern: /^clickhouse/, service: "clickhouse" },
  { pattern: /^nats/, service: "nats" },
  { pattern: /^mailhog|^mailpit|^axllent\/mailpit/, service: "mail" },
  { pattern: /^localstack/, service: "localstack" },
];

/**
 * 从 compose 文件里读服务依赖。
 *
 * 【为什么这件事值得做】设计文档 §C.3 把"服务依赖"列成 degraded 的判据：compose 里有
 * postgres 而沙箱里起不了它，就意味着"这个仓库的集成测试不能跑"——**这件事必须在
 * agent 动手之前就知道**，否则它会在集成测试上反复失败三次然后耗尽预算（§C.6 的原话）。
 */
export async function readServices(scan: RepoScan): Promise<{ services: string[]; ignored: IgnoredField[] }> {
  const ignored: IgnoredField[] = [];
  const services = new Set<string>();
  for (const file of COMPOSE_FILES) {
    if (!scan.files.includes(file)) continue;
    const text = await readTextIfExists(scan, file);
    if (text === null) continue;
    for (const service of parseComposeServices(text)) services.add(service);
    ignored.push({
      source: file,
      field: "其他字段",
      reason: "compose 只用来识别服务依赖：M2 不起 compose（起不了的服务进 degradedRisks）",
    });
  }
  return { services: [...services].sort(), ignored };
}

/** 行级扫描 compose 的 `services:` 块：两空格缩进的键是服务名，更深的 `image:` 是镜像。 */
function parseComposeServices(text: string): string[] {
  const found: string[] = [];
  let inServices = false;
  let current: { name: string; image: string | null } | null = null;
  const flush = (): void => {
    if (current === null) return;
    found.push(canonicalService(current.name, current.image));
    current = null;
  };
  for (const line of text.split("\n")) {
    if (/^services\s*:/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^[A-Za-z0-9_.$"-]+\s*:/.test(line)) {
      // 顶层的另一个键（volumes / networks / x-…）——services 块结束。
      flush();
      inServices = false;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (service !== null) {
      flush();
      current = { name: service[1]!, image: null };
      const inline = /image\s*:\s*(\S+)/.exec(service[2] ?? "");
      if (inline !== null) current.image = inline[1]!;
      continue;
    }
    const image = /^\s{3,}image\s*:\s*["']?([^"'\s]+)/.exec(line);
    if (image !== null && current !== null) current.image = image[1]!;
  }
  flush();
  return found;
}

/** 镜像名 → canonical 服务名（认不出来就用服务名本身：作者起的名字是有意义的）。 */
function canonicalService(serviceName: string, image: string | null): string {
  if (image === null) return serviceName;
  const withoutTag = image.split("@")[0]!.split(":")[0]!;
  const basename = withoutTag.split("/").pop() ?? withoutTag;
  for (const known of KNOWN_SERVICES) {
    if (known.pattern.test(basename)) return known.service;
  }
  return basename;
}

// ---------------------------------------------------------------- monorepo

/**
 * 是不是 monorepo。
 *
 * 【为什么这件事影响环境】monorepo 的依赖安装与构建命令是"在根上一把梭"（workspaces、
 * `cargo build --workspace`），而不是"逐个包进目录里装"。判断错了会让健康检查
 * 在错误的目录里跑命令，得到的失败原因与真实原因完全无关。
 */
export async function detectMonorepo(scan: RepoScan): Promise<boolean> {
  if (scan.files.includes("pnpm-workspace.yaml")) return true;
  if (scan.files.includes("go.work")) return true;
  if (scan.files.some((file) => ["lerna.json", "nx.json", "turbo.json", "rush.json"].includes(file))) return true;

  const packageJson = parseJson(await readTextIfExists(scan, "package.json"));
  const workspaces = (packageJson as { workspaces?: unknown } | null)?.workspaces;
  if (Array.isArray(workspaces) && workspaces.length > 0) return true;

  const cargo = await readTextIfExists(scan, "Cargo.toml");
  if (cargo !== null && /^\s*\[workspace\]/m.test(cargo)) return true;

  // 兜底：在两个以上的"包目录"下各有一个清单文件。
  const packageDirs = new Set<string>();
  for (const file of scan.files) {
    if (!/(?:^|\/)(?:packages|apps|services|libs|modules)\/[^/]+\/(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(file)) {
      continue;
    }
    packageDirs.add(file.split("/").slice(0, -1).join("/"));
  }
  return packageDirs.size >= 2;
}

// ---------------------------------------------------------------- 归一化

/**
 * 归一化：**这是缓存键稳定性的唯一入口**（设计文档 §C.5）。
 *
 * 做三件事：去重、排序"顺序无意义"的数组、用固定键序重建对象。
 * **不动** `languages` / `packageManagers` 的顺序——那两个字段的顺序就是结论（第一个是主）
 * 而它的排序规则已经写在采集里（确定性的）。
 */
export function normalizeSignals(signals: RepoSignals): RepoSignals {
  const runtimeVersions: Record<string, string> = {};
  for (const language of VERSION_LANGUAGES) {
    const value = signals.runtimeVersions[language];
    if (value !== undefined && value !== "") runtimeVersions[language] = value.trim();
  }
  // 采集出来的版本里可能有我们认为不认识的键（将来加了语言就会）。按固定顺序排完之后
  // 再补上其余的，保证"新增一种语言"不会悄悄把键序打乱。
  for (const key of Object.keys(signals.runtimeVersions).sort()) {
    if (runtimeVersions[key] === undefined) runtimeVersions[key] = signals.runtimeVersions[key]!.trim();
  }
  return {
    languages: dedupe(signals.languages.map((item) => item.trim()).filter((item) => item !== "")),
    packageManagers: dedupe(signals.packageManagers.map((item) => item.trim()).filter((item) => item !== "")),
    runtimeVersions,
    hasDockerfile: signals.hasDockerfile,
    hasCompose: signals.hasCompose,
    hasDevcontainer: signals.hasDevcontainer,
    lockfiles: sortedUnique(signals.lockfiles),
    ciCommands: sortedUnique(signals.ciCommands),
    makeTargets: sortedUnique(signals.makeTargets),
    scripts: sortedUnique(signals.scripts),
    services: sortedUnique(signals.services),
    monorepo: signals.monorepo,
    ignored: normalizeIgnored(signals.ignored),
  };
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function sortedUnique(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item !== ""))].sort();
}

export function normalizeIgnored(ignored: readonly IgnoredField[]): IgnoredField[] {
  const seen = new Map<string, IgnoredField>();
  for (const item of ignored) {
    const entry: IgnoredField = { source: item.source, field: item.field, reason: item.reason };
    seen.set(`${entry.source}\u0000${entry.field}\u0000${entry.reason}`, entry);
  }
  return [...seen.values()].sort(compareIgnored);
}

function compareIgnored(a: IgnoredField, b: IgnoredField): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.field !== b.field) return a.field < b.field ? -1 : 1;
  if (a.reason === b.reason) return 0;
  return a.reason < b.reason ? -1 : 1;
}

// ---------------------------------------------------------------- 主入口

/**
 * 采集一份 `RepoSignals`。
 *
 * 【为什么它是 async 但很容易测】所有"读文件"都在这里发生；每个 reader 都能单独喂一个
 * 临时目录（`scanRepo` + reader 都是导出的），所以单测不需要真的仓库。
 */
export async function collectSignals(cloneDir: string, options: CollectOptions = {}): Promise<RepoSignals> {
  const scan = await scanRepo(cloneDir, options);
  const ignored: IgnoredField[] = [];

  const languages = readLanguages(scan);
  const managers = await readPackageManagers(scan);
  ignored.push(...managers.ignored);
  const versions = await readRuntimeVersions(scan);
  ignored.push(...versions.ignored);
  const entrypoints = await readBuildEntrypoints(scan);
  const ci = await readCiHints(scan);
  const services = await readServices(scan);
  ignored.push(...services.ignored);

  if (scan.truncated) {
    ignored.push({
      source: ".",
      field: "files",
      reason: `文件数超过上限（${options.maxFiles ?? DEFAULT_MAX_FILES}）：语言统计与 monorepo 判定按排在前面的那些文件算`,
    });
  }
  if (
    scan.files.some((file) => /^\.devcontainer\/.+\/devcontainer\.json$/.test(file)) &&
    !scan.files.includes(DEVCONTAINER_PATH)
  ) {
    // 命名变体（`.devcontainer/<name>/devcontainer.json`）只有多容器场景才用得上，M2 不接。
    // 但它必须被看见：否则"仓库明明有 devcontainer"与"推断说没有"会互相矛盾。
    ignored.push({
      source: ".devcontainer",
      field: "devcontainer.json",
      reason: "只支持 .devcontainer/devcontainer.json（命名变体是多容器场景，M2 不接）",
    });
  }
  // 认不出来的语言（矩阵里没有对应基础镜像）在这里就说清楚，别等到构建时才发现。
  for (const language of languages) {
    if (!["javascript", "typescript", "python", "go", "rust"].includes(language)) {
      ignored.push({
        source: ".",
        field: "languages",
        reason: `${language} 没有对应的 Layer 1 基础镜像（会退化成 ubuntu-dev，装依赖可能要在会话里做）`,
      });
    }
  }

  return normalizeSignals({
    languages,
    packageManagers: managers.packageManagers,
    runtimeVersions: versions.runtimeVersions,
    hasDockerfile: scan.files.includes("Dockerfile"),
    hasCompose: COMPOSE_FILES.some((file) => scan.files.includes(file)),
    hasDevcontainer: scan.files.includes(DEVCONTAINER_PATH),
    lockfiles: managers.lockfiles,
    ciCommands: ci.commands,
    makeTargets: entrypoints.makeTargets,
    scripts: entrypoints.scripts,
    services: services.services,
    monorepo: await detectMonorepo(scan),
    ignored,
  });
}
