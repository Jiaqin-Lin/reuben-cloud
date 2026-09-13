/**
 * "工具调用停在 intent 的 CP" —— `session-store.integration.test.ts` 的夹具，**不是测试文件**。
 *
 * 【它做什么】连上测试用的 Postgres，给父测试准备的会话开一次执行、写一条工具 intent
 * （模拟"命令刚开始跑"），把 runId / invocationId 打到 stdout，然后**挂着不退出**。
 * 父测试读到那一行之后 SIGKILL 掉它。
 *
 * 【为什么必须是独立进程】spec P2 测试要点 4 要的是"kill -9 之后，那条 intent 还在、
 * args 还能查到"。同一个进程里假装这件事只能测到"我没写结算"——测不到"崩溃时的提交
 * 到底落了没有"。真 SIGKILL 才能给出这个答案（phase 8 的 `dangling-cp.ts` 同一条理由）。
 *
 * 【它不清理】故意不清理：留下的行正是父测试要断言的东西。
 */

import process from "node:process";
import { Db, resolveDatabaseUrl } from "../../../src/db/client.ts";
import { entryForMessage } from "@reuben-cloud/agent-runtime";
import { PostgresSessionStore } from "../../../src/session/postgres.ts";

const sessionId = process.env["RC_TEST_SESSION_ID"];
if (sessionId === undefined || sessionId === "") {
  throw new Error("夹具需要 RC_TEST_SESSION_ID");
}

const db = new Db({ connectionString: resolveDatabaseUrl() });
const store = new PostgresSessionStore(db);

const runId = await store.startRun({
  sessionId,
  startEntryId: null,
  provider: "anthropic",
  model: "claude-opus-4-8",
});
await store.appendEntry(sessionId, runId, entryForMessage({ role: "user", content: "跑一条很长的命令" }));
const invocationId = await store.beginToolInvocation({
  sessionId,
  runId,
  turn: 1,
  sourceIndex: 0,
  tool: "bash",
  // args 要能被父测试原样读回来（spec：重启后"能查到 args"）。
  args: { command: "sleep 600", cwd: "/workspace/repo" },
  replay: "never",
});

process.stdout.write(`${JSON.stringify({ runId, invocationId })}\n`);

// 挂着等 SIGKILL。这条"没有结算"的 intent 就是要留下的证据。
setInterval(() => undefined, 1000);
