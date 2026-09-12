/**
 * egress-proxy 的运维入口（`npm run proxy:up` / `proxy:down` / `proxy:status`）。
 *
 * 【为什么需要它】代理是全局常驻的基础设施（§F.2），而不是某个沙箱的一部分。
 * 在 Phase 7 的冒烟脚本和 Phase 8 的 manager 接管它之前，得有一个能手工起停它的落点——
 * 否则"验证 Phase 6"这件事就只能靠先创建一个沙箱（用错误的方式绕一大圈）。
 *
 * 【它不自己拼 docker 命令】全部走 `EgressProxy`（provider 旁边那个模块）：
 * 加固参数、双网络、标签、只读挂载都在那里定义，脚本只负责把 env 翻译成参数、
 * 把结果打印出来。任何"脚本里再写一份 docker run 参数"的做法都会立刻产生第二份加固实现。
 *
 * 用法：
 *   npm run proxy:up                 # 起（幂等：已经在跑就复用）
 *   npm run proxy:down               # 停（幂等）
 *   npm run proxy:status             # 看一眼
 *
 * 可覆盖的 env（都有合理缺省，不需要为了本地开发配任何东西）：
 *   EGRESS_PROXY_ALLOWLIST  宿主上的白名单文件，默认仓库里那份 deploy/egress-proxy/allowlist.txt
 *   EGRESS_PROXY_IMAGE      镜像引用，默认 reuben-cloud/egress-proxy:dev
 *   EGRESS_PROXY_NAME       容器名，默认 reuben-cloud-proxy（改它一般只为了测试）
 *   DOCKER_HOST             只支持本机 unix socket（与 provider 同一条规矩）
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROXY_IMAGE, EgressProxy, PROXY_ALLOWLIST_PATH } from "../packages/control-plane/src/provider/egress-proxy.ts";
import { PROXY_CONTAINER_NAME } from "../packages/control-plane/src/provider/types.ts";

/** 仓库根目录（这个文件在 scripts/ 下）。 */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_ALLOWLIST_PATH = join(REPO_ROOT, "deploy", "egress-proxy", "allowlist.txt");

async function main(): Promise<void> {
  const command = process.argv[2] ?? "up";
  const allowlistPath = process.env.EGRESS_PROXY_ALLOWLIST ?? DEFAULT_ALLOWLIST_PATH;
  const image = process.env.EGRESS_PROXY_IMAGE ?? DEFAULT_PROXY_IMAGE;
  const containerName = process.env.EGRESS_PROXY_NAME ?? PROXY_CONTAINER_NAME;

  const proxy = new EgressProxy({
    allowlistPath,
    image,
    containerName,
    log: (level, message, details) => {
      const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
      console.log(`[egress-proxy:${level}] ${message}${suffix}`);
    },
  });

  if (command === "up") {
    const status = await proxy.ensureRunning();
    console.log(
      [
        `代理已就绪：${status.containerName}`,
        `  镜像：   ${status.image}`,
        `  白名单： ${status.allowlistPath}（容器内只读挂到 ${PROXY_ALLOWLIST_PATH}）`,
        `  内网地址：${status.internalAddress ?? "(未拿到内网 IP)"}:3128（沙箱用 http://${containerName}:3128）`,
        `  沙箱里的用法：HTTP_PROXY=http://${containerName}:3128（provider 已经自动注入）`,
      ].join("\n"),
    );
    return;
  }

  if (command === "down") {
    await proxy.stop();
    console.log(`代理容器 ${containerName} 已停止（内网是所有沙箱共用的，保留）`);
    return;
  }

  if (command === "status") {
    const status = await proxy.inspect();
    if (status === null) {
      console.log(`代理容器 ${containerName} 不存在（用 npm run proxy:up 起一个）`);
      return;
    }
    console.log(
      JSON.stringify(
        {
          containerName: status.containerName,
          running: status.running,
          state: status.state,
          exitCode: status.exitCode,
          image: status.image,
          internalAddress: status.internalAddress,
          allowlistPath: status.allowlistPath,
          containerId: status.providerRef.slice(0, 12),
        },
        null,
        2,
      ),
    );
    // 不在跑是一个"非零退出"：CI 里 `npm run proxy:status` 应该能直接当断言用。
    if (!status.running) process.exitCode = 1;
    return;
  }

  console.error(`未知命令：${command}\n用法：node scripts/egress-proxy.ts [up|down|status]`);
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[egress-proxy] 操作失败：${message}`);
  process.exit(1);
});
