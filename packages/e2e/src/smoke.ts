/**
 * Phase 7 冒烟脚本的入口（`npm run smoke`）。
 *
 * 【为什么需要一个入口脚本】spec 写的用法是 `npm run smoke -- --tag=isolation`，而
 * `node --test` **不吃自定义参数**：Node 24（CI 用的版本）对未知选项直接
 * `node: bad option: --tag=isolation`，Node 26 则是静默丢掉——两种都不能用。
 * 于是标签解析必须发生在另一个进程里：本脚本把 `--tag=` 翻译成 `SMOKE_TAGS` 环境变量，
 * 再 spawn `node --test`。用例侧只认那个环境变量（见 harness.ts 的 smokeGroup）。
 *
 * 【前置检查为什么也在这里】"Docker 没起"、"镜像没建"、"代理没跑"这三件事如果在第一个
 * 用例里才炸，人会收到一堆看不懂的断言失败。放在这里，它们就是三句人话，而且发生在
 * 建任何容器之前。代理还会被**自动拉起**（EgressProxy.ensureRunning 幂等）——
 * 白名单用的是仓库里那份 deploy/egress-proxy/allowlist.txt，所以"本机跑冒烟"
 * 不需要先手工 `npm run proxy:up`，也不会踩到某个开发者自己改过的清单。
 *
 * 用法：
 *   npm run smoke                       # 全部（CI 就是这一条）
 *   npm run smoke -- --tag=isolation    # 只跑隔离红线
 *   npm run smoke -- --tag=exec,files   # 多标签（逗号分隔）
 *   npm run smoke -- --list             # 只列出会被跑的文件，不起容器
 *   npm run smoke -- --help
 *
 * 没有"跳过失败项"的开关：CI 里只有上面第一条（spec Phase 7 §4）。`--tag=` 是**选择**，
 * 不是跳过——被标签筛掉的组会在报告里明确显示为 skipped，并带上原因。
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROXY_IMAGE, EgressProxy } from "../../control-plane/src/provider/egress-proxy.ts";
import { PROXY_CONTAINER_NAME } from "../../control-plane/src/provider/types.ts";
import { dockerAvailable, dockerOrThrow, resolveImageRef } from "../../control-plane/test/support.ts";
import { DEFAULT_IMAGE_TAG } from "../../control-plane/test/support.ts";
import { sweepSmokeLeftovers } from "./harness.ts";

/** 仓库根（本文件在 packages/e2e/src/ 下）。 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEST_DIR = join(REPO_ROOT, "packages", "e2e", "test");
const DEFAULT_ALLOWLIST = join(REPO_ROOT, "deploy", "egress-proxy", "allowlist.txt");

/**
 * 单条用例的时限。3 分钟：够 `npm ci && npm test`、够 OOM、够一次真实装包，
 * 又不至于让一个挂住的用例把 CI 挂到天荒（spec §0.5 对 `--test-timeout` 的同一条理由）。
 */
const TEST_TIMEOUT_MS = 180_000;

/**
 * 并发度固定 1（串行跑各个测试文件）。冒烟里每个文件都会起一个 1 GiB 的沙箱，
 * 并行跑除了把 CI runner 的内存和 npm registry 的连接搅在一起之外没有任何好处——
 * 冒烟要的是**可重复**，不是快。
 */
const TEST_CONCURRENCY = 1;

interface Cli {
  tags: string[];
  list: boolean;
  help: boolean;
}

const USAGE = [
  "用法：npm run smoke -- [--tag=<t1,t2>] [--list] [--help]",
  "",
  "  --tag=isolation   只跑隔离红线（Linux）",
  "  --tag=network     只跑出网白名单相关",
  "  --tag=exec        只跑容器里的 exec 链路",
  "  --tag=files       只跑容器里的文件 API",
  "  --tag=flow        只跑业务链路（灌入 → npm ci/test → diff → archive → destroy）",
  "  --list            只列出会跑的文件",
  "",
  "不传 --tag 就是全部。多个标签用逗号分隔；不可识别的参数会让脚本直接退出，",
  "免得打错字之后「什么都没跑」还显示全绿。",
].join("\n");

/** 参数写错时的专用错误：只打一行提示，不要一屏堆栈（堆栈是脚本自己的 bug 才需要）。 */
class UsageError extends Error {}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { tags: [], list: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--list") {
      cli.list = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      cli.help = true;
      continue;
    }
    const inline = /^--tag=(.*)$/.exec(arg);
    const value = inline !== null ? inline[1]! : arg === "--tag" ? argv[++index] : undefined;
    if (value === undefined) {
      throw new UsageError(`不认识的参数：${arg}\n\n${USAGE}`);
    }
    for (const tag of value.split(",")) {
      const trimmed = tag.trim();
      if (trimmed !== "") cli.tags.push(trimmed);
    }
  }
  // 去重但保序：重复的标签没有意义，保留顺序让日志读起来和输入一致。
  cli.tags = [...new Set(cli.tags)];
  return cli;
}

/** 要被 node --test 跑的文件。显式列出而不是传目录：目录会被展开成"所有文件"，连脚手架都跑。 */
function smokeFiles(): string[] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".smoke.ts"))
    .sort()
    .map((name) => join(TEST_DIR, name));
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }

  const negativeControl = process.env.SMOKE_NEGATIVE_CONTROL === "1" || process.env.SMOKE_NEGATIVE_CONTROL === "true";
  if (negativeControl) {
    // 反向验证只允许在 Linux 上、且只允许和 --tag=isolation 一起跑。两条都是为了避免
    // "钩子开着却跑了别的东西"这种最难发现的错误结论。
    if (process.platform !== "linux") {
      console.error(
        `SMOKE_NEGATIVE_CONTROL 只能在 Linux 上做（当前 ${process.platform}）：\n` +
          "隔离红线在别的平台上不具验证力（spec Phase 7 §4），钩子开着跑出来的结果说明不了任何事。",
      );
      return 2;
    }
    if (!cli.tags.includes("isolation")) {
      console.error("SMOKE_NEGATIVE_CONTROL 只允许与 `--tag=isolation` 一起用（CI 的反向验证 job 就是这么跑的）。");
      return 2;
    }
  }

  const files = smokeFiles();
  if (files.length === 0) {
    console.error(`没有找到任何 *.smoke.ts（看的是 ${TEST_DIR}）`);
    return 2;
  }

  console.log(`=== reuben-cloud · 冒烟脚本（Phase 7）===`);
  console.log(`平台：${process.platform} / Node ${process.version}`);
  console.log(`标签：${cli.tags.length === 0 ? "(全部)" : cli.tags.join(",")}`);
  console.log(`文件：${files.map((file) => file.replace(`${TEST_DIR}/`, "")).join(", ")}`);
  if (negativeControl) {
    console.log("⚠️  SMOKE_NEGATIVE_CONTROL=1：CapDrop 被故意拿掉，本次**必须变红**，红了才算通过。");
  }
  if (process.platform !== "linux" && !negativeControl) {
    console.log(
      "提示：隔离红线只在 Linux 上有验证力（spec Phase 7 §4），macOS 上默认跳过；" +
        "本地要一份参考结论可以加 SMOKE_ANY_PLATFORM=1。",
    );
  }
  if (cli.list) {
    return 0;
  }

  // ---- 前置检查（都在建任何容器之前）
  if (!(await dockerAvailable())) {
    console.error("需要可用的 Docker daemon：冒烟脚本要真的起沙箱。");
    return 1;
  }
  console.log(`Docker：${(await dockerOrThrow(["version", "--format", "{{.Server.Version}}"] )).trim()}`);

  // 镜像必须先建好：冒烟不该顺手构建一个镜像（apt 层要几分钟），也不该给一个错觉
  // 说"跑一下就什么都有了"。失败信息里已经带着该跑哪条命令（见 resolveImageRef）。
  const imageRef = await resolveImageRef(process.env.SANDBOX_IMAGE ?? DEFAULT_IMAGE_TAG, "npm run build:image");
  // 裸 `sha256:` 是经典存储下本地构建镜像的形态（没有 RepoDigests 可退回，见 Phase 7 备注 19）。
  // 打出来是为了让 CI 日志能直接回答"这次跑的是哪种引用"——这两个形态的失败模式完全不同。
  console.log(`沙箱镜像：${imageRef}${imageRef.startsWith("sha256:") ? "（本地镜像 ID）" : ""}`);

  // 代理：幂等拉起 + 用仓库里那份白名单。失败信息里同样带着该跑哪条命令。
  try {
    const proxy = await new EgressProxy({
      allowlistPath: process.env.EGRESS_PROXY_ALLOWLIST ?? DEFAULT_ALLOWLIST,
      image: process.env.EGRESS_PROXY_IMAGE ?? DEFAULT_PROXY_IMAGE,
      containerName: process.env.EGRESS_PROXY_NAME ?? PROXY_CONTAINER_NAME,
    }).ensureRunning();
    console.log(`出网代理：${proxy.containerName}（${proxy.internalAddress ?? "未拿到内网 IP"}，白名单 ${proxy.allowlistPath}）`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`出网代理起不来：${message}\n（自建镜像不存在时先跑 \`npm run build:proxy-image\`）`);
    return 1;
  }

  // 上一次跑崩留下的沙箱：现在清掉。放这里而不是用例里，是因为并发跑文件时
  // 每个文件都会建自己的沙箱，"清理"会把别人的一起删掉。
  const swept = await sweepSmokeLeftovers();
  if (swept.length > 0) console.log(`清掉上次残留：${swept.join("、")}`);
  console.log("");

  // ---- 交给 node --test。显式 glob 与显式超时，理由见文件头与 spec §0.5。
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      `--test-timeout=${TEST_TIMEOUT_MS}`,
      `--test-concurrency=${TEST_CONCURRENCY}`,
      ...files,
    ],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        // 空字符串表示"全跑"；非空时由 harness 的 smokeGroup 按标签整组跳过。
        SMOKE_TAGS: cli.tags.join(","),
      },
    },
  );

  return await new Promise<number>((resolve) => {
    child.on("error", (error: unknown) => {
      console.error(`起不来 node --test：${error instanceof Error ? error.message : String(error)}`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        console.error(`测试进程被信号 ${signal} 打断`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exit(2);
    }
    console.error(`冒烟脚本自己挂了：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
