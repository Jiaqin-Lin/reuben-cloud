/**
 * 路径包含性校验：**所有**来自 CP 的路径都必须先过这里。
 *
 * Phase 1 只服务一个用途：`/exec` 的 `cwd`。Phase 2 会在同一个类上扩展出
 * 「读多根、写单根 + 写路径 dirname 回退」，而不是再写一份平行逻辑——
 * 路径校验是整个方案里最不能有第二份实现的东西。
 *
 * 已知残余风险（明写，不假装解决了）：校验与 open()/spawn() 之间存在 TOCTOU 窗口，
 * 期间可以把符号链接换掉。彻底解法是内核的 openat2(RESOLVE_BENEATH)，Node 没有暴露。
 * 威胁模型是「agent 误用或被提示注入后想读容器里的别的路径」，接受这个窗口。
 * 不为此发明黑名单。
 */

import { mkdir, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

export type ResolveFailureReason = "empty" | "nul" | "out_of_bounds";

export type ResolveResult = { ok: true; abs: string } | { ok: false; reason: ResolveFailureReason };

export class RootResolver {
  readonly root: string;
  /** realpath 后的根。macOS 上 /tmp 是 /private/tmp 的符号链接，不 realpath 前缀检查必炸。 */
  readonly realRoot: string;

  constructor(root: string, realRoot: string) {
    this.root = root;
    this.realRoot = realRoot;
  }

  /** 路径包含性：必须带分隔符，裸 startsWith(root) 会让 /workspace-evil 通过。 */
  contains(abs: string): boolean {
    return abs === this.realRoot || abs.startsWith(this.realRoot + path.sep);
  }

  /**
   * 按顺序做四件事，每一步都不能省：
   *  1. 空 / 含 \0 → 拒
   *  2. 相对路径按根解析，绝对路径原样
   *  3. 符号链接解析 + 包含性检查
   *     （ln -s /etc link 能过字面前缀，过不了这一步）
   *  4. 目标不存在时，用最深的已存在祖先做同样的解析与检查
   *
   * 为什么没有单独的「字面前缀检查」：它会把 root 本身是符号链接的情况误判成越界
   * （macOS 上 /var → /private/var），而真正要拦的是解析后的落点。
   * 第 4 步不能省——否则 root 里一个指向外部的目录（ln -s /etc link）加上
   * 一个还不存在的子路径就能绕过检查。
   *
   * 目标不存在是**允许**的：对 exec 来说「cwd 不存在」是运行期事实（→ failed 事件），
   * 不是策略违规（→ 400）。这个区分写死在这里。
   */
  resolve(input: unknown): ResolveResult {
    if (typeof input !== "string" || input === "") return { ok: false, reason: "empty" };
    if (input.includes("\0")) return { ok: false, reason: "nul" };

    const abs = path.resolve(this.realRoot, input);
    const target = resolveThroughSymlinks(abs) ?? abs;
    if (!this.contains(target)) return { ok: false, reason: "out_of_bounds" };

    return { ok: true, abs: target };
  }
}

export async function createRootResolver(root: string): Promise<RootResolver> {
  await mkdir(root, { recursive: true });
  return new RootResolver(root, await realpath(root));
}

/**
 * 把路径上的符号链接解析掉，允许最后几段不存在。
 * 先找最深的已存在祖先 realpath 之，再把还不存在的尾段接回去——尾段既然不存在，
 * 里面就不可能有符号链接。整条链都解析不了（连 / 都不行）时返回 null。
 */
function resolveThroughSymlinks(abs: string): string | null {
  const tail: string[] = [];
  let current = abs;

  for (;;) {
    const real = tryRealpath(current);
    if (real !== null) {
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.push(path.basename(current));
    current = parent;
  }
}

function tryRealpath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null; // ENOENT / ELOOP / EACCES
  }
}
