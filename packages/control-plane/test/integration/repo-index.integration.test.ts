/**
 * P8/P9 的持久层集成测试（`npm run test:integration`，**需要一个一次性 Postgres 容器**）。
 *
 * 【它覆盖什么】spec P8/P9 里"只有真库 / 真 git / 真 WASM 能回答"的那几条：
 *  1. `009_repo_index.sql` 的四张表与 `010_repo_map.sql` 在真 PG 上建得出来，迁移可重跑；
 *  2. `repo_symbols` 能回答验收标准里那句"某个符号定义在哪几个文件里"；
 *  3. **增量 == 全量**：真 git 的 `diff --name-status` + 真 worker 解析 + 真 PG 的
 *     `INSERT … SELECT` 复制与 `unnest` 排除，两边算出来的行集合摘要逐字节相同；
 *  4. 幂等（同一个 commit 索引两次不产生重复行）与保留策略（只留最近两版）；
 *  5. `gitIndexPort` 的三条命令在真的仓库上给出预期的 A/M/D 与祖先判断；
 *  6. P9：`repo_maps` 的 upsert / 索引指纹 / 保留策略（`RepoMapStore` 契约），以及
 *     "真索引 → 真地图 → 命中缓存 → 重新索引后缓存失效"这条端到端。
 *
 * 【它不替代什么】增量逻辑的分支（受影响集、import 解析变化、崩溃、超时）在 `index-incremental`
 * 里用假 store 逐条覆盖，地图的排名 / 排版 / 降级在 `repo-map-*` 三个单测里——那些是"逻辑对不对"，
 * 这里是"SQL 与内存实现是不是同一件事"。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { indexRepository } from "../../src/index/indexer.ts";
import { buildRepoMap } from "../../src/index/repo-map.ts";
import { gitIndexPort } from "../../src/index/git-port.ts";
import { discoverFiles } from "../../src/index/parse.ts";
import {
  getRepoMap,
  listRepoFileRefs,
  listRepoRefs,
  listRepoSymbols,
  postgresRepoIndexStore,
  postgresRepoMapStore,
} from "../../src/index/store.ts";
import { repoMapStoreContract } from "../repo-map-store-contract.ts";
import { startPostgres } from "../support.ts";
import type { TestPostgres } from "../support.ts";

const REPO = "owner/integration";
const REPO_FULL = "owner/integration-full";
const REPO_MAP = "owner/integration-map";

let pg: TestPostgres;
let db: Db;
let workDir: string;
const shas: Record<string, string> = {};

/** 跑一条宿主命令（这个文件只需要 git）。 */
function run(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function git(args: string[]): Promise<string> {
  const result = await run([
    "git",
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "commit.gpgsign=false",
    "-C",
    workDir,
    ...args,
  ]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * 一批填充文件。
 *
 * 阈值是 30%（spec §5），而这里的 fixture 仓库只有两三个源文件——不加填充的话"改一个文件"
 * 就是 33%+，直接走全量，增量那条路根本不会被走到。真仓库里变化集永远只是几百个文件里的几个。
 */
function fillers(count = 6): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 1; index <= count; index += 1) out[`src/filler${index}.ts`] = `export const filler${index} = ${index};\n`;
  return out;
}

/** 把工作区换成这一版的文件（未列出的删掉），提交，返回 sha。 */
async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const entry of await readdir(workDir)) {
    if (entry === ".git") continue;
    await rm(path.join(workDir, entry), { recursive: true, force: true });
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git(["add", "-A"]);
  await git(["commit", "-qm", message]);
  return (await git(["rev-parse", "HEAD"])).trim();
}

/** 三张数据表拼成摘要（增量与全量比的就是它）。 */
async function digest(repoKey: string, commitSha: string): Promise<string> {
  const symbols = await listRepoSymbols(db, repoKey, commitSha);
  const refs = await listRepoRefs(db, repoKey, commitSha);
  const fileRefs = await listRepoFileRefs(db, repoKey, commitSha);
  const lines = [
    ...symbols.map((row) => `S|${row.path}|${row.name}|${row.kind}|${row.signature}|${row.start_line}|${row.end_line}`),
    ...fileRefs.map((row) => `C|${row.path}|${row.kind}|${row.symbol}`),
    ...refs.map((row) => `E|${row.from_path}|${row.to_path}|${row.symbol}|${row.weight.toFixed(6)}`),
  ].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * 索引某个 commit。
 *
 * 【为什么必须先 checkout】索引解析的是**工作区里的文件**（与生产一致：CP 的 clone 停在
 * 某一个 commit 上），而 `git commit` 之后的仓库停在最后一个提交。第一版没做这一步，
 * 于是在"索引 c1"的时候读到的其实是 c3 的文件内容——而全量与增量两边读到的都是错的，
 * 摘要比较当然一致。这条与 `index-incremental` 里"假 parser 读文件"是同一个道理：
 * **被测的东西必须真的来自那个快照**。
 */
async function index(repoKey: string, commitSha: string, rebuild = false) {
  await git(["checkout", "-q", "--force", commitSha]);
  await git(["clean", "-qfd"]);
  const result = await indexRepository({
    repoKey,
    commitSha,
    cloneDir: workDir,
    store: postgresRepoIndexStore(db),
    rebuild,
  });
  assert.notEqual(result, null, "索引不该失败");
  return result!;
}

before(async () => {
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
  workDir = await mkdtemp(path.join(os.tmpdir(), "rc-index-int-"));
  await git(["init", "-q", "--initial-branch", "main"]);

  shas.c1 = await commit(
    {
      ...fillers(),
      "README.md": "# fixture\n",
      "src/util.ts": "export function helper(value: string): string {\n  return value;\n}\n",
      "src/main.ts": 'import { helper } from "./util";\n\nexport function run(): string {\n  return helper("x");\n}\n',
    },
    "c1",
  );
  shas.c2 = await commit(
    {
      ...fillers(),
      "README.md": "# fixture\n",
      "src/util.ts": "export function helper(value: string): string {\n  return value;\n}\n",
      "src/extra.ts": "export function extra(): number {\n  return 1;\n}\n",
      "src/main.ts":
        'import { helper } from "./util";\nimport { extra } from "./extra";\n\nexport function run(): string {\n  return helper(String(extra()));\n}\n',
    },
    "c2",
  );
  shas.c3 = await commit(
    {
      ...fillers(),
      "README.md": "# fixture\n",
      "src/util.ts": "export function renamedHelper(value: string): string {\n  return value;\n}\n",
      "src/main.ts":
        'import { helper } from "./util";\nimport { extra } from "./extra";\n\nexport function run(): string {\n  return helper(String(extra()));\n}\n',
    },
    "c3",
  );
});

after(async () => {
  await db.close();
  await pg.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe("Phase 8 · 索引落到真 Postgres", () => {
  test("1. 全量索引：四张表都有行，status=ready，语言统计对得上", async () => {
    const result = await index(REPO, shas.c1!);
    assert.equal(result.mode, "full");
    assert.equal(result.status, "ready");
    assert.equal(result.files, 9, "README 也计进 files");
    assert.equal(result.parsedFiles, 8, "八个 .ts 文件都要解析");
    assert.deepEqual(result.languages, { typescript: 8 });

    // 验收标准里那句"某个符号定义在哪几个文件里"。
    const symbols = await listRepoSymbols(db, REPO, shas.c1!, { names: ["helper"] });
    assert.deepEqual(
      symbols.map((row) => [row.path, row.kind, row.signature]),
      [["src/util.ts", "function", "export function helper(value: string): string"]],
    );

    // 边：import（w=2）与标识符（w=1）都在。
    const refs = await listRepoRefs(db, REPO, shas.c1!);
    assert.deepEqual(
      refs
        .filter((row) => row.from_path === "src/main.ts")
        .map((row) => [row.to_path, row.symbol, row.weight])
        .sort(),
      [
        ["src/util.ts", "./util", 2],
        ["src/util.ts", "helper", 1],
      ],
    );

    // 候选表（增量重建的输入）也落了。
    const candidates = await listRepoFileRefs(db, REPO, shas.c1!, { paths: ["src/main.ts"] });
    assert.deepEqual(candidates.map((row) => [row.kind, row.symbol]).sort(), [
      ["identifier", "helper"],
      ["import", "./util"],
    ]);
  });

  test("3. 真实 git + 真 worker：增量与全量的行集合摘要逐字节相同", async () => {
    await index(REPO, shas.c1!);
    const incremental = await index(REPO, shas.c2!);
    assert.equal(incremental.mode, "incremental", "c1→c2 只动了一个文件，应当走增量");
    assert.equal(incremental.previousCommitSha, shas.c1);
    const full = await index(REPO_FULL, shas.c2!, true);
    assert.equal(full.mode, "full");
    assert.equal(await digest(REPO, shas.c2!), await digest(REPO_FULL, shas.c2!), "增量必须与全量一致");

    // c3：删一个文件 + 改一个文件（`helper` 改名了 → main.ts 的边要消失）。
    const third = await index(REPO, shas.c3!);
    assert.equal(third.mode, "incremental");
    await index(REPO_FULL, shas.c3!, true);
    assert.equal(await digest(REPO, shas.c3!), await digest(REPO_FULL, shas.c3!));
    // `helper`（改名了）与 `./extra`（删了）都解析不到了，只剩 `./util` 这条 import 边。
    assert.deepEqual(
      (await listRepoRefs(db, REPO, shas.c3!)).map((row) => [row.from_path, row.to_path, row.symbol, row.weight]),
      [["src/main.ts", "src/util.ts", "./util", 2]],
    );
  });

  test("9. 幂等：同一个 commit 索引两次不产生重复行", async () => {
    await index(REPO, shas.c2!);
    const before = {
      digest: await digest(REPO, shas.c2!),
      symbols: (await listRepoSymbols(db, REPO, shas.c2!)).length,
      refs: (await listRepoRefs(db, REPO, shas.c2!)).length,
    };
    const again = await index(REPO, shas.c2!);
    assert.equal(again.mode, "skipped");
    assert.equal(await digest(REPO, shas.c2!), before.digest);
    assert.equal((await listRepoSymbols(db, REPO, shas.c2!)).length, before.symbols);
    assert.equal((await listRepoRefs(db, REPO, shas.c2!)).length, before.refs);

    // 强制重建同一版也必须幂等（先删后插那一步的作用）。
    await index(REPO, shas.c2!, true);
    assert.equal(await digest(REPO, shas.c2!), before.digest);
  });

  test("保留策略：只留最近两版，更老的 commit 的行被清掉", async () => {
    await index(REPO, shas.c1!);
    await index(REPO, shas.c2!);
    await index(REPO, shas.c3!);
    assert.equal((await listRepoSymbols(db, REPO, shas.c1!)).length, 0, "最老的一版被清掉");
    assert.ok((await listRepoSymbols(db, REPO, shas.c2!)).length > 0);
    assert.ok((await listRepoSymbols(db, REPO, shas.c3!)).length > 0);
  });

  test("5. gitIndexPort：diff 的 A/M/D 与祖先判断在真仓库上正确", async () => {
    const port = gitIndexPort(workDir);
    assert.equal(await port.head(), shas.c3);
    assert.equal(await port.isAncestor(shas.c1!, shas.c3!), true);
    assert.equal(await port.isAncestor(shas.c3!, shas.c1!), false, "后来的提交不是更早那条的祖先");
    assert.deepEqual(
      (await port.diff(shas.c1!, shas.c2!)).sort((a, b) => (a.path < b.path ? -1 : 1)),
      [
        { path: "src/extra.ts", status: "added" },
        { path: "src/main.ts", status: "modified" },
      ],
    );
    assert.deepEqual(await port.diff(shas.c1!, shas.c1!), []);
  });
});

// ---------------------------------------------------------------- P9

repoMapStoreContract("真 Postgres", () => postgresRepoMapStore(db), "contract-pg");

describe("Phase 9 · 地图缓存与真索引", () => {
  test("真索引 → 真地图：地图里有 issue 涉及的模块；重复渲染命中缓存；重新索引后缓存失效", async () => {
    await index(REPO_MAP, shas.c1!);
    const indexStore = postgresRepoIndexStore(db);
    const maps = postgresRepoMapStore(db);
    const files = (await discoverFiles(workDir)).all;
    const ask = { repoKey: REPO_MAP, commitSha: shas.c1!, task: "helper 的返回值不对，修一下", index: indexStore, maps, files };

    const first = await buildRepoMap(ask);
    assert.equal(first.degraded, null);
    assert.equal(first.cached, false);
    assert.equal(first.truncated, false);
    assert.ok(first.matchedSymbols.includes("helper"), first.matchedSymbols.join(","));
    assert.ok(first.text.includes("src/util.ts:"), first.text);
    assert.ok(first.text.includes("export function helper(value: string): string"), first.text);

    // 缓存：键（repo, commit, 任务词, 预算）都在真库里对上了，第二次不该重算。
    const second = await buildRepoMap(ask);
    assert.equal(second.cached, true);
    assert.equal(second.text, first.text);
    assert.equal(second.hash, first.hash);

    // 同一个 commit 重新索引（built_at 前进）→ 索引指纹变了 → 旧地图不算命中。
    await sleep(10);
    await index(REPO_MAP, shas.c1!, true);
    const third = await buildRepoMap(ask);
    assert.equal(third.cached, false, "重新索引过就必须重算（附录 A-57）");
    assert.equal(third.text, first.text, "符号没变，重算出来还是同一份地图");

    // 换个任务词是另一条缓存（同一个 commit 上共存）。
    const other = await buildRepoMap({ ...ask, task: "修一下 main.ts 里的 run" });
    assert.equal(other.cached, false);
    assert.notEqual(other.personalizationHash, first.personalizationHash);
  });

  test("降级：没有索引的 commit → 文件树，且不往 repo_maps 里写任何行", async () => {
    const maps = postgresRepoMapStore(db);
    const files = (await discoverFiles(workDir)).all;
    const result = await buildRepoMap({
      repoKey: REPO_MAP,
      commitSha: "deadbeefdeadbeef",
      task: "随便什么任务",
      index: postgresRepoIndexStore(db),
      maps,
      files,
    });
    assert.equal(result.degraded, "index_missing");
    assert.ok(result.text.startsWith("# 仓库文件树"), result.text);
    assert.ok(result.text.includes("src/"), result.text);
    assert.equal(
      await getRepoMap(db, {
        repoKey: REPO_MAP,
        commitSha: "deadbeefdeadbeef",
        personalizationHash: result.personalizationHash,
        budgetTokens: result.budgetTokens,
      }),
      null,
      "降级结果不进缓存（索引修好后必须能拿到真地图）",
    );
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
