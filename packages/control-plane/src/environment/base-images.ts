/**
 * `environment/base-images.ts` —— Layer 1 基础镜像矩阵的**身份**（spec Phase 5 §5）。
 *
 * 【这里放什么、不放什么】只放"有哪些基础镜像、它们各自叫什么"——这是**别的模块都要引用
 * 的常量**：推断（`infer.ts` 选 FROM）、构建脚本（`scripts/build-images.ts` 打 tag）、
 * 集成测试（要建哪几个）、P7 的健康检查（按档选命令）。镜像里到底装了什么、谁的父级是谁，
 * 属于 Dockerfile 与构建脚本，不在这里重复一遍——两份"镜像内容的描述"必然会漂。
 *
 * 【为什么 tag 是 `dev` 而不是先算 digest】M2 的本地循环是"改一行 → 重建 → 跑"，
 * tag 让这条循环便宜；digest 是 provider 侧的硬要求（`SandboxSpec.image` 只收 digest），
 * 由 `resolveImageRef()` 在创建沙箱时解析。P7 做环境版本化时会把这个 tag 换成
 * `environments.image_digest`——那时"用什么引用"是数据，不是常量。
 */

/** 本地构建的命名空间。真发布到 registry 时由部署配置覆盖（那时这个常量只当缺省值）。 */
export const BASE_IMAGE_NAMESPACE = "reuben-cloud";

/** 本地 tag。**故意不带版本号**：`base-node-dev:dev` 永远指"我这台机器上刚建的那个"。 */
export const BASE_IMAGE_TAG = "dev";

/**
 * 矩阵里的七档。
 *
 * `common` 不是给环境用的（它只有运行时契约、没有语言工具链），所以环境推断只会落在
 * 下面 `ENV_BASE_KINDS` 那六档上——`EnvBaseKind` 这个类型就是为这件事存在的：
 * "选了一个不能当环境的基础镜像"会编译不过，而不是等到 build 失败。
 */
export const BASE_IMAGE_KINDS = [
  "common",
  "node-dev",
  "python-dev",
  "go-dev",
  "rust-dev",
  "fullstack",
  "ubuntu-dev",
] as const;

export type BaseImageKind = (typeof BASE_IMAGE_KINDS)[number];

/** 可以作为环境基础的档位（推断的取值域）。 */
export type EnvBaseKind = Exclude<BaseImageKind, "common">;

export const ENV_BASE_KINDS = BASE_IMAGE_KINDS.filter((kind): kind is EnvBaseKind => kind !== "common");

/** `reuben-cloud/base-node-dev:dev`。**所有引用都走这个函数**，不要在别处拼字符串。 */
export function baseImageRef(kind: BaseImageKind): string {
  return `${BASE_IMAGE_NAMESPACE}/base-${kind}:${BASE_IMAGE_TAG}`;
}

/**
 * 从一个镜像引用反查它是哪一档（不在矩阵里 / 是 `common` 就返回 null）。
 *
 * 【为什么需要它】P7 的 promote 拿到的是一份**人给的** Dockerfile：它的 `FROM` 决定了这一版
 * 环境长什么样（P6 里这个决定来自推断）。没有这个反查，promote 就只能沿用推断出来的档位——
 * 而一份把 FROM 从 node-dev 换成 fullstack 的文本会在库里被记成 node-dev。
 *
 * 【为什么只认 `base-<kind>` 这个名字形态】矩阵的引用只有 `baseImageRef()` 一个出处，
 * 而它永远是 `<namespace>/base-<kind>:<tag>`。解析名字（而不是比字符串）让"同一个镜像换个 tag"
 * 也能认出来（真发到 registry 之后 tag 会变成版本号）。
 */
export function baseKindOfRef(ref: string): EnvBaseKind | null {
  const name = ref.split("@")[0]!.split(":")[0]!;
  const last = name.split("/").pop() ?? "";
  if (!last.startsWith("base-")) return null;
  const kind = last.slice("base-".length);
  return (ENV_BASE_KINDS as readonly string[]).includes(kind) ? (kind as EnvBaseKind) : null;
}

/**
 * 默认沙箱镜像的 tag。
 *
 * 【为什么默认是 fullstack 而不是某一档语言镜像】这个 tag 是"本地开发与既有测试的底座"
 * （egress-proxy 的集成测试要 python venv、agent 集成测试要 node、image-check 要 git/tar），
 * 所以取矩阵里同时满足这三条的那一档。业务上真正给仓库用的镜像是 P6/P7 构建的
 * `reuben-cloud/env-…`，与这个 tag 无关。
 */
export const DEFAULT_SANDBOX_IMAGE = `${BASE_IMAGE_NAMESPACE}/sandbox-base:${BASE_IMAGE_TAG}`;

/** 允许用 `SANDBOX_IMAGE` 覆盖（集成测试与 image-check 都靠它换镜像）。 */
export function sandboxImageRef(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SANDBOX_IMAGE"];
  return override === undefined || override === "" ? DEFAULT_SANDBOX_IMAGE : override;
}
