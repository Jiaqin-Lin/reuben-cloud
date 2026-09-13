/**
 * P8 · 解析 worker 的协议、预算与隔离（spec 测试要点 6、7）。
 *
 * 【它拦住的是哪一类回归】
 *  ① **协议**：主进程与 worker 之间只有一条管道，改一边忘一边的代价是"索引永远 failed"，
 *     所以这里真的 spawn 一个 worker（用真 wasm 解析真文件）跑一遍完整往返；
 *  ② **隔离**：worker 崩了 / 输出垃圾 / 不发 `done` 就退出，CP 主进程必须活着（测试要点 7）
 *     ——这条是"索引失败不阻塞 Run"的底层保证，用真子进程验才有意义；
 *  ③ **预算**：超体积的文件被跳过而不是把整个索引拖垮；
 *  ④ **环境**：worker 的 env 只有 PATH/HOME/TMPDIR（凭据不进"解析别人代码"的进程）。
 *
 * 【它不替代什么】树解析出来的符号是否正确由 `index-symbols` 覆盖；这里只关心
 * "文件进得去、结果出得来、坏情况不带走主进程"。
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { discoverFiles, parseBatch, parseWorkerArgs, PER_FILE_BUDGET_MS, TOTAL_BUDGET_MS, workerEnv } from "../../src/index/parse.ts";

const VENDOR = fileURLToPath(new URL("../../../../vendor/tree-sitter/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/index/", import.meta.url));

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function makeDir(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-parse-"));
  tempDirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

describe("文件发现", () => {
  test("跳过依赖与产物目录；不认识的语言计进 files 但不计进 indexable", async () => {
    const dir = await makeDir({
      "src/a.ts": "export function a() {}\n",
      "src/b.py": "def b():\n  pass\n",
      "docs/readme.md": "# hi\n",
      "node_modules/pkg/index.ts": "export function nope() {}\n",
      "dist/bundle.js": "// built\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "vendor/dep/x.go": "package dep\n",
    });
    const discovery = await discoverFiles(dir);
    assert.deepEqual(discovery.all.sort(), ["docs/readme.md", "src/a.ts", "src/b.py"]);
    assert.deepEqual(
      discovery.indexable.map((file) => [file.path, file.lang]),
      [
        ["src/a.ts", "typescript"],
        ["src/b.py", "python"],
      ],
    );
    assert.deepEqual(discovery.byLanguage, { typescript: 1, python: 1 });
    assert.equal(discovery.truncated, false);
  });

  test("文件数超过上限时 marked truncated（但不报错）", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) files[`src/f${index}.ts`] = "export {};\n";
    const dir = await makeDir(files);
    const discovery = await discoverFiles(dir, { maxFiles: 5 });
    assert.equal(discovery.all.length, 5);
    assert.equal(discovery.truncated, true);
  });

  test(".tsx 走 TSX 语法（不能退回 TypeScript，否则 JSX 是语法错误）", async () => {
    const dir = await makeDir({ "src/App.tsx": "export const App = () => <div />;\n" });
    const discovery = await discoverFiles(dir);
    assert.equal(discovery.indexable[0]?.lang, "tsx");
  });
});

describe("worker 往返（真子进程 + 真 wasm）", () => {
  test("1. 真实解析：符号与候选都从 worker 的 stdout 回来了", async () => {
    const dir = await makeDir({
      "src/sample.ts": await readFile(`${FIXTURES}sample.ts`, "utf8"),
      "src/notes.md": "# 不是源文件\n",
    });
    const discovery = await discoverFiles(dir);
    const outcome = await parseBatch({ root: dir, files: discovery.indexable, vendorDir: VENDOR });
    assert.equal(outcome.crashed, false);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.exitCode, 0);
    const file = outcome.files[0]!;
    assert.equal(file.path, "src/sample.ts");
    assert.equal(file.status, "ok");
    assert.deepEqual(
      file.symbols.map((symbol) => symbol.name),
      ["RouteContext", "Handler", "Router", "constructor", "add", "dispatch", "createRouter", "defaultRouter"],
    );
    assert.ok(file.identifiers.includes("Router"), "候选标识符要一起回来");
  });

  test("6. 超过体积上限的文件被跳过（状态 too_large），不影响其他文件", async () => {
    const dir = await makeDir({
      "src/small.ts": "export function small() {}\n",
      "src/huge.ts": `export function huge() {}\n${"// 填充\n".repeat(100)}`,
    });
    const discovery = await discoverFiles(dir);
    const outcome = await parseBatch({ root: dir, files: discovery.indexable, vendorDir: VENDOR, maxFileBytes: 60 });
    const byPath = new Map(outcome.files.map((file) => [file.path, file]));
    assert.equal(byPath.get("src/huge.ts")?.status, "too_large");
    assert.equal(byPath.get("src/huge.ts")?.symbols.length, 0);
    assert.equal(byPath.get("src/small.ts")?.status, "ok");
    assert.equal(outcome.crashed, false);
  });

  test("6. 文件在扫描与解析之间消失了 → 只影响它自己（unreadable）", async () => {
    // 真实来源：扫描之后跑了一次 checkout。主进程把两件事实都告诉 worker：一个真文件、一个不存在的文件。
    const dir = await makeDir({ "src/ok.ts": "export function ok() {}\n" });
    const discovery = await discoverFiles(dir);
    const outcome = await parseBatch({
      root: dir,
      files: [...discovery.indexable, { path: "src/vanished.ts", lang: "typescript" }],
      vendorDir: VENDOR,
    });
    const byPath = new Map(outcome.files.map((file) => [file.path, file]));
    assert.equal(byPath.get("src/ok.ts")?.status, "ok");
    assert.equal(byPath.get("src/vanished.ts")?.status, "unreadable");
    assert.equal(outcome.crashed, false);
  });

  test("6. worker 中途崩掉 → crashed=true，主进程活着，已收到的结果还在", async () => {
    const dir = await makeDir({ "src/a.ts": "export function a() {}\n" });
    const discovery = await discoverFiles(dir);
    const badWorker = await makeDir({
      "worker.mjs": 'process.stdout.write("这不是 JSON\\n");\nprocess.exit(3);\n',
    });
    const outcome = await parseBatch({
      root: dir,
      files: discovery.indexable,
      vendorDir: VENDOR,
      workerPath: path.join(badWorker, "worker.mjs"),
    });
    assert.equal(outcome.crashed, true);
    assert.equal(outcome.exitCode, 3);
    assert.deepEqual(outcome.files, []);
    // 主进程仍然能正常干下一件事（这条断言是"不阻塞 Run"的最小证据）。
    assert.equal((await discoverFiles(dir)).indexable.length, 1);
  });

  test("6. worker 什么都不发就退出（没有 done）也算崩溃", async () => {
    const dir = await makeDir({ "src/a.ts": "export function a() {}\n" });
    const discovery = await discoverFiles(dir);
    const quiet = await makeDir({ "worker.mjs": "process.exit(0);\n" });
    const outcome = await parseBatch({
      root: dir,
      files: discovery.indexable,
      vendorDir: VENDOR,
      workerPath: path.join(quiet, "worker.mjs"),
    });
    assert.equal(outcome.crashed, true);
  });

  test("6. 总预算到了就硬杀，已收的结果保留（timedOut=true）", async () => {
    const dir = await makeDir({ "src/a.ts": "export function a() {}\n" });
    const discovery = await discoverFiles(dir);
    // 一个"只输出一条 file 消息就睡下去"的 worker：主进程必须在预算之后杀它。
    const sleeper = await makeDir({
      "worker.mjs": [
        'process.stdout.write(JSON.stringify({ type: "file", path: "src/a.ts", lang: "typescript", status: "ok",',
        '  symbols: [{ name: "a", kind: "function", signature: "export function a()", startLine: 1, endLine: 1 }],',
        '  identifiers: [], imports: [], durationMs: 1, bytes: 1, error: null }) + "\\n");',
        "await new Promise((resolve) => setTimeout(resolve, 60000));",
        "",
      ].join("\n"),
    });
    const outcome = await parseBatch({
      root: dir,
      files: discovery.indexable,
      vendorDir: VENDOR,
      workerPath: path.join(sleeper, "worker.mjs"),
      totalBudgetMs: 300,
      killGraceMs: 100,
    });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.files.length, 1, "杀之前收到的结果仍然可用");
    assert.equal(outcome.files[0]?.symbols[0]?.name, "a");
  });
});

describe("worker 的参数与环境", () => {
  test("parseWorkerArgs 解析命令行", () => {
    const options = parseWorkerArgs(["--vendor", "/tmp/x", "--per-file-ms", "5", "--max-file-bytes", "9", "--timeout-ms", "7"]);
    assert.deepEqual(options, { vendorDir: "/tmp/x", perFileBudgetMs: 5, maxFileBytes: 9, timeoutMs: 7 });
    const defaults = parseWorkerArgs([]);
    assert.equal(defaults.perFileBudgetMs, PER_FILE_BUDGET_MS);
    assert.equal(defaults.timeoutMs, TOTAL_BUDGET_MS);
    assert.ok(defaults.vendorDir.endsWith(`${path.sep}vendor${path.sep}tree-sitter${path.sep}`.replace("${path.sep}", path.sep)));
  });

  test("worker 的 env 白名单里没有凭据类变量", () => {
    const saved = { ...process.env };
    try {
      process.env.DATABASE_URL = "postgres://secret";
      process.env.DEEPSEEK_API_KEY = "sk-secret";
      process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN";
      const env = workerEnv();
      assert.deepEqual(
        Object.keys(env).sort(),
        ["HOME", "PATH", "TMPDIR"].filter((key) => saved[key] !== undefined).sort(),
      );
      assert.equal(env.DATABASE_URL, undefined);
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
    } finally {
      for (const key of ["DATABASE_URL", "DEEPSEEK_API_KEY", "GITHUB_APP_PRIVATE_KEY"]) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("预算常量", () => {
  test("与 spec §6 一致（90s / 200ms / 1 MiB）", async () => {
    const parse = await import("../../src/index/parse.ts");
    assert.equal(TOTAL_BUDGET_MS, 90_000);
    assert.equal(PER_FILE_BUDGET_MS, 200);
    assert.equal(parse.MAX_FILE_BYTES, 1024 * 1024);
    assert.equal(parse.WORKER_MAX_OLD_SPACE_MB, 1024);
  });
});
