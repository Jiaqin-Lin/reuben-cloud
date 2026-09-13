/**
 * `environment/types.ts` —— 环境（Layer 2）与仓库信号的纯类型定义（spec Phase 5 §1）。
 *
 * 【为什么类型要单独一个文件】推断（`infer.ts`）、采集（`signals.ts`）、devcontainer 解析
 * （`devcontainer.ts`）与存储（`store.ts`）之间的契约是这几个形状；放在一起之后，
 * "改了字段，谁受影响"这件事由编译器回答，而不是靠 grep。
 *
 * 【为什么这些形状是"可序列化"的】设计文档 §C.5 的构建缓存键把 `signals` 序列化之后
 * 当成输入：同一个仓库两次采集必须得到**逐字节相同**的 jsonb。所以这里一条 `Date`、
 * 一个 `Map`、一个函数都没有——全是字符串数组与扁平对象（归一化规则见 `signals.ts`）。
 */

import type { EnvBaseKind } from "./base-images.ts";

/** 环境行的两种身份：Layer 1 基础镜像的登记，或某个仓库推断/构建出来的环境。 */
export const ENV_KINDS = ["base", "project"] as const;
export type EnvKind = (typeof ENV_KINDS)[number];

/** 设计文档 §C.6 的五个状态。`failed` 是合法终态（"跑起来才发现装不上依赖"才是要避免的）。 */
export const ENV_STATUSES = ["draft", "building", "ready", "degraded", "failed"] as const;
export type EnvStatus = (typeof ENV_STATUSES)[number];

/** 三级推断的落点（设计文档 §C.3）。LLM 生成不在这里——它属于 P6 的 `generate.ts`。 */
export const INFERENCE_LEVELS = ["devcontainer", "dockerfile", "signals"] as const;
export type InferenceLevel = (typeof INFERENCE_LEVELS)[number];

/**
 * 构建队列的触发来源（设计文档 §C.8）。**只影响入队**，不改变构建流程。
 *
 * 【为什么它是类型而不是一句注释】`env_builds.trigger` 有 CHECK 约束，三处入队点
 * （会话 / CLI / 页面）与测试都按这三个值分支。写成字面量联合之后，拼错在编译期就报错。
 */
export const ENV_BUILD_TRIGGERS = ["first_seen", "manual", "promote"] as const;
export type EnvBuildTrigger = (typeof ENV_BUILD_TRIGGERS)[number];

/**
 * 一次构建尝试的 Dockerfile 是从哪来的：三级推断的 level，或 P6 的 LLM 生成。
 *
 * 【为什么与 `InferenceLevel` 分开】"这一版环境是 devcontainer 级推断"与
 * "这一次尝试的文本是模型生成的"是两个不同的事实：同一版环境的第 1 次尝试可能是
 * 规则生成（signals），第 2 次就是 llm。混用之后 UI 上会看到自相矛盾的两行。
 */
export const ENV_BUILD_INFERENCES = ["devcontainer", "dockerfile", "signals", "llm"] as const;
export type EnvBuildInference = (typeof ENV_BUILD_INFERENCES)[number];

/** 一次尝试的状态（`env_builds.status`）。`built` 只说明 docker build 成功——能不能用是 P7 的健康检查的事。 */
export const ENV_BUILD_STATUSES = ["building", "built", "failed"] as const;
export type EnvBuildStatus = (typeof ENV_BUILD_STATUSES)[number];

/**
 * 「看到了但没用」的一条记录。
 *
 * 【为什么这个类型值得存在】设计文档 §C.3 的原话是"不支持的字段要显式记录'已忽略'，
 * 而不是静默丢弃——用户下次问'为什么我的 devcontainer 没生效'时，日志里要有答案"。
 * 它同时是我们自己的调试入口：锁文件冲突、版本来源冲突、YAML 只做了行级扫描……
 * 全都从这里解释，不需要读代码。
 */
export interface IgnoredField {
  /** 哪个文件（相对仓库根；compose / workflow 也走这里）。 */
  source: string;
  /** 哪个字段（锁文件名、devcontainer 字段名、compose 的键……）。 */
  field: string;
  /** 为什么忽略它。**要能直接读给人看**，不要写"unsupported"。 */
  reason: string;
}

/**
 * 一次采集的结果：仓库的**事实**，不含结论。
 *
 * 事实与结论分开是有用的：`packageManagers` 是结论（按优先级挑出来的那个），
 * `lockfiles` 是事实（仓库里到底有哪些锁文件）。缓存键用前者（它才是环境构建的输入），
 * 排查用后者（"为什么没走 pnpm" 的答案在这里）。
 */
export interface RepoSignals {
  /** 按"文件数 + 是不是入口"排序，最可能的语言在前。 */
  languages: string[];
  /** 包管理器，按优先级排序（spec §C.3：锁文件比 package.json 权威）。 */
  packageManagers: string[];
  /** 运行时版本要求，键是语言（node / python / go / rust）。 */
  runtimeVersions: Record<string, string>;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasDevcontainer: boolean;
  /** 仓库里真实存在的锁文件（相对路径，排序）。 */
  lockfiles: string[];
  /** CI 里出现的 `run:` 命令（行级扫描的结果，见文件注释）。 */
  ciCommands: string[];
  /** Makefile / justfile 里的目标名（排序）。 */
  makeTargets: string[];
  /**
   * `package.json` 的 scripts 键（排序；附录 A-26）。
   *
   * 【为什么不并进 `makeTargets`】两个来源拼出来的 "build" 会让下游分不清
   * `make build` 还是 `npm run build`——那是要写进 buildCommands 的东西，歧义不能留到那里。
   */
  scripts: string[];
  /** compose 里出现的服务（canonical 名：postgres / redis / …）。 */
  services: string[];
  monorepo: boolean;
  ignored: IgnoredField[];
}

/**
 * 推断出的环境候选。**这一版是"可以直接构建的完整 Dockerfile 文本"**，不是片段：
 * 片段形态会让"能不能构建"这个问题的答案散落在拼装代码里。
 */
export interface EnvironmentCandidate {
  level: InferenceLevel;
  /**
   * Layer 1 的哪一档（附录 A-24）。
   *
   * 【为什么单独留一个字段而不是从 `baseImage` 反查】`baseImage` 是引用（将来是 digest），
   * 而"这是 node 还是 python 环境"是后续要用的事实：P7 的健康检查按它选命令、
   * UI 按它分组、P6 的生成 prompt 按它给候选。用字符串反查等于每次都要解析镜像名。
   */
  baseImageKind: EnvBaseKind;
  /** Layer 1 的镜像引用（`reuben-cloud/base-node-dev:dev`；P7 起换成 digest）。 */
  baseImage: string;
  /** 完整 Dockerfile 文本（可复现：同一份信号两次推断逐字节相同）。 */
  dockerfile: string;
  /** 建议的依赖安装 / 构建命令（P7 的健康检查按顺序跑它们）。 */
  buildCommands: string[];
  /** 建议的验证命令（跑测试 / 编译检查；也是给 agent 的提示）。 */
  verifyCommands: string[];
  /** 已知的降级风险（compose 服务不可用、不支持的 feature……）。 */
  degradedRisks: string[];
  /** 人话说明：命中了哪一级、依据是什么、忽略了什么。 */
  notes: string[];
}
