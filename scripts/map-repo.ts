/**
 * P9 · 手工验收：给一个本地 clone 渲染一次 Repo Map。
 *
 * 与 `index:repo` / `env:build` / `agent:run` 同一个定位：不是产品代码，是把已经存在的零件按
 * 生产顺序串起来的一次性驱动。它比单测多出来的只有三件：**真的连本地 Postgres**（看得见
 * `repo_maps` 的变化）、**真的读 .env**、以及**一张能肉眼看的图**（"这个仓库的排名长什么样"是
 * 只有看了才知道的事）。
 *
 * 【为什么默认顺手建索引】验收标准是"地图里包含 issue 涉及的模块"，而地图的前置是
 * `(repo, commit)` 上有一份 ready 的索引。让手工验收变成两步（先 index:repo 再 map:repo）
 * 只会让人漏掉第二步然后看到一棵文件树。`indexRepository` 是幂等的（同一个 commit 直接 skipped），
 * 所以这一步的代价接近零；要完全跳过就 `--no-index`。
 *
 * 【用法】
 *   npm run dev:up && export DATABASE_URL=$(npm run --silent db:url)
 *   npm run map:repo -- --local ~/code/my-project --issue-file /tmp/issue.md
 *   npm run map:repo -- --local ~/code/my-project --issue-file /tmp/issue.md --budget 800
 *   npm run map:repo -- --local ~/code/my-project --changed src/a.ts,src/b.ts   # 看"已改动"那一行
 *   npm run map:repo -- --local ~/code/my-project --rebuild --out /tmp/map.txt   # 忽略缓存并落文件
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Db, resolveDatabaseUrl } from "../packages/control-plane/src/db/client.ts";
import { runMigrations } from "../packages/control-plane/src/db/migrate.ts";
import { consoleLog } from "../packages/control-plane/src/log.ts";
import { indexRepository } from "../packages/control-plane/src/index/indexer.ts";
import { discoverFiles } from "../packages/control-plane/src/index/parse.ts";
import { buildRepoMap } from "../packages/control-plane/src/index/repo-map.ts";
import { repoKeyOf } from "../packages/control-plane/src/index/repo-key.ts";
import { getRepoIndex, postgresRepoIndexStore, postgresRepoMapStore } from "../packages/control-plane/src/index/store.ts";
import { DEFAULT_BUDGET_TOKENS } from "../packages/control-plane/src/index/render.ts";
import { gitIndexPort } from "../packages/control-plane/src/index/git-port.ts";

const log = consoleLog("map");

interface Args {
  local: string | null;
  repo: string | null;
  commit: string | null;
  issueFile: string | null;
  budget: number;
  changed: string[];
  rebuild: boolean;
  noIndex: boolean;
  out: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    local: null,
    repo: null,
    commit: null,
    issueFile: null,
    budget: DEFAULT_BUDGET_TOKENS,
    changed: [],
    rebuild: false,
    noIndex: false,
    out: null,
    json: false,
  };
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
      case "--issue-file":
        args.issueFile = argv[++index] ?? null;
        break;
      case "--budget":
        args.budget = Number(argv[++index] ?? DEFAULT_BUDGET_TOKENS);
        break;
      case "--changed":
        args.changed = (argv[++index] ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "");
        break;
      case "--rebuild":
        args.rebuild = true;
        break;
      case "--no-index":
        args.noIndex = true;
        break;
      case "--out":
        args.out = argv[++index] ?? null;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`无法识别的参数：${token}`);
    }
  }
  if (args.local === null) throw new Error("必须给 --local <path>（要渲染的仓库目录）");
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.local!);
  const repoKey = await repoKeyOf(root, args.repo);
  const git = gitIndexPort(root);
  const commitSha = args.commit ?? (await git.head()).trim();
  const task = args.issueFile === null ? "" : await readFile(args.issueFile, "utf8");
  if (args.issueFile !== null) log("info", `任务文本来自 ${args.issueFile}（${[...task].length} 字符）`);

  const db = new Db({ connectionString: resolveDatabaseUrl(), log });
  try {
    await runMigrations(db, { log });
    const store = postgresRepoIndexStore(db);

    // ---- 地图的前置：这个 commit 上有一份 ready 的索引（没有就顺手建一次）
    let indexRow = await getRepoIndex(db, repoKey, commitSha);
    if (indexRow === null || indexRow.status !== "ready") {
      if (args.noIndex) {
        log("warn", "没有可用的索引，按 --no-index 直接渲染文件树", { repoKey, status: indexRow?.status ?? null });
      } else {
        log("info", "这个 commit 还没有 ready 的索引，先建一次", { repoKey, commitSha });
        const indexed = await indexRepository({ repoKey, commitSha, cloneDir: root, store, log });
        if (indexed === null) log("warn", "索引没建出来，下面会渲染文件树");
        else log("info", "索引完成", { mode: indexed.mode, status: indexed.status, symbols: indexed.symbols, edges: indexed.edges });
        indexRow = await getRepoIndex(db, repoKey, commitSha);
      }
    }

    const files = (await discoverFiles(root)).all;
    const result = await buildRepoMap({
      repoKey,
      commitSha,
      task,
      changedFiles: args.changed,
      budgetTokens: args.budget,
      index: store,
      maps: postgresRepoMapStore(db),
      files,
      refresh: args.rebuild,
      log,
    });

    if (args.json) {
      console.log(JSON.stringify({ ...result, text: undefined, body: undefined }, null, 2));
    } else {
      console.log(
        [
          `\n地图：${result.repoKey}@${result.commitSha.slice(0, 12)}`,
          `  预算      ${result.budgetTokens} tokens`,
          `  来源      ${result.degraded === null ? "符号索引（PageRank + 个性化）" : `降级：${result.degraded}`}${result.cached ? "，命中缓存" : "，本次重算"}`,
          `  大小      ${result.tokens} tokens / ${result.files} 个文件${result.truncated === null ? "（缓存命中，截断情况未统计）" : result.truncated ? `（截断，还有 ${result.omittedFiles} 个文件没进）` : ""}`,
          `  命中符号  ${result.cached ? "（缓存命中，这次没重算）" : result.degraded !== null ? "（降级，没有个性化）" : result.matchedSymbols.length === 0 ? "（没有，退化成均匀分布）" : `${result.matchedSymbols.slice(0, 8).join(", ")}${result.matchedSymbols.length > 8 ? " …" : ""}`}`,
          `  排名      ${result.rank === null ? (result.degraded === null ? "（缓存命中，没重算）" : "（降级，没有排名）") : `${result.rank.nodes} 个节点、迭代 ${result.rank.iterations} 次${result.rank.converged ? "（收敛）" : "（到上限）"}`}`,
        ].join("\n"),
      );
    }

    console.log(`\n${result.text}\n`);
    if (args.out !== null) {
      await writeFile(path.resolve(args.out), `${result.text}\n`, "utf8");
      console.log(`已写入 ${path.resolve(args.out)}`);
    }
    return 0;
  } finally {
    await db.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[map:error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
