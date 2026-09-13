/**
 * 启动、env、优雅退出。
 *
 * 启动三件事：realpath(WORKSPACE_ROOT) 并缓存、mkdir -p LOG_ROOT / HOME、监听。
 * 退出一件事：SIGTERM/SIGINT → 杀掉所有在跑的进程组 → 关闭 server → exit(0)。
 *
 * 退出那段在 Phase 5 才会被真正用到（Docker stop 先 SIGTERM、10 秒后 SIGKILL），
 * 但逻辑必须在 Phase 1 就写对——容器里留下孤儿进程比崩溃更难查。
 *
 * 【在链路中的位置】整个程序的入口：`node src/index.ts` 就从这里开始。
 * 它只干一件事——把 config / paths / registry / server 四块拼起来，然后等信号。
 * 之后所有“有请求进来”的事情都是由 server 的回调驱动的，不再回到这个文件。
 */

import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { loadConfig, VERSION } from "./config.ts";
import { createAgentServer } from "./server.ts";
import { createRootResolver } from "./paths.ts";
import { ExecutionRegistry } from "./exec/registry.ts";

/** 启动流程。只被文件末尾的 `main().catch(...)` 调一次；正常情况永不返回（进程一直监听）。 */
async function main(): Promise<void> {
  const config = loadConfig(); // 缺 token 直接抛，不设默认值

  // 两个目录必须在监听之前就存在：日志目录（registry 建记录时就要开文件）
  // 和 HOME（子进程需要它，不然很多工具会报错）。
  await mkdir(config.logRoot, { recursive: true });
  // 容器里 HOME 在 /tmp 下（不走 tmpfs 挂载点，见附录 A-2），由 agent 自己建：
  // 它自己就是 uid 1000，在 1777 的 /tmp 下建目录天然归自己所有。
  await mkdir(config.home, { recursive: true }).catch(() => {
    /* 建不了也不致命：exec 会如实报错 */
  });

  // 依赖注入的四个对象，顺序不能变：roots/sc 离不开 config，registry 离不开前两者。
  // readRoots 里第一个永远是写根（config.loadConfig 保证），额外读根本身可能还不存在，
  // createRootResolver 会 mkdir 它。
  const roots = await createRootResolver({
    writeRoot: config.workspaceRoot,
    readRoots: config.readRoots,
  });
  const registry = new ExecutionRegistry(config, roots);
  const server = createAgentServer(config, registry, roots);

  // ---------------------------------------------------------------- 信号处理
  //
  // 【顺序：必须在对外宣布就绪之前装好】这是一条被 CI 抓出来的真 bug（Phase 7 实现备注 18）：
  // banner 一旦写进管道，父进程（docker stop / 测试）读到它就可能立刻发 SIGTERM——而那一刻
  // 内核里 SIGTERM 还挂着**默认动作**（杀死进程），于是进程以"被信号打死"收场、退出码是 null。
  // 实测：macOS 上跑几十次不露头，Linux CI 上第一次真跑就翻了（EgressProxy 入口的同一条用例）。
  // 修法就是把它提到 listen() 之前：Docker stop 在启动途中到达也应该被优雅处理。
  //
  // shuttingDown 是个防重入锁：SIGTERM 和 SIGINT 几乎同时到（或者手贱连按两次 Ctrl-C）
  // 不能让收尾流程跑两遍。
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `[sandbox-agent] ${signal} received, terminating ${registry.runningCount} running execution(s)`,
    );

    // 顺序很重要：先把进程组杀干净，再关 server。反了就会留下孤儿进程。
    await registry.shutdown();

    // SSE 长连接会挡住 server.close()，必须显式拆掉。
    server.closeAllConnections();
    // 同样给 1s 上限：SSE 连接可能刚结束、TCP 还在挥手，不能为它无限等。
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      delay(1_000),
    ]);

    console.log("[sandbox-agent] stopped");
    // 显式 exit(0)：事件循环里可能还有 unref 之外的定时器，不 exit 会挂着不退。
    process.exit(0);
  };

  /**
   * 信号回调。信号回调是同步接口，而 shutdown 是 async——所以这里必须自己接住它的拒绝：
   * 未处理的 Promise 拒绝在 Node 24 里默认是**堆栈 + 非 0 退出**，那就变成了"SIGTERM
   * 导致容器崩溃"，比出错本身更难查。
   *
   * 收尾里出错也仍然 exit(0)：在 Docker 的信号路径上，退出码 0 的意思是"我按你的要求停了"，
   * 不是"一切顺利"——出错的细节已经写在 stderr 里了。
   */
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[sandbox-agent] shutdown failed: ${message}`);
      process.exit(0);
    });
  };
  // 两个信号都接。/docker stop/ 发的是 SIGTERM；Ctrl-C 是 SIGINT。
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  // 把"监听成功/失败"包成 Promise：否则代码会直接跑到底，
  // 连端口被占了都发现不了（listen 是异步的）。
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // address() 在监听成功之后必然有值；TS 推不出来（它可能是 string，比如 Unix socket），
  // 所以这里用 `as` 断言成 AddressInfo 才能读 .address / .port。
  const address = server.address() as AddressInfo;
  console.log(
    `[sandbox-agent] v${VERSION} listening on http://${address.address}:${address.port} ` +
      `workspace=${roots.realRoot} read=${roots.realReadRoots.join(",")} logs=${config.logRoot}`,
  );
}

/** sleep 用的小工具（Promise 化的 setTimeout）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 启动入口。`void` 同上——这是顶层语句，必须显式处理 Promise。
// 启动失败（比如没设 SANDBOX_AGENT_TOKEN）就在这里变成一行错误 + exit(1)：
// 容器生态里“快速失败”比“带着半死状态跑着”好得多。
void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[sandbox-agent] failed to start: ${message}`);
  process.exit(1);
});
