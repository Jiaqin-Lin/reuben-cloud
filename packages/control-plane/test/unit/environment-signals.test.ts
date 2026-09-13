/**
 * Phase 5 · 仓库信号采集（不需要 Docker、不需要 PG、不需要网络）。
 *
 * 对应 spec P5 测试要点 2、5（采集侧）、6、8。它守的是三类回归：
 *  ① **优先级与归一化**：锁文件优先级、版本来源优先级、确定性（同一个仓库两次采集字节相同）
 *     ——缓存键就建在归一化后的信号上，漂一个字节就永远命不中缓存（设计文档 §C.5）；
 *  ② **不执行仓库里的东西**：采集只读文本。Makefile / package.json 里写着 `touch …`
 *     也不会被执行（spec 测试要点 8）；
 *  ③ **不抛**：目录不存在、文件是二进制、JSON 有注释——都只影响那一项信号。
 *
 * 【它不替代什么】真仓库的行为（几万个文件、真正的 monorepo）由集成测试与真实使用覆盖；
 * 这里用临时目录造出每一种"信号恰好长这样"的最小形态。
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import {
  collectSignals,
  detectMonorepo,
  normalizeSignals,
  normalizeVersion,
  readBuildEntrypoints,
  readCiHints,
  readLanguages,
  readPackageManagers,
  readRuntimeVersions,
  readServices,
  scanRepo,
} from "../../src/environment/signals.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/repos/", import.meta.url));

/** 临时目录登记表：用例失败（抛异常）时也要删掉，否则 /tmp 会长出一堆垃圾。 */
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 造一个临时"仓库"：key 是相对路径，末尾带 `/` 的 key 是空目录。 */
async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-signals-"));
  tempDirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

describe("scanRepo", () => {
  test("跳过依赖与产物目录，返回排序后的相对路径", async () => {
    const dir = await makeRepo({
      "package.json": "{}",
      "src/index.ts": "export {}",
      "node_modules/left-pad/index.js": "module.exports = 1",
      ".git/config": "[core]",
      "dist/bundle.js": "x",
      "vendor/lib.go": "package lib",
    });
    const scan = await scanRepo(dir);
    assert.deepEqual(scan.files, ["package.json", "src/index.ts"]);
    assert.deepEqual(scan.dirs, ["src"]);
  });

  test("目录不存在不抛（返回空清单）", async () => {
    const scan = await scanRepo(path.join(os.tmpdir(), "rc-signals-does-not-exist"));
    assert.deepEqual(scan.files, []);
  });

  test("超过 maxFiles 会截断并标记（确定性：截断位置与文件系统顺序无关）", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) files[`f${index}.txt`] = "x";
    const dir = await makeRepo(files);
    const scan = await scanRepo(dir, { maxFiles: 4 });
    assert.equal(scan.files.length, 4);
    assert.equal(scan.truncated, true);
    assert.deepEqual(scan.files, ["f0.txt", "f1.txt", "f2.txt", "f3.txt"]);
  });
});

describe("包管理器", () => {
  test("锁文件优先级：package-lock 压过 yarn.lock，并在 ignored 里说明", async () => {
    const dir = await makeRepo({ "package.json": "{}", "package-lock.json": "{}", "yarn.lock": "" });
    const result = await readPackageManagers(await scanRepo(dir));
    assert.deepEqual(result.packageManagers, ["npm"]);
    assert.deepEqual(result.lockfiles, ["package-lock.json", "yarn.lock"]);
    assert.equal(result.ignored.length, 1);
    assert.equal(result.ignored[0]!.source, "yarn.lock");
    assert.match(result.ignored[0]!.reason, /package-lock\.json/);
  });

  test("pnpm-lock 压过 package-lock（迁移残留的常见形态）", async () => {
    const dir = await makeRepo({ "pnpm-lock.yaml": "", "package-lock.json": "{}" });
    const result = await readPackageManagers(await scanRepo(dir));
    assert.deepEqual(result.packageManagers, ["pnpm"]);
  });

  test("生态顺序固定：JS → Python → Rust → Go，与语言统计无关", async () => {
    const dir = await makeRepo({ "package-lock.json": "{}", "uv.lock": "", "Cargo.lock": "", "go.sum": "" });
    const result = await readPackageManagers(await scanRepo(dir));
    assert.deepEqual(result.packageManagers, ["npm", "uv", "cargo", "go"]);
  });

  test("子目录里的锁文件被看见但不用（M2 一个仓库一个环境）", async () => {
    const dir = await makeRepo({ "package.json": "{}", "packages/web/yarn.lock": "" });
    const result = await readPackageManagers(await scanRepo(dir));
    assert.deepEqual(result.packageManagers, ["npm"]);
    assert.ok(result.ignored.some((item) => item.source === "packages/web/yarn.lock"));
  });

  test("没有锁文件时按清单文件给结论，并记一条 ignored", async () => {
    const dir = await makeRepo({ "Cargo.toml": "[package]\nname = \"x\"\n" });
    const result = await readPackageManagers(await scanRepo(dir));
    assert.deepEqual(result.packageManagers, ["cargo"]);
    assert.deepEqual(result.lockfiles, []);
    assert.match(result.ignored[0]!.reason, /没有锁文件/);
  });

  test("pyproject 带 [tool.poetry] → poetry；否则算 pip", async () => {
    const poetry = await makeRepo({ "pyproject.toml": "[tool.poetry]\nname = \"x\"\n" });
    assert.deepEqual((await readPackageManagers(await scanRepo(poetry))).packageManagers, ["poetry"]);
    const pep621 = await makeRepo({ "pyproject.toml": "[project]\nname = \"x\"\n" });
    assert.deepEqual((await readPackageManagers(await scanRepo(pep621))).packageManagers, ["pip"]);
  });
});

describe("运行时版本", () => {
  test("版本文件的优先级高于 engines / requires-python", async () => {
    const dir = await makeRepo({
      ".nvmrc": "v20.11.0\n",
      "package.json": JSON.stringify({ engines: { node: ">=18" } }),
      "pyproject.toml": '[project]\nname = "x"\nrequires-python = ">=3.11,<4"\n',
    });
    const result = await readRuntimeVersions(await scanRepo(dir));
    assert.deepEqual(result.runtimeVersions, { node: "20.11.0", python: "3.11" });
    const nodeConflict = result.ignored.find((item) => item.field === "node");
    assert.ok(nodeConflict !== undefined, "engines 被跳过时要留一条 ignored");
    assert.match(nodeConflict.reason, /\.nvmrc/);
  });

  test("go.mod / rust-toolchain.toml / .tool-versions", async () => {
    const dir = await makeRepo({
      "go.mod": "module example.com/x\n\ngo 1.22.3\n",
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.83.0"\n',
      ".tool-versions": "nodejs 22.5.1\npython 3.12.4\n",
    });
    const result = await readRuntimeVersions(await scanRepo(dir));
    assert.deepEqual(result.runtimeVersions, { node: "22.5.1", python: "3.12.4", go: "1.22.3", rust: "1.83.0" });
  });

  test("滚动标签（lts/*）不是版本：记一条 ignored，而不是编一个数", async () => {
    const dir = await makeRepo({ ".nvmrc": "lts/*\n" });
    const result = await readRuntimeVersions(await scanRepo(dir));
    assert.deepEqual(result.runtimeVersions, {});
    assert.match(result.ignored[0]!.reason, /不是具体版本/);
  });

  test("normalizeVersion 的取值规则", () => {
    assert.equal(normalizeVersion("v20.11.0"), "20.11.0");
    assert.equal(normalizeVersion(">=20.11.0 <21"), "20.11.0");
    assert.equal(normalizeVersion("^3.11"), "3.11");
    assert.equal(normalizeVersion("3.11.x"), "3.11");
    assert.equal(normalizeVersion("lts/iron"), null);
    assert.equal(normalizeVersion("  "), null);
  });
});

describe("语言、构建入口、CI、服务", () => {
  test("语言按文件数 + 入口权重排序", async () => {
    const dir = await makeRepo({
      "pyproject.toml": "[project]\nname='x'\n",
      "src/a.py": "",
      "src/b.py": "",
      "src/c.py": "",
      "tool.js": "x",
    });
    assert.deepEqual(readLanguages(await scanRepo(dir)), ["python", "javascript"]);
  });

  test("构建入口：Makefile 目标与 npm scripts 分开给", async () => {
    const dir = await makeRepo({
      "Makefile": ".PHONY: build\nVERSION := 1\n\nbuild:\n\t@echo build\n\ntest:\n\t@echo test\n",
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }),
    });
    const result = await readBuildEntrypoints(await scanRepo(dir));
    assert.deepEqual(result.makeTargets, ["build", "test"]);
    assert.deepEqual(result.scripts, ["build", "test"]);
  });

  test("CI：取内联 run 行与版本号；块状 run 不解析", async () => {
    const dir = await makeRepo({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - uses: actions/setup-node@v4",
        "        with:",
        '          node-version: "20"',
        "      - run: npm ci",
        "      - run: npm test",
        "      - run: |",
        "          npm run build",
        "          npm run lint",
      ].join("\n"),
    });
    const hints = await readCiHints(await scanRepo(dir));
    assert.deepEqual(hints.commands, ["npm ci", "npm test"]);
    assert.equal(hints.versions["node"], "20");
  });

  test("compose 的服务按 canonical 名收敛（db → postgres，cache → redis）", async () => {
    const dir = await makeRepo({
      "compose.yaml": [
        "services:",
        "  db:",
        "    image: postgres:16-alpine",
        "  cache:",
        "    image: redis:7-alpine",
        "  mine:",
        "    image: ghcr.io/acme/weird-thing:1",
        "volumes:",
        "  pgdata:",
      ].join("\n"),
    });
    const result = await readServices(await scanRepo(dir));
    assert.deepEqual(result.services, ["postgres", "redis", "weird-thing"]);
  });

  test("monorepo：pnpm-workspace.yaml / workspaces / 两个包目录 / Cargo workspace", async () => {
    assert.equal(await detectMonorepo(await scanRepo(await makeRepo({ "pnpm-workspace.yaml": "packages:\n  - x" }))), true);
    assert.equal(
      await detectMonorepo(
        await scanRepo(await makeRepo({ "package.json": JSON.stringify({ workspaces: ["packages/*"] }) })),
      ),
      true,
    );
    assert.equal(
      await detectMonorepo(
        await scanRepo(await makeRepo({ "packages/a/package.json": "{}", "packages/b/package.json": "{}" })),
      ),
      true,
    );
    assert.equal(await detectMonorepo(await scanRepo(await makeRepo({ "Cargo.toml": "[workspace]\nmembers = []" }))), true);
    assert.equal(await detectMonorepo(await scanRepo(await makeRepo({ "Cargo.toml": "[package]\nname='x'" }))), false);
  });
});

describe("collectSignals", () => {
  test("三个 fixture 的信号符合各自的特征", async () => {
    const nodeTs = await collectSignals(path.join(FIXTURES, "node-ts-basic"));
    assert.deepEqual(nodeTs.languages, ["javascript", "typescript"]);
    assert.deepEqual(nodeTs.packageManagers, ["npm"]);
    assert.deepEqual(nodeTs.runtimeVersions, { node: "20" });
    assert.deepEqual(nodeTs.makeTargets, ["build", "clean", "test"]);
    assert.equal(nodeTs.monorepo, false);
    assert.equal(nodeTs.hasDockerfile, false);

    const python = await collectSignals(path.join(FIXTURES, "python-poetry"));
    assert.deepEqual(python.packageManagers, ["poetry"]);
    assert.deepEqual(python.runtimeVersions, { python: "3.11" });
    assert.equal(python.hasDockerfile, true);
    assert.ok(python.ciCommands.includes("poetry install --no-interaction"), JSON.stringify(python.ciCommands));

    const mono = await collectSignals(path.join(FIXTURES, "monorepo-devcontainer"));
    assert.deepEqual(mono.packageManagers, ["pnpm"]);
    assert.deepEqual(mono.services, ["postgres", "redis"]);
    assert.equal(mono.monorepo, true);
    assert.equal(mono.hasDevcontainer, true);
  });

  test("确定性：同一个仓库两次采集序列化字节相同（缓存键的前提）", async () => {
    const first = await collectSignals(path.join(FIXTURES, "monorepo-devcontainer"));
    const second = await collectSignals(path.join(FIXTURES, "monorepo-devcontainer"));
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    // 归一化是幂等的：再归一化一次不改任何东西。
    assert.equal(JSON.stringify(normalizeSignals(first)), JSON.stringify(first));
  });

  test("采集不执行仓库里的任何东西（spec 测试要点 8）", async () => {
    // 【为什么这个 fixture 是现造的，而不是 commit 进 test/fixtures/】附录 D 的 fixture 清单只有
    // 三个仓库，而一个"配方会写文件"的 Makefile 留在仓库里对后来者是个隐患（谁手滑 make 一下就
    // 往工作区里拉屎）。临时目录里的形态证明的是同一件事：采集**只读**，而且我们确实读到了目标名。
    const dir = await makeRepo({
      "package.json": JSON.stringify({ scripts: { postinstall: "touch ./pwned-npm" } }),
      "scripts/setup.sh": "touch ./pwned-sh\n",
    });
    // Makefile 里写绝对路径：如果它被真的执行了，哨兵文件就出现在这个临时目录里。
    await writeFile(path.join(dir, "Makefile"), `pwn:\n\t@touch ${dir}/pwned-make\n`);
    const signals = await collectSignals(dir);
    // 读了（目标名在信号里），但没跑：
    assert.deepEqual(signals.makeTargets, ["pwn"]);
    assert.equal(existsSync(path.join(dir, "pwned-make")), false);
    assert.equal(existsSync(path.join(dir, "pwned-npm")), false);
    assert.equal(existsSync(path.join(dir, "pwned-sh")), false);
  });

  test("采集层不 import child_process（结构性的第二道门）", async () => {
    // 行为断言（上面那条）能抓住"现在真的执行了"，这条能抓住"有人为了别的功能
    // 把 child_process 引进来"——推断是纯读文本的一层，不该有任何进程能力。
    const dir = fileURLToPath(new URL("../../src/environment/", import.meta.url));
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(path.join(dir, file), "utf8");
      assert.ok(!text.includes("child_process"), `${file} 不该 import child_process`);
      assert.ok(!/\bexecSync\b|\bspawnSync\b/.test(text), `${file} 不该有同步执行`);
    }
  });

  test("超过文件上限时记一条 ignored（而不是静默少算）", async () => {
    const files: Record<string, string> = { "package.json": "{}" };
    for (let index = 0; index < 8; index += 1) files[`src/f${index}.ts`] = "export {}";
    const dir = await makeRepo(files);
    const signals = await collectSignals(dir, { maxFiles: 3 });
    assert.ok(signals.ignored.some((item) => item.field === "files" && /上限/.test(item.reason)));
  });

  test("认不出的语言会记一条 ignored（矩阵里没有它）", async () => {
    const dir = await makeRepo({ "main.rb": "puts 1", "Gemfile": "source 'https://rubygems.org'" });
    const signals = await collectSignals(dir);
    assert.ok(signals.languages.includes("ruby"));
    assert.ok(signals.ignored.some((item) => item.field === "languages" && /ruby/.test(item.reason)));
  });

  test("devcontainer 的命名变体（.devcontainer/<name>/…）被显式忽略", async () => {
    const dir = await makeRepo({ ".devcontainer/web/devcontainer.json": "{}" });
    const signals = await collectSignals(dir);
    assert.equal(signals.hasDevcontainer, false);
    assert.ok(signals.ignored.some((item) => item.field === "devcontainer.json"));
  });
});
