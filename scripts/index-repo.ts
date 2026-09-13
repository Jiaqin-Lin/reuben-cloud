/**
 * P8 · 手工验收：给一个本地仓库（clone）建一次索引。
 *
 * 这不是产品代码，是把已经存在的零件按生产顺序串起来的一次性驱动——与 `agent:run` / `env:build`
 * 同一个定位。它比集成测试多出来的只有三件：**真的连本地 Postgres**（看得见 repo_indexes /
 * repo_symbols / repo_refs 的变化）、**真的读 .env**、以及**可以反复跑**（增量判定与保留策略
 * 都是"跑第二次才看得出来"的行为）。
 *
 * 【为什么要 --dry-run】验收标准里有"能回答某个符号定义在哪几个文件里"，但改代码的时候更常问的是
 * "这个仓库解析出来长什么样"。`--dry-run` 不连库，只跑发现 + 解析 + 算边并把结果打出来，
 * 所以在没有 `dev:up` 的机器上也能用（CI 之外的一台干净机器上第一次验证就走这条路）。
 *
 * 【用法】
 *   npm run dev:up && export DATABASE_URL=$(npm run --silent db:url)
 *   npm run index:repo -- --local ~/code/my-project                    # 建/更新索引（第二次是增量）
 *   npm run index:repo -- --local ~/code/my-project --rebuild          # 强制全量
 *   npm run index:repo -- --local ~/code/my-project --dry-run --top 20 # 不连库，打印解析结果
 *   npm run index:repo -- --local ~/code/my-project --commit <sha>     # 指定要索引的快照
 */

import path from "node:path";
import process from "node:process";
import { Db, resolveDatabaseUrl } from "../packages/control-plane/src/db/client.ts";
import { runMigrations } from "../packages/control-plane/src/db/migrate.ts";
import { consoleLog } from "../packages/control-plane/src/log.ts";
import { indexRepository } from "../packages/control-plane/src/index/indexer.ts";
import { discoverFiles, parseBatch } from "../packages/control-plane/src/index/parse.ts";
import { computeEdges } from "../packages/control-plane/src/index/refs.ts";
import { postgresRepoIndexStore, listRepoSymbols } from "../packages/control-plane/src/index/store.ts";
import { VENDOR_TREE_SITTER_DIR } from "../packages/control-plane/src/index/vendor.ts";
import { runGit } from "../packages/control-plane/src/repo/git.ts";

const log = consoleLog("index");

interface Args {
  local: string | null;
  repo: string | null;
  commit: string | null;
  rebuild: boolean;
  dryRun: boolean;
  top: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { local: null, repo: null, commit: null, rebuild: false, dryRun: false, top: 10, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    switch (token) {
      case "--local":
        args.local = argv[++index] ?? null;
        break;
      case "--repo":
        args.repo = argv[++index] ?? null;
        break;
      case "--commit":
        args.commit = argv[++index] ?? null;
        break;
      case "--rebuild":
        args.rebuild = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--top":
        args.top = Number(argv[++index] ?? "10");
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`无法识别的参数：${token}`);
    }
  }
  if (args.local === null) throw new Error("必须给 --local <path>（要索引的仓库目录）");
  return args;
}

/**
 * `owner/name`：优先 `--repo`，其次 clone 自己的 origin，最后退回目录名。
 *
 * 【为什么值得读一次 remote】`repo_key` 是索引的键：本地手工跑一次用了目录名，
 * 而生产里用的是 `owner/name`，那两次索引就会变成两份互不相干的数据。
 * 读得出来就用真的那个（读不出来——没有 remote、不是 git 仓库——才退回目录名）。
 */
async function repoKeyOf(dir: string, explicit: string | null): Promise<string> {
  if (explicit !== null) return explicit;
  const result = await runGit(["remote", "get-url", "origin"], { cwd: dir }).catch(() => null);
  const remote = result !== null && result.code === 0 ? result.stdout.toString("utf8").trim() : "";
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return match === null ? path.basename(path.resolve(dir)) : `${match[1]}/${match[2]}`;
}

async function dryRun(args: Args): Promise<void> {
  const root = path.resolve(args.local!);
  const discovery = await discoverFiles(root);
  const outcome = await parseBatch({ root, files: discovery.indexable, vendorDir: VENDOR_TREE_SITTER_DIR, log });
  const symbols = outcome.files
    .filter((file) => file.status === "ok")
    .flatMap((file) => file.symbols.map((symbol) => ({ ...symbol, path: file.path })));
  const edges = computeEdges({
    files: discovery.indexable.map((file) => file.path),
    symbols: outcome.files
      .filter((file) => file.status === "ok")
      .map((file) => ({ path: file.path, symbols: file.symbols })),
    candidates: outcome.files
      .filter((file) => file.status === "ok")
      .map((file) => ({ path: file.path, refs: { identifiers: file.identifiers, imports: file.imports } })),
  });
  if (args.json) {
    console.log(JSON.stringify({ languages: discovery.byLanguage, symbols: symbols.length, edges, files: outcome.files }, null, 2));
    return;
  }
  log("info", "dry-run 结果", {
    files: discovery.all.length,
    indexable: discovery.indexable.length,
    languages: discovery.byLanguage,
    symbols: symbols.length,
    edges: edges.length,
    parseMs: outcome.parseMs,
    wallMs: outcome.wallMs,
    timedOut: outcome.timedOut,
    crashed: outcome.crashed,
  });
  console.log(`\n前 ${args.top} 个符号（按文件路径与行号）：`);
  for (const symbol of symbols.slice(0, args.top)) {
    console.log(`  ${symbol.path}:${symbol.startLine}  ${symbol.kind.padEnd(9)} ${symbol.name.padEnd(20)} ${symbol.signature}`);
  }
  console.log(`\n前 ${args.top} 条边：`);
  for (const edge of edges.slice(0, args.top)) {
    console.log(`  ${edge.fromPath} → ${edge.toPath}  [${edge.symbol}] w=${edge.weight}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) {
    await dryRun(args);
    return 0;
  }

  const repoKey = await repoKeyOf(args.local!, args.repo);
  const db = new Db({ connectionString: resolveDatabaseUrl(), log });
  try {
    await runMigrations(db, { log });
    const result = await indexRepository({
      repoKey,
      commitSha: args.commit ?? undefined,
      cloneDir: path.resolve(args.local!),
      store: postgresRepoIndexStore(db),
      vendorDir: VENDOR_TREE_SITTER_DIR,
      rebuild: args.rebuild,
      log,
    });
    if (result === null) {
      log("error", "索引没有完成（看上面的 warn/error）", { repoKey });
      return 1;
    }
    console.log(
      [
        `\n索引：${result.repoKey}@${result.commitSha.slice(0, 12)}`,
        `  模式      ${result.mode}${result.previousCommitSha === null ? "" : `（基准 ${result.previousCommitSha.slice(0, 12)}）`}`,
        `  状态      ${result.status}${result.error === null ? "" : `（${result.error}）`}`,
        `  文件      ${result.files}（这次解析了 ${result.parsedFiles} 个）`,
        `  语言      ${JSON.stringify(result.languages)}`,
        `  符号/边   ${result.symbols} / ${result.edges}`,
        `  耗时      ${result.durationMs}ms`,
      ].join("\n"),
    );

    // 验收标准里那句"能回答某个符号定义在哪几个文件里"——顺手打几个高频符号让这条可眼见。
    const symbols = await listRepoSymbols(db, result.repoKey, result.commitSha);
    const byName = new Map<string, string[]>();
    for (const symbol of symbols) {
      const files = byName.get(symbol.name) ?? [];
      if (!files.includes(symbol.path)) files.push(symbol.path);
      byName.set(symbol.name, files);
    }
    if (args.top > 0) {
      console.log(`\n定义在多个文件里的名字（前 ${args.top} 个，供交叉验证）：`);
      const shared = [...byName.entries()].filter(([, files]) => files.length > 1).slice(0, args.top);
      if (shared.length === 0) console.log("  （没有同名定义）");
      for (const [name, files] of shared) console.log(`  ${name.padEnd(20)} ${files.join(", ")}`);
    }
    return 0;
  } finally {
    await db.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[index:error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
