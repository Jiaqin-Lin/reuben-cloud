/**
 * `tools/index.ts` —— 把四个工具装配成循环消费的形状（`definitions` + `run`）。
 *
 * 【为什么多这一个文件（不在 spec 的交付物清单里）】`loop.ts` 只该懂"循环"：
 * 轮数、上限、重复检测、消息拼装。它 import 四个具体工具、拿 `SandboxManager`、
 * 拼 `ToolContext` 的结果是**循环与沙箱耦合**——而这两件事的变化频率完全不同
 * （换沙箱 API 不该动循环逻辑，调循环策略不该动工具）。
 * 装配点放在这里之后，循环的单测可以塞一个脚本化的假工具箱，一行 Docker 都不用。
 *
 * 【`definitions` 的顺序】这里按名字排好（read / list / bash / write 之外还有将来）；
 * `model.ts` 发送前还会再排一次——**缓存前缀要求字节稳定**，两处都排才不怕有人
 * 在这里调顺序（§6 的验证提示直接点名了这个坑）。
 */

import type { ToolDefinition } from "../model.ts";
import type { RunEventSink } from "../events.ts";
import type { ToolResult } from "./types.ts";
import { bashTool, runBash } from "./bash.ts";
import { listTool, runList } from "./list.ts";
import { readTool, runRead } from "./read.ts";
import { writeTool, runWrite } from "./write.ts";
import type { ExecPort, ReadAnchors, SandboxFilesPort, ToolContext } from "./types.ts";
import { createReadAnchors, fail } from "./types.ts";
import { REPO_DIR } from "../prompt.ts";
import { noopLog } from "../../log.ts";
import type { LogFn } from "../../log.ts";
import type { SandboxTarget } from "../../repo/types.ts";

/** 工具箱：循环拿到的那两个东西。 */
export interface AgentToolkit {
  /** 传给模型的工具定义（已按名字排序）。 */
  definitions: ToolDefinition[];
  /** 执行一次工具调用。**不抛异常**：失败也是 `isError: true` 的结果。 */
  run(name: string, input: unknown): Promise<ToolResult>;
}

export interface ToolkitOptions {
  sandboxId: string;
  exec: ExecPort;
  api: SandboxFilesPort;
  target: SandboxTarget;
  /** 模型心里的工作目录，默认 `REPO_DIR`。 */
  repoDir?: string;
  /** 续读锚点表。缺省每个工具箱一个（一个 Run 一份，默认 8 个文件）。 */
  anchors?: ReadAnchors;
  signal?: AbortSignal;
  /** 实时事件出口（Phase 13）。不接就是一个没有观察窗的 Run。 */
  events?: RunEventSink;
  log?: LogFn;
}

/** 装配。**一个 Run 一个工具箱**（锚点表与 signal 都是 Run 级的）。 */
export function createToolkit(options: ToolkitOptions): AgentToolkit {
  const context: ToolContext = {
    sandboxId: options.sandboxId,
    exec: options.exec,
    api: options.api,
    target: options.target,
    repoDir: options.repoDir ?? REPO_DIR,
    anchors: options.anchors ?? createReadAnchors(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.events === undefined ? {} : { events: options.events }),
    log: options.log ?? noopLog,
  };

  const definitions = [bashTool, readTool, writeTool, listTool].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  return {
    definitions,
    run: (name, input) => dispatch(name, input, context),
  };
}

/** 名字 → 实现。认不出的名字是工具失败（模型写错名字时它自己能看到）。 */
export async function dispatch(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
  switch (name) {
    case "bash":
      return runBash(input, context);
    case "read":
      return runRead(input, context);
    case "write":
      return runWrite(input, context);
    case "list":
      return runList(input, context);
    default:
      return fail(`没有这个工具：${name}。可用的工具是 bash / read / write / list。`);
  }
}
