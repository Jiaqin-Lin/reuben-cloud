/**
 * 启动、env、优雅退出。
 *
 * 启动三件事：realpath(WORKSPACE_ROOT) 并缓存、mkdir -p LOG_ROOT / HOME、监听。
 * 退出一件事：SIGTERM/SIGINT → 杀掉所有在跑的进程组 → 关闭 server → exit(0)。
 *
 * 退出那段在 Phase 5 才会被真正用到（Docker stop 先 SIGTERM、10 秒后 SIGKILL），
 * 但逻辑必须在 Phase 1 就写对——容器里留下孤儿进程比崩溃更难查。
 */

import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { loadConfig, VERSION } from "./config.ts";
import { createAgentServer } from "./server.ts";
import { createRootResolver } from "./paths.ts";
import { ExecutionRegistry } from "./exec/registry.ts";

async function main(): Promise<void> {
  const config = loadConfig(); // 缺 token 直接抛，不设默认值

  await mkdir(config.logRoot, { recursive: true });
  // 容器里 HOME 在 /tmp 下（不走 tmpfs 挂载点，见附录 A-2），由 agent 自己建：
  // 它自己就是 uid 1000，在 1777 的 /tmp 下建目录天然归自己所有。
  await mkdir(config.home, { recursive: true }).catch(() => {
    /* 建不了也不致命：exec 会如实报错 */
  });

  const roots = await createRootResolver(config.workspaceRoot);
  const registry = new ExecutionRegistry(config, roots);
  const server = createAgentServer(config, registry);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  console.log(
    `[sandbox-agent] v${VERSION} listening on http://${address.address}:${address.port} ` +
      `workspace=${roots.realRoot} logs=${config.logRoot}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `[sandbox-agent] ${signal} received, terminating ${registry.runningCount} running execution(s)`,
    );

    await registry.shutdown();

    // SSE 长连接会挡住 server.close()，必须显式拆掉。
    server.closeAllConnections();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      delay(1_000),
    ]);

    console.log("[sandbox-agent] stopped");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[sandbox-agent] failed to start: ${message}`);
  process.exit(1);
});
