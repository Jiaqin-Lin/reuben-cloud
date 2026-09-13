/**
 * P8 · 解析 worker 的入口（spec Phase 8 §2 的"一批文件一个 worker，跑完退出"）。
 *
 * 【为什么这么薄】它只做三件事：解析 argv、调 `runWorkerMain`、把没被 catch 的异常变成一条
 * `fatal` 协议消息。真正的逻辑在 `parse.ts` 里（与主进程侧的协议实现放在一起），
 * 因为那两半必须一起读才能看懂——协议的发送方与接收方分到两个文件里，改一边忘一边的成本很高。
 *
 * 【崩溃是预期内的】WASM 的 OOM / abort 会让这个进程直接死掉，而主进程会把
 * "没有收到 `done`" 翻译成 `crashed`（`parse.ts`），再落一行 `status='failed'` 的索引记录。
 * 换句话说：**这个文件被写坏的代价只是一次索引失败，不是一次 Run 失败**。
 *
 * 【直接跑它】`node packages/control-plane/src/index/worker.ts --vendor vendor/tree-sitter < batch.json`
 * 可以手工喂一条批请求看输出（排障用；正常路径是 `indexer` spawn 它）。
 */

import process from "node:process";
import { parseWorkerArgs, runWorkerMain } from "./parse.ts";

try {
  process.exitCode = await runWorkerMain(parseWorkerArgs(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stdout.write(`${JSON.stringify({ type: "fatal", message })}\n`);
  process.exitCode = 1;
}
