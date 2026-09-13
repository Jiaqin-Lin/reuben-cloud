/**
 * P8 · 把 tree-sitter 的语法文件（.wasm）vendor 进仓库，并记录它们的 sha256。
 *
 * 【为什么是一个脚本，而不是"我下载了一份"】`vendor/tree-sitter/` 里躺着的是一堆二进制，
 * 而二进制没法 review。让它们的**来源、版本、摘要**由一段可重跑的代码决定，是这个目录
 * 唯一能被信任的方式：以后要升版本，改这里的 `GRAMMAR_SOURCE` 再跑一次，diff 里能看到
 * 摘要变了、以及 SHA256SUMS 的每一行。
 *
 * 【为什么从 npm 包取、而不是从各语言的 GitHub release 取】spec §0.2 的表格里写的就是
 * "vendored"，而 vendoring 要解决的是"运行时不去下载"。取值那一刻从哪里来是次要问题，
 * 但必须只有一个来源：`@vscode/tree-sitter-wasm` 是 VS Code 自己发布的、把十几种语言
 * 用同一套 tree-sitter 编译出来的包——一次取全，版本自洽（九个语法文件互相同版本），
 * 比从九个仓库各取一个 release 少九条会漂的路径。
 *
 * 【为什么不把 npm 包当依赖】spec §0.2 的"替代方案（不选的理由）"那一栏：
 * npm 包 = 版本漂移 + 安装期网络依赖；而"能不能建索引"不该依赖网络。
 * 这个脚本的存在只影响**重新 vendor 的那一刻**，不影响任何一次 `npm install`。
 *
 * 【用法】
 *   node scripts/vendor-tree-sitter.ts             # 从 registry 取（需要网络）
 *   node scripts/vendor-tree-sitter.ts --check     # 只校验现有文件的摘要（CI/离线可用）
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VENDOR_DIR = path.join(ROOT, "vendor", "tree-sitter");

/**
 * 语法文件的来源。**升版本只改这三行**（以及跑一遍脚本）。
 *
 * 为什么钉死到 0.3.x：语言 ABI 是 web-tree-sitter 与语法文件之间唯一的契约，
 * 两者的兼容窗口不宽（ABI 14/15 是当前的）。钉住之后，`web-tree-sitter` 的小版本
 * 升级不会突然遇到"这个语法文件读不了"。
 */
const GRAMMAR_SOURCE = {
  package: "@vscode/tree-sitter-wasm",
  version: "0.3.1",
  license: "MIT",
} as const;

/**
 * 我们 vendor 的语言。键是**我们的语言 id**（`symbols.ts` 里的那一套），
 * 值是包里的文件名（`tree-sitter-<name>.wasm`）。
 *
 * 九个而不是 spec 标题里写的"7 种"：设计文档 §D.2 的语言清单是
 * TypeScript/TSX、JavaScript、Python、Go、Rust、Java、Ruby、PHP——数一遍是九个
 * （TS 与 TSX 各需要一个语法文件），照清单做。
 */
export const VENDORED_GRAMMARS: Record<string, string> = {
  typescript: "typescript",
  tsx: "tsx",
  javascript: "javascript",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  ruby: "ruby",
  php: "php",
};

const LICENSE_NAME = "LICENSE";
const SUMS_NAME = "SHA256SUMS";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function wasmPath(language: string): string {
  return path.join(VENDOR_DIR, `tree-sitter-${VENDORED_GRAMMARS[language]}.wasm`);
}

/** 读 `SHA256SUMS`（`<sha>  <文件名>` 两列，与 `sha256sum` 的格式一致）。 */
async function readSums(): Promise<Map<string, string>> {
  const text = await readFile(path.join(VENDOR_DIR, SUMS_NAME), "utf8");
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/** 校验目录里现有的九个语法文件与 SHA256SUMS 是否一致。返回问题列表（空 = 全对）。 */
export async function verifyVendored(): Promise<string[]> {
  const problems: string[] = [];
  const sums = await readSums().catch(() => null);
  if (sums === null) {
    return [`读不到 ${SUMS_NAME}——vendor/tree-sitter/ 不完整，跑一次 scripts/vendor-tree-sitter.ts`];
  }
  for (const language of Object.keys(VENDORED_GRAMMARS)) {
    const name = `tree-sitter-${VENDORED_GRAMMARS[language]}.wasm`;
    const expected = sums.get(name);
    if (expected === undefined) {
      problems.push(`${name}：${SUMS_NAME} 里没有这一行`);
      continue;
    }
    const bytes = await readFile(wasmPath(language)).catch(() => null);
    if (bytes === null) {
      problems.push(`${name}：文件不存在`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== expected) problems.push(`${name}：摘要不符（期望 ${expected}，实际 ${actual}）`);
  }
  return problems;
}

/** 从 registry 取一次包，把九个语法文件与 LICENSE 落进 vendor/，然后重写 SHA256SUMS。 */
async function vendorFromRegistry(): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "rc-treesitter-"));
  try {
    const spec = `${GRAMMAR_SOURCE.package}@${GRAMMAR_SOURCE.version}`;
    console.log(`[vendor] 取 ${spec}`);
    // `npm pack` 而不是 `npm install`：只要那个 tarball，不要落 node_modules。
    const { stdout } = await execFileAsync("npm", ["pack", spec, "--pack-destination", temp], {
      cwd: temp,
      maxBuffer: 64 * 1024 * 1024,
    });
    const tarball = path.join(temp, stdout.trim().split("\n").pop()!);
    await execFileAsync("tar", ["-xzf", tarball, "-C", temp]);
    const extracted = path.join(temp, "package");

    await mkdir(VENDOR_DIR, { recursive: true });
    const sums: string[] = [];
    for (const language of Object.keys(VENDORED_GRAMMARS)) {
      const name = `tree-sitter-${VENDORED_GRAMMARS[language]}.wasm`;
      const bytes = await readFile(path.join(extracted, "wasm", name));
      await writeFile(path.join(VENDOR_DIR, name), bytes);
      sums.push(`${sha256(bytes)}  ${name}`);
      console.log(`[vendor] ${name}  ${(bytes.length / 1024).toFixed(0)} KiB`);
    }

    // 许可证跟着二进制一起进仓库：MIT 要求随分发保留版权声明，而"这个目录里的
    // 二进制从哪来"以后只有这份文件能回答。
    const license = await readFile(path.join(extracted, LICENSE_NAME), "utf8");
    await writeFile(
      path.join(VENDOR_DIR, LICENSE_NAME),
      `${license}\n取自 ${spec}（${GRAMMAR_SOURCE.license}）。各语法文件的上游见该包的 cgmanifest.json。\n`,
    );
    await writeFile(
      path.join(VENDOR_DIR, SUMS_NAME),
      `${sums.join("\n")}\n`,
    );
    console.log(`[vendor] 写入 ${sums.length} 个摘要 → vendor/tree-sitter/${SUMS_NAME}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const problems = check ? await verifyVendored() : [];
  if (check) {
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[vendor] ${problem}`);
      process.exit(1);
    }
    console.log(`[vendor] ${Object.keys(VENDORED_GRAMMARS).length} 个语法文件的摘要全部相符`);
  } else {
    await vendorFromRegistry();
    const after = await verifyVendored();
    if (after.length > 0) {
      for (const problem of after) console.error(`[vendor] ${problem}`);
      process.exit(1);
    }
  }
}
