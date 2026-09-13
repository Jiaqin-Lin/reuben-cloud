/** fixture 的入口：P5 只读它，不执行它（语言统计需要"这是一个 TypeScript 仓库"这个事实）。 */
export function greet(name: string): string {
  return `hi ${name}`;
}

export const version = "1.0.0";
