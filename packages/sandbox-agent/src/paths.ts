/**
 * 路径包含性校验：**所有**来自 CP 的路径都必须先过这里。
 *
 * Phase 1 只服务一个用途：`/exec` 的 `cwd`（单根）。Phase 2 在**同一个类**上扩成
 * 「读多根、写单根」：`/files` 的读可以在任一读根之下，而写永远只落在 `writeRoot`。
 * exec 的 cwd、文件读、文件写、list 全部走这一个 `resolve()`——
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
import type { ErrorResponse } from "./types.ts";

/**
 * 路径被拒的三种原因。CP 拿到它就知道该怨谁：
 *  - empty        = 不是字符串，或者是空串
 *  - nul          = 含 \0（会被 C 层 syscall 截断，属于经典注入手法）
 *  - out_of_bounds = 解析符号链接之后落在了允许的根之外
 * 前两种是"这个参数根本不合法"，第三种是"参数合法但越界"——都是 400，但给 CP 的措辞不同。
 */
export type ResolveFailureReason = "empty" | "nul" | "out_of_bounds";

/** 校验结果：成功带绝对路径，失败带原因。 */
export type ResolveResult = { ok: true; abs: string } | { ok: false; reason: ResolveFailureReason };

/** resolve() 的第二个参数：这一次是读还是写。 */
export interface ResolveOptions {
  /**
   * true = 这是一次写，包含性只看 `writeRoot`；不传 = 读，可以是任一读根之下。
   * 为什么写要更严：写进去的东西必须能被 Phase 3 的 diff/archive 看见，
   * 而 `/tmp/reuben-cloud` 在 workspace 之外——允许往那儿写等于制造 diff 看不见的幽灵文件。
   */
  forWrite?: boolean;
}

/** createRootResolver 的参数。 */
export interface RootResolverOptions {
  /** 写根（唯一），也是**相对路径的解析基准**。 */
  writeRoot: string;
  /** 额外的只读根。writeRoot 会自动包含进来，不需要在这里重复列。 */
  readRoots?: string[];
}

export class RootResolver {
  /** 写根，原样保留一份（未 realpath），只用于日志和报错措辞。 */
  readonly writeRoot: string;
  /** 写根的 realpath。macOS 上 /tmp 是 /private/tmp 的符号链接，不 realpath 前缀检查必炸。 */
  readonly realWriteRoot: string;
  /** 读根列表（已 realpath、已去重、一定包含 realWriteRoot）。 */
  readonly realReadRoots: string[];

  constructor(writeRoot: string, realWriteRoot: string, realReadRoots: string[]) {
    this.writeRoot = writeRoot;
    this.realWriteRoot = realWriteRoot;
    this.realReadRoots = realReadRoots;
  }

  /** 写根的别名。Phase 1 的调用方（index.ts 的启动日志、exec 的报错）读的是这个名字。 */
  get root(): string {
    return this.writeRoot;
  }

  /** 写根 realpath 的别名，同上。 */
  get realRoot(): string {
    return this.realWriteRoot;
  }

  /**
   * 路径包含性：必须带分隔符，裸 startsWith(root) 会让 /workspace-evil 通过。
   *
   * @param options.forWrite 决定拿 writeRoot 还是整个读根集合来比。
   *                        **这个判断只在这里做一次**，别在上层再写一遍
   *                        （写操作漏传 forWrite 就是一次越界写）。
   */
  contains(abs: string, options: ResolveOptions = {}): boolean {
    const roots = options.forWrite === true ? [this.realWriteRoot] : this.realReadRoots;
    return roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  }

  /**
   * 校验并解析一个来自 CP 的路径。**所有**来自 CP 的路径都必须先过这里。
   *
   * @param input 故意声明为 `unknown`——它来自 HTTP body / query，类型系统无法保证它真的是字符串，
   *              所以第一件事就是自己判类型（而不是骗自己写 `input: string`）。
   * @returns ok=true 时 `abs` 是解析后的绝对路径（可以直接拿去 spawn / open）
   *
   * 按顺序做四件事，每一步都不能省：
   *  1. 空 / 含 \0 → 拒
   *  2. 相对路径按写根解析，绝对路径原样
   *  3. 符号链接解析 + 包含性检查
   *     （ln -s /etc link 能过字面前缀，过不了这一步）
   *  4. 目标不存在时，用最深的已存在祖先做同样的解析与检查
   *
   * 为什么相对路径只有一个基准（写根）：两个读根都在场时，同一个相对路径可以指向两处，
   * 「先试根 1 再试根 2」是个歧义规则。第二个读根用绝对路径访问（CP 拿到的是
   * /tmp/reuben-cloud/out/{id}.txt 这种绝对路径，本来就不需要相对形式）。
   *
   * 为什么没有单独的「字面前缀检查」：它会把 root 本身是符号链接的情况误判成越界
   * （macOS 上 /var → /private/var），而真正要拦的是解析后的落点。
   * 第 4 步不能省——否则 root 里一个指向外部的目录（ln -s /etc link）加上
   * 一个还不存在的子路径就能绕过检查。
   *
   * 目标不存在是**允许**的：对 exec 来说「cwd 不存在」是运行期事实（→ failed 事件），
   * 对写来说「目标不存在」是常态（→ 新建文件）。这个区分写死在这里。
   */
  resolve(input: unknown, options: ResolveOptions = {}): ResolveResult {
    if (typeof input !== "string" || input === "") return { ok: false, reason: "empty" };
    if (input.includes("\0")) return { ok: false, reason: "nul" };

    const abs = path.resolve(this.realWriteRoot, input);
    const target = resolveThroughSymlinks(abs) ?? abs;
    if (!this.contains(target, options)) return { ok: false, reason: "out_of_bounds" };

    return { ok: true, abs: target };
  }
}

/**
 * 构建根解析器：建目录 + 把各根的 realpath 缓存下来。
 * 启动时调一次（index.ts），之后整个进程共用。
 *
 * 为什么要缓存 realpath 而不是每次都算：每个请求都要做路径校验，
 * 而 realpath 是磁盘操作；根在进程生命期内不会变，算一次就够。
 */
export async function createRootResolver(options: RootResolverOptions): Promise<RootResolver> {
  // writeRoot 永远排第一、也永远在读集合里：刚 PUT 进去的文件必须能 GET 回来。
  const unique = [...new Set([options.writeRoot, ...(options.readRoots ?? [])])];
  for (const root of unique) {
    // 相对根会让包含性检查依赖进程 cwd——那是隐式状态，启动时就拒掉比以后调试便宜。
    if (!path.isAbsolute(root)) {
      throw new Error(`path root must be absolute, got ${JSON.stringify(root)}`);
    }
  }
  // 额外读根可能还不存在（/tmp/reuben-cloud 要等工具结果外置才会被写东西），先建出来。
  // 建不出来就让启动失败：一个不存在的读根只会把每次读变成 404，那是更难查的故障。
  await Promise.all(unique.map((root) => mkdir(root, { recursive: true })));

  const realWriteRoot = await realpath(options.writeRoot);
  // realpath 之后再去一次重：两个字面不同的路径可能指向同一个目录（符号链接）。
  const realReadRoots = [...new Set(await Promise.all(unique.map((root) => realpath(root))))];
  return new RootResolver(options.writeRoot, realWriteRoot, realReadRoots);
}

/**
 * 把 resolve() 的失败翻译成响应体。三个 `files/*` 处理器共用——
 * 「路径为什么被拒」的措辞只写一份，不三处各说各话。
 */
export function resolveFailureError(
  reason: ResolveFailureReason,
  roots: RootResolver,
  forWrite: boolean,
): ErrorResponse {
  if (reason === "out_of_bounds") {
    const allowed = forWrite ? [roots.realWriteRoot] : roots.realReadRoots;
    return {
      error: "path_out_of_bounds",
      message: `path must stay inside ${
        forWrite ? "the write root" : "one of the read roots"
      }: ${allowed.join(", ")}`,
    };
  }
  return { error: "invalid_path", message: `path is not usable: ${reason}` };
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

/** 单次 realpath 尝试：不存在 / 循环链接 / 没权限都归为"解析不了"（null），不抛。 */
function tryRealpath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null; // ENOENT / ELOOP / EACCES
  }
}
