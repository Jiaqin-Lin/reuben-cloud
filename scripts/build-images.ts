/**
 * Layer 1 基础镜像矩阵的构建入口（spec Phase 5 §5）。
 *
 * 用法：
 *   npm run build:image                   # 默认：common → fullstack → sandbox-base:dev
 *   npm run build:base-images             # 七档全建（go / rust 慢，只在真的需要时）
 *   node scripts/build-images.ts node-dev # 只建某一档（自动带上它的父级）
 *   node scripts/build-images.ts --list   # 只打印构建图，不建
 *   node scripts/build-images.ts --no-cache  # 忽略层缓存（怀疑缓存脏了时用）
 *
 * 【为什么要有这个脚本，而不是 package.json 里一串 docker build】
 *  ① 顺序就是依赖：语言镜像 `FROM` 基础镜像，sandbox-base `FROM` fullstack。
 *     手写命令时顺序错了会得到 "pull access denied"，看起来像网络问题；
 *  ② 镜像名必须与 TS 常量一致：推断产出的 Dockerfile 里那一行 `FROM` 来自
 *     `baseImageRef()`（`environment/base-images.ts`）。两处各写一份字符串迟早会漂，
 *     漂了之后的症状是"生成的 Dockerfile 指向一个没人建过的 tag"；
 *  ③ 构建完要打印 digest：CI 与 provider 都按 digest 认镜像（`SandboxSpec.image` 只收 digest）。
 *
 * 【为什么这个文件既能当 CLI 又被 import】`scripts/sandbox-image-check.ts` 检查的正是
 * 这条链的终点（sandbox-base），所以它 import 这里的 `buildImages()` 而不是再写一份
 * docker build —— 两份构建命令必然有一份先过期。main 只在"被当脚本跑"时执行
 * （下面的 `isMain`），import 它不会触发构建。
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BASE_IMAGE_KINDS,
  baseImageRef,
  sandboxImageRef,
} from "../packages/control-plane/src/environment/base-images.ts";
import type { BaseImageKind } from "../packages/control-plane/src/environment/base-images.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 可构建的镜像名 = 七档 Layer 1 + 默认沙箱镜像那一层薄封装。 */
export type ImageName = BaseImageKind | "sandbox-base";

interface ImageSpec {
  /** Dockerfile 路径（相对仓库根）。 */
  dockerfile: string;
  /** 它 `FROM` 谁（构建顺序由这个图决定；null = 从公共 registry 的基础镜像起）。 */
  parent: ImageName | null;
  /** 打什么 tag。函数形态是为了让 `SANDBOX_IMAGE` 这类覆盖在**调用时**生效。 */
  ref: () => string;
}

/** 构建图。**父级写在这里、不写在 Dockerfile 里**：Dockerfile 里的 `ARG BASE_IMAGE` 缺省值
 *  是给"手工 docker build"用的方便值，真正的顺序由这个表说了算（脚本会显式传 --build-arg）。 */
export const IMAGE_SPECS: Record<ImageName, ImageSpec> = {
  common: { dockerfile: "images/base/Dockerfile.common", parent: null, ref: () => baseImageRef("common") },
  "node-dev": { dockerfile: "images/base/Dockerfile.node-dev", parent: "common", ref: () => baseImageRef("node-dev") },
  "python-dev": { dockerfile: "images/base/Dockerfile.python-dev", parent: "common", ref: () => baseImageRef("python-dev") },
  "go-dev": { dockerfile: "images/base/Dockerfile.go-dev", parent: "common", ref: () => baseImageRef("go-dev") },
  "rust-dev": { dockerfile: "images/base/Dockerfile.rust-dev", parent: "common", ref: () => baseImageRef("rust-dev") },
  // fullstack 从 python-dev 叠（node 在 common 里，注释见该 Dockerfile）。
  fullstack: { dockerfile: "images/base/Dockerfile.fullstack", parent: "python-dev", ref: () => baseImageRef("fullstack") },
  "ubuntu-dev": { dockerfile: "images/base/Dockerfile.ubuntu-dev", parent: "common", ref: () => baseImageRef("ubuntu-dev") },
  "sandbox-base": { dockerfile: "images/sandbox/Dockerfile", parent: "fullstack", ref: () => sandboxImageRef() },
};

export const IMAGE_NAMES = Object.keys(IMAGE_SPECS) as ImageName[];

/** 本地开发与 CI 需要的那条链（其余的按需建）。 */
export const DEV_CHAIN: ImageName[] = ["sandbox-base"];

export interface BuildOutcome {
  name: ImageName;
  ref: string;
  /** docker build 的完整输出（stdout + stderr 合并）。缓存断言从这里读，见 image-check。 */
  output: string;
  /**
   * `#10 exporting config sha256:…` 里的那个 digest（镜像**内容**，不含构建时间戳）。
   *
   * 【为什么不用 `docker image inspect .Id`（除非拿不到输出）】containerd 镜像存储下 `.Id`
   * 是 **manifest list** 的 digest，而 BuildKit 每构建一次都会重写一次带时间戳的 attestation
   * manifest，于是它必然每次都变（实测如此）。config digest 覆盖的才是真正的镜像内容：
   * 全缓存命中时它逐字节不变——`sandbox-image-check` 的缓存断言就建在这上面。
   */
  configDigest: string | null;
}

export interface BuildOptions {
  /** `--progress=plain` 让输出里能看到 CACHED 与 exporting config。默认就是它。 */
  progress?: "plain" | "auto";
  /** 忽略层缓存（`--no-cache`）。 */
  noCache?: boolean;
  /** 每建完一个回调一次（CLI 打印进度用）。 */
  onProgress?: (message: string) => void;
}

/**
 * 建一批镜像，自动把父级按拓扑序补齐、去重。
 *
 * @throws 任何一个 build 失败时抛（附输出尾部 30 行）——半建完的链没有意义，
 *         继续往下建只会把错误归因到"父镜像不存在"上。
 */
export async function buildImages(names: readonly ImageName[], options: BuildOptions = {}): Promise<BuildOutcome[]> {
  const order = expandBuildList(names);
  const outcomes: BuildOutcome[] = [];
  for (const name of order) {
    const spec = IMAGE_SPECS[name];
    const ref = spec.ref();
    const args = [
      "build",
      `--progress=${options.progress ?? "plain"}`,
      "-f",
      spec.dockerfile,
      "-t",
      ref,
    ];
    // 显式传父级引用：Dockerfile 里的缺省值只是"手工 build 时的方便值"，
    // 真正的事实是 IMAGE_SPECS（否则改了 tag 会出现"脚本建 A、Dockerfile 找 B"）。
    if (spec.parent !== null) args.push("--build-arg", `BASE_IMAGE=${IMAGE_SPECS[spec.parent].ref()}`);
    if (options.noCache === true) args.push("--no-cache");
    args.push(".");

    options.onProgress?.(`构建 ${name}（${ref}）`);
    const result = await run(["docker", ...args]);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      throw new Error(`docker build 失败（${name}，exit ${result.code}）：\n${tail(output, 30)}`);
    }
    const configDigest =
      /exporting config (sha256:[0-9a-f]+)/.exec(output)?.[1] ?? (await inspectId(ref));
    outcomes.push({ name, ref, output, configDigest });
  }
  return outcomes;
}

/** 把一批镜像名展开成"带父级的拓扑序"。重复请求会去重。 */
export function expandBuildList(names: readonly ImageName[]): ImageName[] {
  const order: ImageName[] = [];
  const seen = new Set<ImageName>();
  const visit = (name: ImageName): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const parent = IMAGE_SPECS[name].parent;
    if (parent !== null) visit(parent);
    order.push(name);
  };
  for (const name of names) {
    if (!(name in IMAGE_SPECS)) {
      throw new Error(`未知的镜像名：${name}（可选：${IMAGE_NAMES.join(" / ")}）`);
    }
    visit(name);
  }
  return order;
}

/** 一次 docker 调用。argv 直传（与沙箱侧同一条规矩：不做字符串拼接，不经过 shell）。 */
async function run(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 退回到 `docker image inspect` 拿镜像 ID（`--progress=auto` 时输出里没有 config digest）。 */
async function inspectId(ref: string): Promise<string | null> {
  const result = await run(["docker", "image", "inspect", "--format", "{{.Id}}", ref]);
  if (result.code !== 0) return null;
  const id = result.stdout.trim();
  return /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

// ---------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "用法：node scripts/build-images.ts [镜像名…] [--all] [--list] [--no-cache]",
        "",
        `镜像名：${IMAGE_NAMES.join(" / ")}`,
        "不给名字 = 建默认链（common → fullstack → sandbox-base）",
        "--all = 七档 Layer 1 + sandbox-base 全建（go / rust 很慢）",
        "（npm 侧：build:image = 默认链；build:base-images = --all）",
      ].join("\n"),
    );
    return;
  }

  if (args.includes("--list")) {
    for (const name of IMAGE_NAMES) {
      const spec = IMAGE_SPECS[name];
      console.log(`${name.padEnd(14)} ${spec.ref().padEnd(38)} ${spec.dockerfile}${spec.parent === null ? "" : `  ← ${spec.parent}`}`);
    }
    return;
  }

  const requested = args.filter((item) => !item.startsWith("--")) as ImageName[];
  const names: ImageName[] = args.includes("--all")
    ? [...BASE_IMAGE_KINDS, "sandbox-base"]
    : requested.length > 0
      ? requested
      : DEV_CHAIN;
  const noCache = args.includes("--no-cache");

  // 先把图算出来再打印：顺序错了在建之前就该看到，而不是建到一半才发现。
  const order = expandBuildList(names);
  console.log(`构建顺序：${order.join(" → ")}${noCache ? "（--no-cache）" : ""}\n`);

  const started = Date.now();
  const outcomes = await buildImages(names, {
    noCache,
    onProgress: (message) => console.log(`→ ${message}`),
  });

  console.log("");
  for (const outcome of outcomes) {
    console.log(`✓ ${outcome.name.padEnd(14)} ${outcome.ref.padEnd(38)} ${outcome.configDigest ?? "(无 digest)"}`);
  }
  console.log(`\n${outcomes.length} 个镜像，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[build-images] 失败：${message}`);
    process.exit(1);
  });
}
