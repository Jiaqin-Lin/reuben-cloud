/**
 * fixture：TypeScript 的六种定义形态（P8 单测的金标准）。
 *
 * 【为什么不 import 真的东西】它只被 tree-sitter 解析、从不执行，也不进 tsc
 * （根 tsconfig 的 `exclude` 里有 `test/fixtures/**`）。所以这里的 `User` 是可以不存在的
 * 类型——符号提取关心的是"文本长成什么样"，不是"它能不能编译"。
 *
 * 【这份文件为什么同时覆盖"有 body"与"无 body"】测试要点 2 要的是签名重建的两种形态：
 * 函数/类/方法截到 body 之前；interface / type alias 这类没有 body 的声明取第一行。
 */

export interface RouteContext {
  readonly path: string;
  user: User;
}

export type Handler = (ctx: RouteContext) => Promise<string>;

export class Router {
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  add(path: string, handler: Handler): void {
    this.routes.set(this.prefix + path, handler);
  }

  async dispatch(ctx: RouteContext): Promise<string> {
    return this.resolve(ctx).call(ctx);
  }
}

export function createRouter(prefix: string): Router {
  return new Router(prefix);
}

export const defaultRouter = createRouter("/");
