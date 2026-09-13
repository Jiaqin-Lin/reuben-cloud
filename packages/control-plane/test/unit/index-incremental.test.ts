/**
 * P8 · 增量重建的金标准（spec 测试要点 5、6、9，以及增量判定本身）。
 *
 * 【它拦住的是哪一类回归】"增量"是 P8 唯一一处**结果依赖历史**的逻辑：少解析文件、
 * 复制旧行、只重算受影响的边——任何一处算错，得到的地图都不会报错，只会悄悄与全量不一致
 * （模型看到的地图会漏掉或多出一条边）。所以主断言不是"某条边在"，而是
 * **`增量行集合的哈希 == 全量重建的哈希`**：它同时覆盖符号、候选、边三张表。
 *
 * 【为什么这些用例能跑在 `npm test` 里】它们需要的是"能读回上一版的行"（内存 store）、
 * "知道哪些文件变了"（假 git 端口）、"解析给了什么"（按文件内容解析的假 parser，见
 * `test/index-fakes.ts`）——三件都不需要 Postgres、docker 或 WASM。真库那一份（SQL 复制与排除）
 * 在 `test/integration/repo-index.integration.test.ts`。
 *
 * 【仓库内容是标记文本】`sym:foo` / `ref:foo` / `imp:app` 这些行就是"解析结果"，所以每一版的
 * 仓库状态**只描述一次**：全量与增量看到的是同一份事实，哈希比较才有意义（第一版按"每个 commit
 * 一份脚本"写，结果两边用了不同的剧本，踩过一次）。
 *
 * 【它不替代什么】tree-sitter 真的解析出什么（`index-symbols` / `index-refs`）、
 * 真 git 的 diff 输出（`parseNameStatusZ` 的用例 + 集成测试）。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { indexRepository } from "../../src/index/indexer.ts";
import { parseNameStatusZ } from "../../src/index/git-port.ts";
import { contentParser, fakeGit, fakeParser, memoryRepoIndexStore, trackingParser } from "../index-fakes.ts";
import type { FakeParser, MemoryRepoIndexStore } from "../index-fakes.ts";

const REPO = "owner/name";

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 造一个"仓库目录"：路径 → 标记内容。内容对假 parser 就是解析结果（见文件头）。 */
async function makeRepoDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-index-"));
  tempDirs.push(dir);
  await resetRepoDir(dir, files);
  return dir;
}

/** 把目录清空再写入这一版的文件（模拟 checkout 到另一个 commit）。 */
async function resetRepoDir(dir: string, files: Record<string, string>): Promise<void> {
  for (const entry of await readdir(dir)) await rm(path.join(dir, entry), { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/**
 * 加一批"填充文件"：让变化集占比落在 30% 以下。
 *
 * 阈值是 30%（spec §5），而用例的仓库很小——不加填充的话"改两个文件"就是 50%，直接走全量，
 * 增量那条路根本不会被走到（第一版真的在这里失败过）。填充文件也是真实仓库的常态：
 * 变化集永远只是几百个文件里的几个。
 */
function withFillers(files: Record<string, string>, count = 6): Record<string, string> {
  const out = { ...files };
  for (let index = 1; index <= count; index += 1) out[`src/filler${index}.ts`] = `// filler ${index}`;
  return out;
}

/** 三张表拼成一个摘要：增量与全量比的就是它。 */
function digest(store: MemoryRepoIndexStore, commitSha: string): string {
  const lines = [
    ...store.symbols(REPO, commitSha).map((row) => `S|${row.path}|${row.name}|${row.kind}|${row.signature}|${row.start_line}|${row.end_line}`),
    ...store.fileRefs(REPO, commitSha).map((row) => `C|${row.path}|${row.kind}|${row.symbol}`),
    ...store.refs(REPO, commitSha).map((row) => `E|${row.from_path}|${row.to_path}|${row.symbol}|${row.weight.toFixed(6)}`),
  ].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

interface Scenario {
  dir: string;
  store: MemoryRepoIndexStore;
  git: ReturnType<typeof fakeGit>;
}

async function scenario(input: {
  files: Record<string, string>;
  head: string;
  diffs: Record<string, { path: string; status: "added" | "modified" | "deleted" }[]>;
  ancestry?: Record<string, string[]>;
}): Promise<Scenario> {
  return {
    dir: await makeRepoDir(input.files),
    store: memoryRepoIndexStore(),
    git: fakeGit({ head: input.head, diffs: input.diffs, ancestry: input.ancestry }),
  };
}

/** 跑一次索引（默认假 parser 按当前目录内容解析；降级用例传自己的 parser）。 */
async function runCommit(
  scenarioRef: Scenario,
  commitSha: string,
  options: { store?: MemoryRepoIndexStore; rebuild?: boolean; parser?: FakeParser } = {},
) {
  const parsed = options.parser ?? trackingParser(contentParser());
  const store = options.store ?? scenarioRef.store;
  const result = await indexRepository({
    repoKey: REPO,
    commitSha,
    cloneDir: scenarioRef.dir,
    store,
    git: scenarioRef.git,
    parser: parsed.parser,
    vendorDir: "unused",
    rebuild: options.rebuild,
  });
  return { result, parsed, store };
}

/** 全量重建同一版（新 store），返回摘要——所有增量用例的"标准答案"。 */
async function fullRebuildDigest(scenarioRef: Scenario, commitSha: string): Promise<string> {
  const fresh = memoryRepoIndexStore();
  const { result } = await runCommit(scenarioRef, commitSha, { store: fresh, rebuild: true });
  assert.equal(result?.mode, "full");
  return digest(fresh, commitSha);
}

describe("增量判定", () => {
  test("5. 三个提交逐步改动：增量与全量的行集合逐字节相同（哈希断言）", async () => {
    const scenarioRef = await scenario({
      files: withFillers({
        "README.md": "readme",
        "src/util.ts": "sym:foo",
        "src/main.ts": "ref:foo",
      }),
      head: "c3",
      ancestry: { c2: ["c1"], c3: ["c2"], c4: ["c3"], c5: ["c4"] },
      diffs: {
        "c1..c2": [
          { path: "src/main.ts", status: "modified" },
          { path: "src/extra.ts", status: "added" },
        ],
        "c2..c3": [
          { path: "src/util.ts", status: "modified" },
          { path: "src/extra.ts", status: "deleted" },
        ],
        "c3..c4": [{ path: "README.md", status: "modified" }],
        "c4..c5": [],
      },
    });

    // ---- c1：首次索引（全量）
    const first = await runCommit(scenarioRef, "c1");
    assert.equal(first.result?.mode, "full");
    assert.equal(first.result?.symbols, 1);
    assert.equal(first.result?.edges, 1);
    assert.equal(first.parsed.calls[0]?.length, 8, "全量要解析每一个可解析文件（含填充）");
    assert.equal(digest(scenarioRef.store, "c1"), await fullRebuildDigest(scenarioRef, "c1"));

    // ---- c2：改一个文件 + 加一个文件（增量）
    await resetRepoDir(
      scenarioRef.dir,
      withFillers({
        "README.md": "readme",
        "src/util.ts": "sym:foo",
        "src/main.ts": "ref:foo\nref:bar",
        "src/extra.ts": "sym:bar",
      }),
    );
    const second = await runCommit(scenarioRef, "c2");
    assert.equal(second.result?.mode, "incremental");
    assert.equal(second.result?.parsedFiles, 2, "只该解析变化文件");
    assert.deepEqual(second.parsed.calls[0]?.sort(), ["src/extra.ts", "src/main.ts"]);
    assert.equal(second.result?.symbols, 2, "util.ts 的符号是复制过来的");
    assert.equal(second.result?.edges, 2, "main → util(foo) 与 main → extra(bar)");
    assert.equal(digest(scenarioRef.store, "c2"), await fullRebuildDigest(scenarioRef, "c2"));

    // ---- c3：删一个文件 + 改一个文件（增量）
    await resetRepoDir(
      scenarioRef.dir,
      withFillers({
        "README.md": "readme",
        "src/util.ts": "sym:baz",
        "src/main.ts": "ref:foo\nref:bar",
      }),
    );
    const third = await runCommit(scenarioRef, "c3");
    assert.equal(third.result?.mode, "incremental");
    assert.deepEqual(third.parsed.calls[0], ["src/util.ts"]);
    // `foo` 与 `bar` 都没人定义了 → main.ts 的边应该全部消失（受影响集重算的结果）。
    assert.equal(third.result?.edges, 0);
    assert.equal(third.result?.symbols, 1);
    assert.equal(digest(scenarioRef.store, "c3"), await fullRebuildDigest(scenarioRef, "c3"));

    // ---- c4：只有 README 变了 → 增量，但一个源文件都不用解析（复制 + 重算受影响的边）
    await resetRepoDir(
      scenarioRef.dir,
      withFillers({
        "README.md": "readme v2",
        "src/util.ts": "sym:baz",
        "src/main.ts": "ref:foo\nref:bar",
      }),
    );
    const fourth = await runCommit(scenarioRef, "c4");
    assert.equal(fourth.result?.mode, "incremental");
    assert.equal(fourth.parsed.calls.length, 0, "没有源文件变化时不该叫 parser");
    assert.equal(digest(scenarioRef.store, "c4"), digest(scenarioRef.store, "c3"));
    assert.equal(fourth.result?.symbols, third.result?.symbols);

    // ---- c5：空提交（diff 为空）→ 纯复制
    const fifth = await runCommit(scenarioRef, "c5");
    assert.equal(fifth.result?.mode, "reuse");
    assert.equal(fifth.parsed.calls.length, 0);
    assert.equal(digest(scenarioRef.store, "c5"), digest(scenarioRef.store, "c4"));
  });

  test("5. 同名定义从 3 处减到 1 处：受影响文件的边被重算成 weight=1", async () => {
    const scenarioRef = await scenario({
      files: withFillers({
        "a.ts": "sym:shared",
        "b.ts": "sym:shared",
        "c.ts": "sym:shared",
        "user.ts": "ref:shared",
      }),
      head: "v2",
      ancestry: { v2: ["v1"] },
      diffs: {
        "v1..v2": [
          { path: "b.ts", status: "deleted" },
          { path: "c.ts", status: "deleted" },
        ],
      },
    });

    await runCommit(scenarioRef, "v1");
    assert.equal(scenarioRef.store.refs(REPO, "v1").length, 3);
    for (const edge of scenarioRef.store.refs(REPO, "v1")) assert.ok(Math.abs(edge.weight - 1 / 3) < 1e-9);

    await resetRepoDir(scenarioRef.dir, withFillers({ "a.ts": "sym:shared", "user.ts": "ref:shared" }));
    const second = await runCommit(scenarioRef, "v2");
    assert.equal(second.result?.mode, "incremental");
    // 这次一个文件都不用解析（只有删除），但 user.ts 的边必须被重算。
    assert.equal(second.parsed.calls.length, 0, "没有要解析的文件时连 worker 都不该起");
    assert.deepEqual(
      scenarioRef.store.refs(REPO, "v2").map((edge) => [edge.from_path, edge.to_path, edge.symbol, edge.weight]),
      [["user.ts", "a.ts", "shared", 1]],
    );
    assert.equal(digest(scenarioRef.store, "v2"), await fullRebuildDigest(scenarioRef, "v2"));
  });

  test("5. 新增同名模块让 import 变歧义：不变文件的过期边必须消失", async () => {
    const scenarioRef = await scenario({
      files: withFillers({
        "src/app/__init__.py": "sym:greet",
        "src/app/main.py": "imp:app\nref:greet",
      }),
      head: "w2",
      ancestry: { w2: ["w1"] },
      diffs: { "w1..w2": [{ path: "lib/app/__init__.py", status: "added" }] },
    });

    await runCommit(scenarioRef, "w1");
    assert.deepEqual(
      scenarioRef.store
        .refs(REPO, "w1")
        .map((edge) => [edge.from_path, edge.to_path, edge.symbol, edge.weight])
        .sort(),
      [
        ["src/app/main.py", "src/app/__init__.py", "app", 2],
        ["src/app/main.py", "src/app/__init__.py", "greet", 1],
      ],
    );

    await resetRepoDir(
      scenarioRef.dir,
      withFillers({
        "src/app/__init__.py": "sym:greet",
        "src/app/main.py": "imp:app\nref:greet",
        "lib/app/__init__.py": "sym:other",
      }),
    );
    const second = await runCommit(scenarioRef, "w2");
    assert.equal(second.result?.mode, "incremental");
    // `src/app/main.py` 没变，但它的 import 解析从"唯一"变成了"歧义" → 那条边必须消失。
    assert.deepEqual(
      scenarioRef.store.refs(REPO, "w2").map((edge) => edge.symbol),
      ["greet"],
    );
    assert.equal(digest(scenarioRef.store, "w2"), await fullRebuildDigest(scenarioRef, "w2"));
  });

  test("5. 删掉一个同名模块让 import 变唯一：新边要被发现", async () => {
    const scenarioRef = await scenario({
      files: withFillers({
        "src/app/__init__.py": "sym:greet",
        "lib/app/__init__.py": "sym:other",
        "src/app/main.py": "imp:app\nref:greet",
      }),
      head: "x2",
      ancestry: { x2: ["x1"] },
      diffs: { "x1..x2": [{ path: "lib/app/__init__.py", status: "deleted" }] },
    });

    await runCommit(scenarioRef, "x1");
    // `greet` 的标识符边与 import 解析无关（它按符号表解析），所以只断言 `app` 这条。
    assert.deepEqual(
      scenarioRef.store.refs(REPO, "x1").map((edge) => edge.symbol),
      ["greet"],
      "歧义的 import 不产生边",
    );

    await resetRepoDir(
      scenarioRef.dir,
      withFillers({
        "src/app/__init__.py": "sym:greet",
        "src/app/main.py": "imp:app\nref:greet",
      }),
    );
    await runCommit(scenarioRef, "x2");
    assert.deepEqual(
      scenarioRef.store
        .refs(REPO, "x2")
        .map((edge) => [edge.from_path, edge.to_path, edge.symbol, edge.weight])
        .sort((a, b) => (String(a[2]) < String(b[2]) ? -1 : 1)),
      [
        ["src/app/main.py", "src/app/__init__.py", "app", 2],
        ["src/app/main.py", "src/app/__init__.py", "greet", 1],
      ],
    );
    assert.equal(digest(scenarioRef.store, "x2"), await fullRebuildDigest(scenarioRef, "x2"));
  });

  test("变化文件超过 30% → 全量重建；非祖先（force push）→ 全量重建", async () => {
    const scenarioRef = await scenario({
      files: { "a.ts": "sym:a", "b.ts": "sym:b", "c.ts": "sym:c", "d.ts": "sym:d" },
      head: "y2",
      ancestry: { y2: ["y1"] },
      diffs: {
        // 4 个可解析文件里动了 2 个 = 50% ≥ 30%
        "y1..y2": [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "modified" },
        ],
      },
    });
    await runCommit(scenarioRef, "y1");
    await resetRepoDir(scenarioRef.dir, { "a.ts": "sym:a2", "b.ts": "sym:b2", "c.ts": "sym:c", "d.ts": "sym:d" });
    const second = await runCommit(scenarioRef, "y2");
    assert.equal(second.result?.mode, "full");
    assert.equal(second.parsed.calls[0]?.length, 4);

    // 非祖先：同样是"改一个文件"，但上一版的 commit 不在这条历史上（force push / 换分支）。
    const forced = await scenario({
      files: { "a.ts": "sym:a", "b.ts": "sym:b" },
      head: "z2",
      ancestry: {},
      diffs: {},
    });
    await runCommit(forced, "z1");
    await resetRepoDir(forced.dir, { "a.ts": "sym:a", "b.ts": "sym:b2" });
    const rebuilt = await runCommit(forced, "z2");
    assert.equal(rebuilt.result?.mode, "full", "非祖先必须全量");
  });

  test("6. worker 崩溃 → failed + 返回 null，且下一次索引还能跑", async () => {
    const scenarioRef = await scenario({
      files: { "a.ts": "sym:a" },
      head: "q1",
      diffs: {},
    });
    const crashed = await runCommit(scenarioRef, "q1", {
      parser: fakeParser({}, { crashed: true, stderr: "RuntimeError: unreachable" }),
    });
    assert.equal(crashed.result, null);
    const row = await scenarioRef.store.get(REPO, "q1");
    assert.equal(row?.status, "failed");
    assert.match(row?.error ?? "", /worker_crashed/);
    assert.match(row?.error ?? "", /unreachable/, "崩溃的 stderr 尾部要留在行里");

    // 崩溃之后没有留下半份数据，重跑一次能正常建出来。
    const retry = await runCommit(scenarioRef, "q1");
    assert.equal(retry.result?.status, "ready");
    assert.equal(scenarioRef.store.symbols(REPO, "q1").length, 1);
  });

  test("6. 总预算超时 → ready + partial_timeout（已解析的部分可用）", async () => {
    const scenarioRef = await scenario({
      files: { "a.ts": "sym:a", "b.ts": "sym:b" },
      head: "q2",
      diffs: {},
    });
    const slow = trackingParser(contentParser({ timedOut: true }));
    const { result } = await runCommit(scenarioRef, "q2", { parser: slow });
    assert.equal(result?.status, "ready");
    assert.equal(result?.error, "partial_timeout");
    assert.equal(result?.symbols, 2, "已解析的部分照常落库");
  });

  test("6. 单文件超时 → 跳过该文件且不失败", async () => {
    const scenarioRef = await scenario({
      files: { "a.ts": "sym:a", "b.ts": "sym:b\nstatus:timeout" },
      head: "q4",
      diffs: {},
    });
    const { result } = await runCommit(scenarioRef, "q4");
    assert.equal(result?.status, "ready");
    assert.equal(result?.error, null);
    assert.deepEqual(
      scenarioRef.store.symbols(REPO, "q4").map((row) => row.name),
      ["a"],
      "超时的那个文件不该贡献符号",
    );
  });

  test("9. 同一个 commit 索引两次：第二次直接跳过，不产生重复行", async () => {
    const scenarioRef = await scenario({
      files: { "a.ts": "sym:a" },
      head: "q3",
      diffs: {},
    });
    await runCommit(scenarioRef, "q3");
    const before = digest(scenarioRef.store, "q3");
    const writes = scenarioRef.store.calls.writeIndex;
    const again = await runCommit(scenarioRef, "q3");
    assert.equal(again.result?.mode, "skipped");
    assert.equal(scenarioRef.store.calls.writeIndex, writes, "跳过时一个字节都不该写");
    assert.equal(digest(scenarioRef.store, "q3"), before);
    assert.equal(scenarioRef.store.symbols(REPO, "q3").length, 1);
  });

  test("保留策略：只留最近 N 版的行（默认 2）", async () => {
    const scenarioRef = await scenario({
      files: { "a.ts": "sym:a1" },
      head: "p3",
      ancestry: { p2: ["p1"], p3: ["p2"] },
      diffs: {
        "p1..p2": [{ path: "a.ts", status: "modified" }],
        "p2..p3": [{ path: "a.ts", status: "modified" }],
      },
    });
    await runCommit(scenarioRef, "p1");
    await resetRepoDir(scenarioRef.dir, { "a.ts": "sym:a2" });
    await runCommit(scenarioRef, "p2");
    await resetRepoDir(scenarioRef.dir, { "a.ts": "sym:a3" });
    await runCommit(scenarioRef, "p3");
    assert.equal(scenarioRef.store.symbols(REPO, "p1").length, 0, "最老的一版被清掉了");
    assert.equal(scenarioRef.store.symbols(REPO, "p2").length, 1);
    assert.equal(scenarioRef.store.symbols(REPO, "p3").length, 1);
  });

  test("完全不认识的语言 → status=unsupported（不报错）", async () => {
    const scenarioRef = await scenario({
      files: { "main.cob": "IDENTIFICATION DIVISION." },
      head: "u1",
      diffs: {},
    });
    const { result } = await runCommit(scenarioRef, "u1");
    assert.equal(result?.status, "unsupported");
    assert.equal(result?.files, 1);
    assert.equal(result?.symbols, 0);
    assert.equal((await scenarioRef.store.get(REPO, "u1"))?.status, "unsupported");
  });
});

describe("git diff 输出解析", () => {
  test("A/M/D 三种状态与含中文的路径（-z 形态）", () => {
    const stdout = ["M", "src/中文 名字.ts", "A", "src/new.go", "D", "old.rb", ""].join("\u0000");
    assert.deepEqual(parseNameStatusZ(stdout), [
      { path: "src/中文 名字.ts", status: "modified" },
      { path: "src/new.go", status: "added" },
      { path: "old.rb", status: "deleted" },
    ]);
  });

  test("空输出 = 没有变化（reuse 的判据）", () => {
    assert.deepEqual(parseNameStatusZ(""), []);
  });
});
