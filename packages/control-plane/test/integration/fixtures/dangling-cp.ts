/**
 * "被 kill -9 的 CP" —— `sandbox-flow.integration.test.ts` 的夹具，**不是测试文件**。
 *
 * 【它做什么】连上测试用的 Postgres，真的建一个沙箱，真的起一条长命令（`sleep 300`），
 * 等到 agent 的 `/health` 报出 `activeExecution` 之后把 id 打到 stdout，然后**什么都不做地挂着**。
 * 父测试会在读到那一行之后 `SIGKILL` 掉它——那正是 Phase 8 用例 10 要复现的场景：
 * **一条执行在跑，而它的 SSE 消费者已经不在了**（§Phase 8 §5 第 3 条）。
 *
 * 【为什么必须是独立的进程】对账要处理的是"CP 的进程死了，但容器还活着"。
 * 在同一个进程里假装这件事（丢掉引用、不 await）测不出"没有 SSE 消费者"这个事实——
 * 连接还开着，终态事件还是会到达。真 SIGKILL 才能让那条连接真的断掉。
 *
 * 【它不清理】故意不清理：容器要留给父测试的对账去发现和处理。清理是父测试的事。
 */

import process from "node:process";
import { SandboxApiClient } from "../../../src/client/sandbox-api.ts";
import { Db, resolveDatabaseUrl } from "../../../src/db/client.ts";
import { SandboxManager } from "../../../src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../../../src/provider/local-docker.ts";

const image = process.env.RC_TEST_IMAGE;
if (image === undefined || image === "") {
  throw new Error("夹具需要 RC_TEST_IMAGE（带 digest 的镜像引用）");
}

const db = new Db({ connectionString: resolveDatabaseUrl() });
const api = new SandboxApiClient();
const manager = new SandboxManager({ db, provider: new LocalDockerProvider(), api, image });

const created = await manager.createSandbox({ runId: `run_dangling_${process.pid}` });

// 起一条长命令，**不 await**：父进程随时会把它连同这个进程一起 SIGKILL 掉。
manager
  .execInSandbox(created.sandboxId, { cmd: ["bash", "-lc", "sleep 300"], timeoutMs: 600_000 })
  .catch(() => undefined);

// 等 agent 真的把执行接过去了（activeExecution 非空）再报信——否则父进程会去对账一个
// 还没进入 BUSY 的沙箱，"杀掉遗留执行"那条路径就没被走到。
const deadline = Date.now() + 30_000;
for (;;) {
  const health = await api.health(created.endpoint!, created.authToken!);
  if (health.activeExecution !== null) {
    process.stdout.write(
      `${JSON.stringify({
        sandboxId: created.sandboxId,
        executionId: health.activeExecution,
        endpoint: created.endpoint,
      })}\n`,
    );
    break;
  }
  if (Date.now() > deadline) {
    process.stdout.write(`${JSON.stringify({ error: "没有等到 activeExecution" })}\n`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// 挂着不退出。父进程用 SIGKILL 结束它。
setInterval(() => undefined, 1000);
