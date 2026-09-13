/**
 * `environment/cache.ts` —— 构建缓存的键（spec Phase 7 §1；设计文档 §C.5）。
 *
 * ```
 * cacheKey = sha256([baseImage, normalizeSignals(signals), BUILDER_VERSION, dockerfileText].join("\n"))
 * ```
 *
 * 【这个键存在的意义不是省钱，是"提前建"】设计文档 §C.8 说得很直白：仓库第一次被看见时就
 * 后台走一遍构建，第二个人 / 第二次会话秒开的那个体验就来自这里。所以键的两条要求是
 * **稳定**（同一份事实算两次必须一样，否则永远不命中）与**敏感**（任何会影响产物的事实变了
 * 都必须变，否则会静默用一个不对的镜像）。
 *
 * 【为什么 dockerfileText 也进键】同一份信号可能因为级别不同（devcontainer / 规则 / LLM 自愈）
 * 得到不同的文本，而文本不同就是产物的不同。P6 已经把"自愈成功后真正构建的那份文本"写回
 * `environments.dockerfile`（A-38），这一步正是为了让这里读到的是事实。
 *
 * 【为什么 BUILDER_VERSION 是手工维护的整数】有一类变化这个键里的其余三项都看不见：
 * 生成 prompt 改了、Layer 1 基础镜像重建了（tag 没变）、叠加组件清单改了。改它们时必须有人
 * 把版本 +1 —— 否则就会出现"本地是好的、线上是旧的"这类最难查的问题（§C.5 的原话）。
 * 它只增不减；每次改动写明在下面的注释里。
 *
 * 【规范化到什么程度】只做"同一份事实的两种写法算成同一个键"该做的事：排序集合类的数组、
 * 排序 ignored 的键、丢掉空串与只含注释的行、丢掉首尾空白。**不做**语言 / 包管理器的排序
 * ——它们是"按优先级排好的结论"（signals.ts 的类型注释），排序会改变它的含义。
 */

import { createHash } from "node:crypto";
import type { RepoSignals } from "./types.ts";

/**
 * 构建管线版本。**改了下面任何一样就要 +1**（spec §1："改 prompt / 改 Layer 1 / 改叠加组件
 * 都要 +1"）：
 *  · `generate.ts` 的生成 prompt 或硬约束；
 *  · `images/base/Dockerfile.*`（Layer 1 的内容，tag 不变）；
 *  · `infer.ts` 的叠加组件与渲染模板。
 *
 * 1 = P7 落地时的版本。
 */
export const BUILDER_VERSION = 1;

/** 集合类字段（顺序无意义）。语言与包管理器不在这里——它们的顺序是结论，见文件头。 */
const SET_FIELDS = ["lockfiles", "ciCommands", "makeTargets", "scripts", "services"] as const;

/** 一行字符串的规范化：去首尾空白、丢掉只含注释的行与空行。 */
function normalizeLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  return trimmed;
}

function normalizeList(items: readonly string[], sort: boolean): string[] {
  const cleaned = items.map(normalizeLine).filter((item): item is string => item !== null);
  const unique = [...new Set(cleaned)];
  return sort ? unique.sort() : unique;
}

/**
 * 把信号变成**逐字节稳定**的一份东西。
 *
 * 【为什么键序也要排】`runtimeVersions` 是 `Record`，它的键序取决于采集时的写入顺序；
 * 序列化之后那就是字节差异。`ignored` 同理（它的顺序取决于文件遍历顺序）。
 */
export function canonicalSignals(signals: RepoSignals): string {
  const runtimeVersions: Record<string, string> = {};
  for (const key of Object.keys(signals.runtimeVersions).sort()) {
    const value = normalizeLine(signals.runtimeVersions[key]!);
    if (value !== null) runtimeVersions[key] = value;
  }
  const canonical = {
    languages: normalizeList(signals.languages, false),
    packageManagers: normalizeList(signals.packageManagers, false),
    runtimeVersions,
    hasDockerfile: signals.hasDockerfile,
    hasCompose: signals.hasCompose,
    hasDevcontainer: signals.hasDevcontainer,
    ...Object.fromEntries(SET_FIELDS.map((field) => [field, normalizeList(signals[field], true)])),
    monorepo: signals.monorepo,
    ignored: [...signals.ignored]
      .map((item) => ({ source: item.source.trim(), field: item.field.trim(), reason: item.reason.trim() }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.field.localeCompare(b.field) || a.reason.localeCompare(b.reason)),
  };
  return JSON.stringify(canonical);
}

export interface CacheKeyInput {
  /** Layer 1 的引用（这一版环境从哪个镜像长出来的）。 */
  baseImage: string;
  signals: RepoSignals;
  /** 这一版最终生效的 Dockerfile 文本。 */
  dockerfileText: string;
  /** 测试用；缺省 `BUILDER_VERSION`。 */
  builderVersion?: number;
}

/**
 * 算缓存键。
 *
 * 【为什么用 `\n` 拼接是安全的】前两段里不可能出现裸换行（JSON 会把换行转义成 `\n` 两个字符，
 * 镜像引用里不可能有换行），而 Dockerfile 文本**放在最后**——它就算含换行也不会把后面某段
 * 挤到另一段的位置上。这个顺序是契约的一部分，改动它等于让所有旧键失效（那倒也无害，
 * 只是要同时 +1 BUILDER_VERSION 让原因显式）。
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const parts = [
    input.baseImage.trim(),
    canonicalSignals(input.signals),
    String(input.builderVersion ?? BUILDER_VERSION),
    input.dockerfileText,
  ];
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

/** 缓存键在 UI / 日志里的短形态（前 12 位：够区分，也不会把界面撑爆）。 */
export function shortCacheKey(cacheKey: string): string {
  return cacheKey.slice(0, 12);
}
