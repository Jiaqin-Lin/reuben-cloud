/**
 * Phase 7 · 业务链路（`--tag=flow`）。
 *
 * 对应 spec Phase 7 §3 那七步，也是 §J「功能闭环」前六条在沙箱侧的落点：
 *   1. create → health                         （§J 闭环的起点）
 *   2. tar 灌入 → `tar xzf` → `git status` 干净  （§J 闭环 1 的沙箱侧；CP 侧的 clone 是 Phase 9）
 *   3. `npm ci && npm test` → SSE + 退出码      （§J 闭环 2）
 *   4. 改一个文件 → `GET /diff` → patch 非空     （§J 闭环 5；apply 是 Phase 9 的 CP 侧）
 *   5. `GET /archive` → 含被忽略的构建产物        （§J 闭环 6、§J.6）
 *   6. destroy → 容器和卷都没了                 （§J 闭环 7 的后半）
 *
 * **两步暂时做不到，标在这里而不是假装做了**：
 *  - 第 2 步的"仓库是 CP clone 来的"：Phase 9 才有 `repo/clone.ts`。现在用 fixture 仓库
 *    现造一个带 `.git` 的 tar（harness 的 buildFixtureRepo），形态与 Phase 9 灌进去的一致。
 *  - 第 5 步的"落对象存储"：对象存储是 CP 侧的事（Phase 10 已落地，但在
 *    `packages/control-plane/test/integration/artifacts.integration.test.ts` 里验——本脚本
 *    按设计不经过 CP 业务层）。这里断言的是归档流本身能解出被 `.gitignore` 排除的构建产物，
 *    那是"归档有资格当 patch 的兜底"的唯一理由。
 *  - 第 7 步的"三张表状态正确"：Phase 8 已落地，同样在 CP 侧的集成测试里验。现在这一组
 *    断言的是容器与卷真的没了。
 *
 * 这一组在 macOS 上也跑：darwin 的端口转发链路（宿主 → 转发容器 → 沙箱 agent）是本地开发
 * 最容易坏的一条，而 flow 是唯一一条从 create 走到 destroy 的端到端路径。
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  SmokeSandbox,
  assertNoLeftovers,
  buildFixtureRepo,
  execOk,
  smokeGroup,
  tarList,
} from "../src/harness.ts";
import type { FixtureRepo } from "../src/harness.ts";
import { containerExists, volumeExists } from "../../control-plane/test/support.ts";
import { sandboxContainerName, workspaceVolumeName } from "../../control-plane/src/provider/types.ts";

/** 改完之后 `src/greet.js` 的新内容：多一个感叹号，diff 里就该多一行、少一行。 */
const GREET_AFTER = 'module.exports = (name) => `hi ${name}!`;\n';

smokeGroup("业务链路", { tags: ["flow"] }, () => {
  let box: SmokeSandbox;
  let fixture: FixtureRepo;

  before(async () => {
    fixture = await buildFixtureRepo();
    box = await SmokeSandbox.create({ label: "flow" });
  });

  after(async () => {
    await box?.destroy();
  });

  test("F1 · create → health：容器名/卷名符合契约，agent 报 ready 且空闲", async () => {
    assert.equal(box.handle.containerName, sandboxContainerName(box.sandboxId));
    assert.equal(box.handle.volumeName, workspaceVolumeName(box.sandboxId));

    const health = await box.health();
    assert.equal(health.status, "ready", `agent 不是 ready：${health.status}`);
    assert.equal(health.activeExecution, null, "刚建出来的沙箱不该有执行在跑");
    assert.equal(health.version, "0.0.1", `agent 版本不对：${String(health.version)}`);
    assert.equal(health.endpoint, box.handle.endpoint, "provider 报的 endpoint 与 health 时用的不一致");
  });

  test("F2 · tar 灌入 → 解包 → git status 干净（仓库带着 .git 一起进去）", async () => {
    const uploaded = await box.putFile("/workspace/repo.tar.gz", fixture.tarball);
    assert.equal(uploaded.size, fixture.tarball.length, "上传的字节数与 tar 不一致");

    // 不要 `-C`：cwd 已经是 /workspace（命令的默认 cwd 就是 workspace 根）。
    await execOk(box, ["tar", "xzf", "/workspace/repo.tar.gz"]);
    await execOk(box, ["rm", "-f", "/workspace/repo.tar.gz"]);

    // 仓库真的到了、HEAD 就是 fixture 那个 commit。
    const head = await execOk(box, ["git", "-C", "/workspace", "rev-parse", "HEAD"]);
    assert.equal(head.stdout.trim(), fixture.baseSha, "灌进去的仓库 HEAD 与 fixture 不符");

    // 工作区干净：`.git` 没有被 tar/解包过程弄脏（否则后面 diff 的 base 就没有意义）。
    const status = await execOk(box, ["git", "-C", "/workspace", "status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "", `解包之后工作区不干净：\n${status.stdout}`);

    // §J 红线：沙箱里不许有 GitHub 凭据。fixture 本来就没有 remote，这一条现在的牙齿来自
    // "我们不夹带凭据"；等 Phase 9 的 CP clone 落地后，同一条断言会第一次真正咬人。
    const gitConfig = await execOk(box, ["cat", "/workspace/.git/config"]);
    assert.doesNotMatch(
      gitConfig.stdout,
      /x-access-token|gh[pousr]_|github_pat_|@github\.com/i,
      `仓库配置里出现了 GitHub 凭据：\n${gitConfig.stdout}`,
    );
  });

  test("F3 · npm ci && npm test：SSE 收到输出，退出码 0", async () => {
    const result = await box.exec(["bash", "-c", "npm ci && npm test"], {
      timeoutMs: 120_000,
      env: {
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_AUDIT: "false",
      },
    });
    assert.equal(result.terminal.event, "completed", `终态不是 completed：${result.terminal.event}`);
    assert.equal(result.exitCode, 0, `npm ci && npm test 失败：${result.stderr.slice(0, 2_000)}`);
    assert.match(result.stdout, /fixture: 1 test passed/, `没看到测试的输出：${result.stdout.slice(0, 1_000)}`);
    // 零依赖的 fixture 下 `npm ci` 不会建 node_modules（实测：直接报 up to date），
    // 所以这里不拿目录存在与否当断言——真正该断的是"它没有污染 diff"，那在 F4 里。
  });

  test("F4 · 改一个文件 → /diff 拿到非空 patch，且这份 patch 能反向 apply 回工作区", async () => {
    await box.putFile("/workspace/src/greet.js", GREET_AFTER);

    const diff = await box.diff(`?base=${encodeURIComponent(fixture.baseSha)}`);
    assert.equal(diff.base, fixture.baseSha, "diff 回的 base 与请求的不一致");
    assert.equal(diff.truncated, false, "这么小的 patch 不该被外置");
    assert.ok(diff.patch !== null && diff.patch.length > 0, "patch 是空的");

    const changed = diff.files.find((file) => file.path === "src/greet.js");
    assert.ok(changed !== undefined, `diff 的文件列表里没有 src/greet.js：${JSON.stringify(diff.files)}`);
    assert.equal(changed.status, "modified", `状态不是 modified：${changed.status}`);
    assert.equal(changed.additions, 1, `新增行数不是 1：${changed.additions}`);
    assert.equal(changed.deletions, 1, `删除行数不是 1：${changed.deletions}`);
    // node_modules 是 .gitignore 里的：`git add -A -N` 不会把被忽略的东西加进来。
    assert.ok(
      !diff.files.some((file) => file.path.startsWith("node_modules/")),
      `diff 里出现了 node_modules：${diff.files.map((file) => file.path).join(",")}`,
    );

    // patch 的内容真的描述了这次改动。
    assert.ok(diff.patch.includes("hi ${name}!"), `patch 里没有新内容：\n${diff.patch.slice(0, 500)}`);

    // apply 的正经验证在 Phase 9（CP 侧 `git apply --binary`）。这里做得到的是**反向**校验：
    // 把 patch 放进沙箱，`git apply --check --reverse` —— 它要求 patch 与工作区**逐字节相符**
    // 才能通过。这比"patch 非空"强得多：一个方向搞错或者少一行的 patch 会立刻挂。
    await box.putFile("/workspace/rc-smoke.patch", diff.patch);
    await execOk(box, [
      "git",
      "-C",
      "/workspace",
      "apply",
      "--check",
      "--reverse",
      "--binary",
      "/workspace/rc-smoke.patch",
    ]);
    await execOk(box, ["rm", "-f", "/workspace/rc-smoke.patch"]);
  });

  test("F5 · /archive 是合法的 tar.gz，且包含被 .gitignore 排除的构建产物", async () => {
    // 造一个"构建产物"：`.gitignore` 里有 dist/，所以它**不会**出现在 diff 里，
    // 但必须出现在归档里（§J.6——这正是归档作为 patch 兜底方案的价值）。
    await execOk(box, ["bash", "-c", "mkdir -p /workspace/dist && printf 'built' > /workspace/dist/bundle.js"]);

    const response = await box.archive();
    const archive = Buffer.from(await response.arrayBuffer());
    const entries = await tarList(archive);

    assert.ok(
      entries.includes("./dist/bundle.js"),
      `归档里没有被忽略的构建产物（§J.6）：\n${entries.slice(0, 40).join("\n")}`,
    );
    assert.ok(entries.includes("./src/greet.js"), "归档里没有源文件");
    assert.ok(entries.includes("./.git/config"), "归档里没有 .git（那就不是「整仓」归档）");
    assert.ok(entries.includes("./.gitignore"), "归档里没有 .gitignore");
  });

  test("F6 · destroy → 容器和卷都没了，health 报 not_found", async () => {
    const sandboxId = box.sandboxId;
    await box.destroy();

    assert.equal(await containerExists(box.handle.containerName), false, "容器还在");
    assert.equal(await volumeExists(box.handle.volumeName), false, "卷还在");
    await assertNoLeftovers(sandboxId, "F6");

    await assert.rejects(
      () => box.provider.health(sandboxId),
      (error: unknown) => (error as { reason?: string }).reason === "not_found",
      "销毁之后 provider.health 应该抛 not_found",
    );

    // 幂等：对账会重复调 destroy（Phase 8），现在就要能重复调。
    await box.destroy();
  });
});
