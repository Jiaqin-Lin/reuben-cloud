/**
 * Phase 4 · 沙箱镜像检查（`npm run check:image`）。
 *
 * 【为什么是脚本，不是 node:test 用例】spec §0.5 把测试分三层，硬要求 `npm test`
 * 永远不需要 Docker；而这里要构建镜像、起容器、连 SSE，属于集成层。Phase 7 的
 * `npm run smoke` 需要完整栈（CP + Postgres + 代理），在 Phase 4 还替不了它。
 * 所以 Phase 4 的这些检查需要一个自己的落点——就是本文件。
 *
 * 【它检查什么】spec Phase 4「测试要点」8 条 + 3 条更便宜、更早暴露的补充断言
 * （镜像里没有默认 token、镜像默认用户、命名卷初始化属主）。用到的加固参数与
 * Phase 5 的 LocalDockerProvider 刻意保持一致（--read-only / --cap-drop ALL /
 * --tmpfs /tmp / --user 1000:1000 / --init）——镜像只有在**那组约束下**能跑才算数，
 * 否则「/ 不可写」在非 root 下会白送通过，检查就变成了自欺。
 *
 * 用法：
 *   node scripts/sandbox-image-check.ts                 # 构建镜像 + 全部检查
 *   node scripts/sandbox-image-check.ts --skip-build    # 用本地已有镜像（CI 里已构建过时）
 *   node scripts/sandbox-image-check.ts --keep          # 失败时留下容器和卷，方便进去看
 *   SANDBOX_IMAGE=my/sandbox:dev node scripts/...       # 换镜像名（默认见 IMAGE）
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SseClient, TERMINAL_EVENTS, runCommand } from "../packages/sandbox-agent/test/harness.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = process.env.SANDBOX_IMAGE ?? "reuben-cloud/sandbox-base:dev";
const skipBuild = process.argv.includes("--skip-build");
const keep = process.argv.includes("--keep");

/** 每沙箱一个 token，和 provider 一样现场生成——检查脚本不引入任何固定凭据。 */
const token = randomBytes(32).toString("base64url");
/** 名字带 pid + 随机段：并行跑两个检查、或上一次没清干净时都不会互相踩。 */
const suffix = `${process.pid}-${randomBytes(3).toString("hex")}`;
const containerName = `rc-image-check-${suffix}`;
const volumeName = `rc-image-check-ws-${suffix}`;

// ---------------------------------------------------------------- 基础工具

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一条宿主命令并收集输出。生产代码不走这里——这纯粹是检查脚本的脚手架。 */
async function run(argv: string[]): Promise<CommandResult> {
  const result = await runCommand(argv, { cwd: repoRoot });
  return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
}

/** 跑一条 docker 子命令（argv 直传，不经过 shell）。 */
function docker(args: string[]): Promise<CommandResult> {
  return run(["docker", ...args]);
}

/** docker 命令必须成功，否则抛——命令失败时 stdout 通常没有意义。 */
async function dockerOrThrow(args: string[]): Promise<string> {
  const result = await docker(args);
  if (result.code !== 0) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} 失败（exit ${result.code}）：${result.stderr.trim()}`);
  }
  return result.stdout;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 一次构建的产出：完整输出 + 镜像 config digest。 */
interface BuildOutcome {
  output: string;
  /**
   * `#10 exporting config sha256:…` 里的那个 digest。
   *
   * 为什么不用 `docker image inspect .Id` 判"两次构建是不是同一个镜像"：containerd
   * 镜像存储下 `.Id` 是 **manifest list** 的 digest，而 BuildKit 每构建一次就重写一次
   * 带时间戳的 attestation manifest，于是它必然每次都变（实测如此）。config digest
   * 覆盖的才是真正的镜像内容，全缓存命中时它逐字节不变。
   */
  configDigest: string | null;
}

/** 构建镜像。缓存检查要靠输出里的 CACHED 与 exporting config。 */
async function buildImage(): Promise<BuildOutcome> {
  const result = await run([
    "docker",
    "build",
    "--progress=plain",
    "-f",
    "images/sandbox/Dockerfile",
    "-t",
    IMAGE,
    ".",
  ]);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    throw new Error(`docker build 失败（exit ${result.code}）：\n${tail(output, 40)}`);
  }
  const digest = /exporting config (sha256:[0-9a-f]+)/.exec(output)?.[1] ?? null;
  return { output, configDigest: digest };
}

/** 截取输出的最后 n 行（构建失败时最有用的那一段）。 */
function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

// ---------------------------------------------------------------- 检查框架

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

/** 跑一条检查：抛异常 = 失败，返回值 = 通过时展示的细节。 */
async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}${detail === "" ? "" : ` — ${detail}`}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name} — ${detail}`);
  }
}

// ---------------------------------------------------------------- agent HTTP / SSE

interface AgentEvent {
  event: string;
  data: any;
  /** 收到这一帧的本地时刻，用来判断"输出是在进程结束前到达的"。 */
  at: number;
}

interface ExecOutcome {
  events: AgentEvent[];
  terminal: AgentEvent;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 对容器里的 agent 跑一条命令：POST /exec → 连 SSE → 读到终态。
 * 和 harness.ts 的 runExec 是同一套流程，区别是这里面对的是真容器（HTTP 出网卡）。
 */
async function agentExec(baseUrl: string, cmd: string[]): Promise<ExecOutcome> {
  // 上一条执行刚发完终态事件、但 BUSY 槽可能还没还回来（释放发生在日志落盘之后）。
  // CP 遇到 409 也是「等一会儿再来」，这里照做，免得检查被这种毫秒级竞态搞成偶发失败。
  let accepted: Response;
  const busyDeadline = Date.now() + 5_000;
  for (;;) {
    accepted = await fetch(`${baseUrl}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ cmd, timeoutMs: 30_000 }),
    });
    if (accepted.status !== 409) break;
    // 注意：响应体只能读一次，所以断言消息里**不能**无条件调 text()——
    // 模板字符串会先求值，那样 body 就被吃掉了，后面 json() 必炸。
    if (Date.now() > busyDeadline) {
      throw new Error(`POST /exec 一直 409：${await accepted.text()}`);
    }
    await delay(100);
  }
  if (accepted.status !== 202) {
    throw new Error(`POST /exec 得到 ${accepted.status}：${await accepted.text()}`);
  }
  const { execution_id: executionId } = (await accepted.json()) as { execution_id: string };

  // 连 SSE。重放语义保证"连上之前就发出的事件"不会丢，所以这里不需要抢时机。
  const client = await SseClient.connect(`${baseUrl}/exec/${executionId}/events`, token);
  const events: AgentEvent[] = [];
  try {
    for (;;) {
      const event = await client.next(30_000);
      events.push({ event: event.event, data: event.data, at: Date.now() });
      if (TERMINAL_EVENTS.has(event.event)) break;
    }
  } finally {
    client.close();
  }

  const terminal = events.at(-1)!;
  const collect = (stream: "stdout" | "stderr"): string =>
    events
      .filter((event) => event.event === stream)
      .map((event) => String(event.data.chunk))
      .join("");

  return {
    events,
    terminal,
    exitCode: (terminal.data.exit_code as number | null) ?? null,
    stdout: collect("stdout"),
    stderr: collect("stderr"),
  };
}

// ---------------------------------------------------------------- 容器生命周期

async function startHardenedContainer(): Promise<{ baseUrl: string }> {
  await dockerOrThrow([
    "run",
    "-d",
    "--name",
    containerName,
    // —— 以下是 Phase 5 的 HostConfig 在 CLI 上的等价形式，刻意逐条对齐 ——
    "--init", // tini 回收僵尸；镜像里不装它
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--tmpfs",
    // 带 `exec`：Docker 对 tmpfs 的缺省里含 noexec，不显式写 exec 就会被加上，
    // 而 npm postinstall / node-gyp / python console script 都要从 /tmp 执行文件（§F.1）。
    "/tmp:rw,exec,nosuid,size=512m,mode=1777",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--cpus",
    "1",
    "--pids-limit",
    "2048",
    "-v",
    `${volumeName}:/workspace`,
    "-e",
    `SANDBOX_AGENT_TOKEN=${token}`,
    // 生产在 Linux 上用的是容器 IP（见 Phase 5）；这里发布到 127.0.0.1 的随机端口
    // 只是为了从宿主访问，绝不发布到 0.0.0.0。
    "-p",
    "127.0.0.1::8080",
    IMAGE,
  ]);

  const portOutput = await dockerOrThrow(["port", containerName, "8080/tcp"]);
  const match = /127\.0\.0\.1:(\d+)/.exec(portOutput);
  assert(match !== null, `没从 docker port 的输出里解析出主机端口：${portOutput.trim()}`);

  const baseUrl = `http://127.0.0.1:${match[1]}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return { baseUrl };
    } catch {
      /* 还没起来，下一轮再试 */
    }
    if (Date.now() > deadline) {
      const logs = await docker(["logs", containerName]);
      throw new Error(`/health 在 20s 内没通过。容器日志：\n${logs.stdout}\n${logs.stderr}`);
    }
    await delay(250);
  }
}

async function cleanup(volumeCreated: boolean): Promise<void> {
  if (keep) {
    console.log(`\n（--keep）容器 ${containerName}、卷 ${volumeName} 保留着，自己进去看。`);
    return;
  }
  await docker(["rm", "-f", containerName]);
  if (!volumeCreated) return;
  const removed = await docker(["volume", "rm", volumeName]);
  if (removed.code !== 0) {
    // 卷删不掉通常是"还有容器在用"——记警告而不是失败，留给下一次清理。
    console.log(`  ! 卷 ${volumeName} 没删掉：${removed.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<number> {
  console.log(`=== Phase 4 · 沙箱镜像检查 ===\n镜像：${IMAGE}\n`);

  // 前置：没有 Docker 就不用往下走了（也避免把 ENOENT 报成某个检查失败）。
  const dockerVersion = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (dockerVersion.code !== 0) {
    console.error(`需要可用的 Docker daemon：${dockerVersion.stderr.trim()}`);
    return 1;
  }
  console.log(`Docker ${dockerVersion.stdout.trim()}\n`);

  // 1) 构建。这是整个脚本的前置条件，失败就直接结束——后面每条检查都依赖它。
  //    留下的 outcome 当"基准构建"，缓存检查拿它的 config digest 跟第二次比。
  let baseline: BuildOutcome | null = null;
  if (skipBuild) {
    console.log("--skip-build：跳过构建，直接用本地镜像\n");
  } else {
    console.log("构建镜像（首次要装 apt 包，几分钟；之后走层缓存）…");
    baseline = await buildImage();
    console.log(`构建完成（${baseline.output.split("\n").length} 行输出）\n`);
  }
  let started = false;
  let volumeCreated = false;
  try {
    // 2) 静态检查：不改容器状态，失败信息最直接。
    await check("镜像里没有默认 token（Config.Env 不含 SANDBOX_AGENT_TOKEN）", async () => {
      const env = JSON.parse(
        await dockerOrThrow(["image", "inspect", "--format", "{{json .Config.Env}}", IMAGE]),
      ) as string[];
      const found = env.find((item) => item.startsWith("SANDBOX_AGENT_TOKEN="));
      assert(found === undefined, `Config.Env 里有 ${found}`);
      return `${env.length} 个环境变量，无凭据`;
    });

    await check("非 root：镜像默认用户 1000:1000，运行时 id -u = 1000", async () => {
      const user = (await dockerOrThrow(["image", "inspect", "--format", "{{.Config.User}}", IMAGE])).trim();
      assert(user === "1000:1000", `Config.User = ${JSON.stringify(user)}`);
      // 静态配置与运行时都要看：只查 Config.User 抓不到"用户被 base 镜像覆盖"这类事。
      const result = await docker(["run", "--rm", IMAGE, "id", "-u"]);
      assert(result.code === 0, `docker run id -u 失败（exit ${result.code}）：${result.stderr.trim()}`);
      assert(result.stdout.trim() === "1000", `运行时 id -u = ${result.stdout.trim()}`);
      return "1000:1000 / 1000";
    });

    await check("镜像大小（只记录，不设指标）", async () => {
      const size = Number((await dockerOrThrow(["image", "inspect", "--format", "{{.Size}}", IMAGE])).trim());
      assert(Number.isFinite(size) && size > 0, `Size = ${size}`);
      return `${(size / 1024 / 1024).toFixed(0)} MiB`;
    });

    await check("无 SANDBOX_AGENT_TOKEN → 非 0 退出，且日志里有说明", async () => {
      const result = await docker(["run", "--rm", IMAGE]);
      const output = `${result.stdout}\n${result.stderr}`;
      assert(result.code !== 0, "居然以 0 退出了——说明镜像里有默认 token");
      assert(
        output.includes("SANDBOX_AGENT_TOKEN is required"),
        `日志里没有拒绝启动的说明：${tail(output, 5)}`,
      );
      return `exit ${result.code}`;
    });

    await check("重复构建命中层缓存（apt 层不重编，config digest 不变）", async () => {
      // --skip-build 时手里没有基准构建的输出，就现构一次当基准——它同样是"再来一遍"，
      // 断言的意义不变（第二次必须全部命中缓存）。
      const first = baseline ?? (await buildImage());
      const rebuilt = await buildImage();
      // `#6` 是那条 RUN apt-get 的步骤号。它 CACHED = 最贵的那层复用了。
      assert(rebuilt.output.includes("#6 CACHED"), "最贵的 apt 层没有命中缓存（步骤号可能变了）");
      assert(!/Setting up |Get:\d/.test(rebuilt.output), "apt-get 真的跑了——不是缓存命中");
      assert(
        first.configDigest !== null && rebuilt.configDigest === first.configDigest,
        `镜像 config digest 变了：${first.configDigest} → ${rebuilt.configDigest}`,
      );
      return `${rebuilt.configDigest.slice(0, 19)}…`;
    });

    // 3) 起一个加固过的容器，后面全是运行时检查。
    await dockerOrThrow(["volume", "create", volumeName]);
    volumeCreated = true;

    // 命名卷属主是 Appendix B 排第一的坑：Docker 用镜像里挂载点的属主初始化新卷，
    // 少了 Dockerfile 里的 chown，卷就是 root:root，uid 1000 什么都写不进去。
    await check("命名卷初始化后 /workspace 属主是 1000:1000", async () => {
      const owner = await dockerOrThrow([
        "run",
        "--rm",
        "-v",
        `${volumeName}:/workspace`,
        IMAGE,
        "stat",
        "-c",
        "%u:%g",
        "/workspace",
      ]);
      assert(owner.trim() === "1000:1000", `stat = ${owner.trim()}`);
      return owner.trim();
    });

    console.log("\n  起容器（--read-only / --cap-drop ALL / --tmpfs /tmp / --user 1000:1000 / --init）…");
    const { baseUrl } = await startHardenedContainer();
    started = true;
    console.log(`  agent 就绪：${baseUrl}\n`);

    await check("鉴权：不带 token → 401；带 token → 200 ready", async () => {
      const unauthorized = await fetch(`${baseUrl}/health`);
      assert(unauthorized.status === 401, `不带 token 得到 ${unauthorized.status}`);
      const authorized = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert(authorized.ok, `带 token 得到 ${authorized.status}`);
      const body = (await authorized.json()) as { status: string; version: string };
      assert(body.status === "ready", `status = ${body.status}`);
      return `v${body.version}`;
    });

    await check("node / git / python3 都在", async () => {
      const result = await agentExec(baseUrl, ["bash", "-c", "node -v && git --version && python3 -V"]);
      assert(
        result.terminal.event === "completed" && result.exitCode === 0,
        `exit=${result.exitCode} stderr=${result.stderr.trim()}`,
      );
      const versions = result.stdout.trim().split("\n");
      assert(/^v2[4-9]\./.test(versions[0] ?? ""), `node 版本可疑：${versions[0]}`);
      assert(/^git version /.test(versions[1] ?? ""), `git 版本可疑：${versions[1]}`);
      assert(/^Python 3\./.test(versions[2] ?? ""), `python3 版本可疑：${versions[2]}`);
      return versions.join(" / ");
    });

    await check("python3 中文输出即时可见（PYTHONUNBUFFERED + C.UTF-8）", async () => {
      // 故意不 flush：能不能及时到达完全取决于 PYTHONUNBUFFERED 与 agent 的合并器。
      const result = await agentExec(baseUrl, [
        "python3",
        "-c",
        "import time;print('中文');time.sleep(0.6)",
      ]);
      const chunk = result.events.find(
        (event) => event.event === "stdout" && String(event.data.chunk).includes("中文"),
      );
      assert(
        chunk !== undefined,
        `没收到中文输出：stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
      );
      assert(!result.stderr.includes("UnicodeEncodeError"), `stderr 里有编码错误：${result.stderr.trim()}`);
      const leadMs = result.terminal.at - chunk.at;
      assert(leadMs >= 300, `输出只比进程结束早 ${leadMs}ms —— 大概率卡在管道缓冲里`);
      return `中文在终态前 ${leadMs}ms 到达`;
    });

    await check("/workspace 可写（命名卷）", async () => {
      const result = await agentExec(baseUrl, [
        "bash",
        "-c",
        "printf ok > /workspace/.image-check && cat /workspace/.image-check",
      ]);
      assert(
        result.exitCode === 0 && result.stdout.trim() === "ok",
        `exit=${result.exitCode} stdout=${JSON.stringify(result.stdout)} stderr=${result.stderr.trim()}`,
      );
      return "写入并读回 /workspace/.image-check";
    });

    await check("只读根：/ 不可写，且错误是 EROFS（不是权限不足）", async () => {
      const result = await agentExec(baseUrl, ["touch", "/nope"]);
      assert(result.exitCode !== 0, "居然写进去了——说明容器没有 --read-only");
      assert(
        /read-only file system/i.test(result.stderr),
        `stderr 不是 EROFS：${result.stderr.trim()}`,
      );
      return `touch /nope → exit ${result.exitCode}`;
    });
  } finally {
    await cleanup(volumeCreated);
  }

  // 4) 汇总。失败时把每条失败原因再打一遍，免得人往上翻日志。
  const failed = results.filter((result) => !result.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log("\n失败：");
    for (const result of failed) console.log(`  ✗ ${result.name} — ${result.detail}`);
    return 1;
  }
  console.log("Phase 4 验收通过。");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`\n检查脚本自己挂了：${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  },
);
