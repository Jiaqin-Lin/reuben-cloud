/**
 * Phase 8 的持久层集成测试（`npm run test:integration`，**需要一个一次性 Postgres 容器**）。
 *
 * 【为什么不进 `npm test`】spec §0.5 是硬要求：`npm test` 永远不需要 Docker、不需要网络。
 * 这一组用例要真的 Postgres（CHECK 约束、SECURITY DEFINER 的权限模型、
 * `FOR UPDATE` 的并发语义都只有真库能回答），所以它们在这一层。
 *
 * 【它覆盖什么】spec Phase 8「测试要点」里所有与 DB 有关的条目：
 * 表结构与索引、合法/非法转换、审计轨迹、并发闸、`SET state` 被数据库拦住、
 * `executions.env_keys` 只存 key、`artifacts.kind` 约束、迁移幂等。
 * 对账 / 看门狗 / TTL 在 `manager.integration.test.ts`，真容器的全链路在
 * `sandbox-flow.integration.test.ts`。
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Db, isCheckViolation, isInsufficientPrivilege } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { insertArtifact, listArtifacts } from "../../src/db/artifacts.ts";
import { getExecution, listExecutions, recordExecution } from "../../src/db/executions.ts";
import {
  SANDBOX_STATES,
  currentStateOf,
  getSandbox,
  insertSandbox,
  listSandboxes,
  listTransitions,
  transition,
} from "../../src/db/sandboxes.ts";
import type { SandboxState } from "../../src/db/sandboxes.ts";
import { deleteSandboxRows, newSandboxId, startPostgres } from "../support.ts";
import type { TestPostgres } from "../support.ts";

let pg: TestPostgres;
let db: Db;

/** 造一个合法的 limits（与 provider 的缺省一致）。 */
const limits = { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 21_600 };

/** 插一行 CREATING，返回 id。 */
async function newSandbox(): Promise<string> {
  const id = newSandboxId();
  await insertSandbox(db, {
    id,
    runId: `run_${id}`,
    provider: "local-docker",
    image: `reuben-cloud/sandbox-base@sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    limits,
    workspaceVolume: `reuben-cloud-ws-${id}`,
  });
  return id;
}

before(async () => {
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
});

after(async () => {
  await db.close();
  await pg.stop();
});

describe("Phase 8 · 表结构与迁移", () => {
  test("三张业务表 + 一张审计表的列就是 §G 说的那些", async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY ($1::text[])
        ORDER BY table_name, ordinal_position`,
      [["sandboxes", "executions", "artifacts", "sandbox_state_transitions"]],
    );
    const columns = new Map<string, string[]>();
    for (const row of rows.rows) {
      columns.set(row.table_name, [...(columns.get(row.table_name) ?? []), row.column_name]);
    }
    assert.deepEqual(columns.get("sandboxes"), [
      "id", "task_id", "run_id", "provider", "provider_ref", "endpoint", "auth_token",
      "image", "image_digest", "state", "state_reason", "limits", "workspace_volume",
      "last_active_at", "created_at", "ready_at", "destroyed_at",
    ]);
    assert.deepEqual(columns.get("executions"), [
      "id", "sandbox_id", "run_id", "cmd", "cwd", "env_keys", "state", "reason", "exit_code",
      "stdout_bytes", "stderr_bytes", "truncated", "log_path", "started_at", "ended_at",
    ]);
    assert.deepEqual(columns.get("artifacts"), [
      "id", "run_id", "sandbox_id", "kind", "object_key", "size_bytes", "sha256", "created_at",
    ]);
    assert.deepEqual(columns.get("sandbox_state_transitions"), [
      "id", "sandbox_id", "from_state", "to_state", "reason", "at",
    ]);
  });

  test("§G 要求的三类查询索引都在", async () => {
    const rows = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
    );
    const names = rows.rows.map((row) => row.indexname);
    for (const expected of [
      "sandboxes_state_active_idx",
      "sandboxes_run_idx",
      "sandboxes_provider_ref_idx",
      "executions_sandbox_idx",
      "artifacts_run_idx",
      "sandbox_state_transitions_sandbox_idx",
    ]) {
      assert.ok(names.includes(expected), `缺少索引 ${expected}（现有：${names.join(", ")}）`);
    }
  });

  test("migration 幂等：第二次跑什么都不做", async () => {
    const report = await runMigrations(db);
    assert.deepEqual(report.applied, []);
    assert.ok(report.skipped.length >= 2, `应该有至少两个已应用的迁移，实际 ${report.skipped.length}`);
  });

  test("CHECK 约束挡住非法状态与非法 kind", async () => {
    const id = newSandboxId();
    await assert.rejects(
      db.query(
        `INSERT INTO sandboxes (id, provider, image, image_digest, state, limits)
         VALUES ($1, 'p', 'i', 'd', 'NOPE', '{}')`,
        [id],
      ),
      (error: unknown) => isCheckViolation(error),
    );
    await assert.rejects(
      db.query(
        `INSERT INTO artifacts (id, kind, object_key, size_bytes, sha256)
         VALUES ($1, 'bogus', 'k', 1, 'a')`,
        [`art_${id}`],
      ),
      (error: unknown) => isCheckViolation(error),
    );
  });
});

describe("Phase 8 · transition() 状态机", () => {
  test("用例 1：合法转换全路径 + 每条都留下审计行", async () => {
    const id = await newSandbox();
    try {
      const toReady = await transition(db, id, ["CREATING"], "READY", "create_ready", {
        endpoint: "http://127.0.0.1:8080",
        auth_token: "tok",
        ready_at: new Date(),
      });
      assert.deepEqual(toReady, { ok: true, from: "CREATING" });

      const toBusy = await transition(db, id, ["READY"], "BUSY", "exec_started", {
        last_active_at: new Date(),
      });
      assert.deepEqual(toBusy, { ok: true, from: "READY" });

      const toReadyAgain = await transition(db, id, ["BUSY"], "READY", "exec_finished");
      assert.deepEqual(toReadyAgain, { ok: true, from: "BUSY" });

      const toDestroyed = await transition(db, id, ["READY"], "DESTROYED", "destroyed", {
        destroyed_at: new Date(),
      });
      assert.deepEqual(toDestroyed, { ok: true, from: "READY" });

      const row = await getSandbox(db, id);
      assert.equal(row?.state, "DESTROYED");
      assert.equal(row?.state_reason, "destroyed");
      assert.ok(row?.destroyed_at instanceof Date);
      assert.equal(row?.endpoint, "http://127.0.0.1:8080");

      // 轨迹：NULL→CREATING（创建那条）+ 四次转换
      const trail = await listTransitions(db, id);
      assert.deepEqual(
        trail.map((t) => [t.from_state, t.to_state, t.reason]),
        [
          [null, "CREATING", "created"],
          ["CREATING", "READY", "create_ready"],
          ["READY", "BUSY", "exec_started"],
          ["BUSY", "READY", "exec_finished"],
          ["READY", "DESTROYED", "destroyed"],
        ],
      );
    } finally {
      await deleteSandboxRows(db, [id]);
    }
  });

  test("用例 2：非法转换被拒，并返回当前状态", async () => {
    const id = await newSandbox();
    try {
      await transition(db, id, ["CREATING"], "READY", "create_ready");

      // ① 期望落空：调用方以为行是 DESTROYED，实际是 READY。
      assert.deepEqual(await transition(db, id, ["DESTROYED"], "BUSY", "nope"), {
        ok: false,
        current: "READY",
      });
      // ② 边不存在：状态对得上（READY），但 §D 的状态机里没有 READY→CREATING。
      const illegal = await transition(db, id, ["READY"], "CREATING", "nope");
      assert.deepEqual(illegal, { ok: false, current: "READY", illegal: true });
      assert.equal(currentStateOf(illegal), "READY");
      // ③ DESTROYED 是终态：没有出边。
      await transition(db, id, ["READY"], "DESTROYED", "destroyed");
      assert.deepEqual(await transition(db, id, ["DESTROYED"], "BUSY", "nope"), {
        ok: false,
        current: "DESTROYED",
        illegal: true,
      });
      assert.deepEqual(await transition(db, id, ["DESTROYED"], "DESTROYED", "again"), {
        ok: false,
        current: "DESTROYED",
        illegal: true,
      });
      // 被拒的三次一个字节也没改（审计里只有创建 + 两次真实转换）
      assert.deepEqual(
        (await listTransitions(db, id)).map((t) => [t.from_state, t.to_state]),
        [
          [null, "CREATING"],
          ["CREATING", "READY"],
          ["READY", "DESTROYED"],
        ],
      );
      // 行不存在 → missing（与"状态不对"分开）
      assert.deepEqual(await transition(db, "sbx_does_not_exist", ["READY"], "BUSY", "x"), {
        ok: false,
        missing: true,
      });
    } finally {
      await deleteSandboxRows(db, [id]);
    }
  });

  test("并发闸：两个 READY→BUSY 只有一个成功（FOR UPDATE 的语义）", async () => {
    const id = await newSandbox();
    try {
      await transition(db, id, ["CREATING"], "READY", "create_ready");
      const results = await Promise.all([
        transition(db, id, ["READY"], "BUSY", "exec_started"),
        transition(db, id, ["READY"], "BUSY", "exec_started"),
        transition(db, id, ["READY"], "BUSY", "exec_started"),
      ]);
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal((await getSandbox(db, id))?.state, "BUSY");
      // 失败的那些要能拿到当前状态（调用方转 409 的依据）
      for (const result of results.filter((item) => !item.ok)) {
        assert.equal(currentStateOf(result), "BUSY");
      }
      // 一次成功的转换只写一条审计行
      assert.equal((await listTransitions(db, id)).filter((t) => t.reason === "exec_started").length, 1);
    } finally {
      await deleteSandboxRows(db, [id]);
    }
  });

  test("补丁只认同白名单里的列：state / id 改不动，未知键被忽略", async () => {
    const id = await newSandbox();
    try {
      const result = await transition(db, id, ["CREATING"], "READY", "create_ready", {
        // @ts-expect-error —— 这几行是**故意**的同谋：类型层不允许，运行时也必须是 no-op
        state: "DESTROYED",
        id: "sbx_hacked",
        created_at: new Date(0),
        bogus_column: 1,
        limits: { ...limits, cpu: 4 },
      });
      assert.deepEqual(result, { ok: true, from: "CREATING" });
      const row = await getSandbox(db, id);
      assert.equal(row?.state, "READY");
      assert.equal(row?.id, id);
      assert.equal(row?.limits.cpu, 4, "白名单里的列应该被应用");
    } finally {
      await deleteSandboxRows(db, [id]);
    }
  });

  test("listSandboxes 能按状态与 id 过滤", async () => {
    const ready = await newSandbox();
    const creating = await newSandbox();
    try {
      await transition(db, ready, ["CREATING"], "READY", "create_ready");
      const onlyReady = await listSandboxes(db, { states: ["READY"], ids: [ready, creating] });
      assert.deepEqual(onlyReady.map((row) => row.id), [ready]);
      const both = await listSandboxes(db, { ids: [ready, creating] });
      assert.deepEqual(new Set(both.map((row) => row.id)), new Set([ready, creating]));
      assert.deepEqual(
        both.map((row) => row.state),
        both.map((row) => (row.id === ready ? "READY" : "CREATING")),
      );
    } finally {
      await deleteSandboxRows(db, [ready, creating]);
    }
  });
});

describe("Phase 8 · 数据库真的会拦（不是靠自觉）", () => {
  test("应用角色直接 UPDATE state 被拒；走函数、改别的列、插入都没问题", async () => {
    const id = await newSandbox();
    const other = newSandboxId();
    try {
      await db.withTransaction(async (tx) => {
        await tx.query("SAVEPOINT sp");
        await tx.query("SET LOCAL ROLE reuben_cloud_app");

        // ① 直接改 state：permission denied（这就是 SECURITY DEFINER 的意义）
        await assert.rejects(
          tx.query("UPDATE sandboxes SET state = 'DESTROYED' WHERE id = $1", [id]),
          (error: unknown) => {
            assert.ok(isInsufficientPrivilege(error), `期望权限错误，实际：${String(error)}`);
            return true;
          },
        );
        // 回滚到存点：事务被上面那条错误中止了，SET LOCAL ROLE 也一起回滚。
        await tx.query("ROLLBACK TO SAVEPOINT sp");
        await tx.query("SET LOCAL ROLE reuben_cloud_app");

        // ② 非 state 列可以直接改（业务代码要落 endpoint / last_active_at）
        await tx.query("UPDATE sandboxes SET endpoint = 'http://127.0.0.1:9' WHERE id = $1", [id]);
        // ③ state_reason 也在授权列表里
        await tx.query("UPDATE sandboxes SET state_reason = 'manual' WHERE id = $1", [id]);
        // ④ 通过函数改 state：可以（函数以属主身份跑）
        const moved = await tx.query<{ result: Record<string, unknown> }>(
          "SELECT sandbox_transition($1::text, $2::text[], $3::text, $4::text, $5::jsonb) AS result",
          [id, ["CREATING"], "READY", "create_ready", "{}"],
        );
        assert.equal(moved.rows[0]!.result["ok"], true);
        // ⑤ 插入新行与审计行：可以
        await tx.query(
          `INSERT INTO sandboxes (id, provider, image, image_digest, state, limits)
           VALUES ($1, 'local-docker', 'i@sha256:aa', 'sha256:aa', 'CREATING', '{}')`,
          [other],
        );
        await tx.query(
          `INSERT INTO sandbox_state_transitions (sandbox_id, from_state, to_state, reason)
           VALUES ($1, NULL, 'CREATING', 'created')`,
          [other],
        );
        // ⑥ DELETE：没有授权（沙箱行与审计行都是只增不删的）
        await tx.query("SAVEPOINT sp2");
        await assert.rejects(
          tx.query("DELETE FROM sandboxes WHERE id = $1", [other]),
          (error: unknown) => isInsufficientPrivilege(error),
        );
        await tx.query("ROLLBACK TO SAVEPOINT sp2");
      });

      // 事务最后 ROLLBACK 了吗？没有——withTransaction 正常结束会 COMMIT。
      // 所以这里断言的是"允许的那几条真的写进去了"。
      const row = await getSandbox(db, id);
      assert.equal(row?.state, "READY");
      assert.equal(row?.endpoint, "http://127.0.0.1:9");
      assert.equal(row?.state_reason, "create_ready", "① 直改 state_reason 的 'manual' 会被 ④ 覆盖成本次 reason");
      const second = await getSandbox(db, other);
      assert.equal(second?.state, "CREATING");
    } finally {
      await deleteSandboxRows(db, [id, other]);
    }
  });

  test("superuser（属主）当然能直改 state —— 权限模型只对应用角色生效", async () => {
    const id = await newSandbox();
    try {
      const row = await db.query("SELECT current_user FROM sandboxes LIMIT 1");
      assert.equal(row.rows[0]?.current_user, "postgres");
      await db.query("UPDATE sandboxes SET state = 'READY' WHERE id = $1", [id]);
      assert.equal((await getSandbox(db, id))?.state, "READY");
    } finally {
      await deleteSandboxRows(db, [id]);
    }
  });
});

describe("Phase 8 · executions 与 artifacts", () => {
  test("env_keys 只存 key 名，值一个字都不进 DB", async () => {
    const id = await newSandbox();
    const executionId = `exe_${Date.now()}`;
    try {
      const env = { HTTP_PROXY: "http://reuben-cloud-proxy:3128", SECRETISH: "should-not-land" };
      await recordExecution(db, {
        id: executionId,
        sandboxId: id,
        runId: "run_1",
        cmd: ["bash", "-lc", "echo hi"],
        cwd: "/workspace",
        envKeys: Object.keys(env),
        state: "completed",
        exitCode: 0,
        stdoutBytes: 3,
        stderrBytes: 0,
        logPath: `/tmp/reuben-cloud/exec/${executionId}.log`,
        endedAt: new Date(),
      });
      const row = await getExecution(db, executionId);
      assert.deepEqual(row?.env_keys, ["HTTP_PROXY", "SECRETISH"]);
      assert.ok(!JSON.stringify(row).includes("should-not-land"), "env 的值泄漏进了 DB");
      assert.equal(row?.exit_code, 0);
      assert.equal(row?.stdout_bytes, 3);
      assert.deepEqual(row?.cmd, ["bash", "-lc", "echo hi"]);

      // 形状不对的 key 会被挡在插入之前（不是写进 DB 再被 CHECK 抓住）
      await assert.rejects(
        recordExecution(db, {
          id: `exe_bad_${Date.now()}`,
          sandboxId: id,
          cmd: ["true"],
          envKeys: ["HTTP_PROXY=http://leak"],
          state: "completed",
        }),
        /env_keys/,
      );
      // 同一个 id 写两次是幂等的（对账补记录 + 正常路径可能重叠）
      await recordExecution(db, {
        id: executionId,
        sandboxId: id,
        cmd: ["bash", "-lc", "echo hi"],
        state: "killed",
        reason: "cp_restart",
        endedAt: new Date(),
      });
      const updated = await getExecution(db, executionId);
      assert.equal(updated?.state, "killed");
      assert.equal(updated?.reason, "cp_restart");
      assert.equal((await listExecutions(db, { sandboxId: id })).length, 1);
    } finally {
      await deleteSandboxRows(db, [id]);
    }
  });

  test("executions 必须有对应的沙箱行（外键）", async () => {
    await assert.rejects(
      recordExecution(db, {
        id: `exe_orphan_${Date.now()}`,
        sandboxId: "sbx_does_not_exist",
        cmd: ["true"],
        state: "completed",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "23503", "期望外键违反");
        return true;
      },
    );
  });

  test("artifacts 三种 kind 都能落，非法 kind 被 CHECK 挡住", async () => {
    const id = await newSandbox();
    try {
      const kinds = ["diff", "workspace_archive", "exec_log"] as const;
      for (const [index, kind] of kinds.entries()) {
        await insertArtifact(db, {
          id: `art_${Date.now()}_${index}`,
          runId: "run_1",
          sandboxId: id,
          kind,
          objectKey: `runs/run_1/${kind}`,
          sizeBytes: 1024 + index,
          sha256: "b".repeat(64),
        });
      }
      const rows = await listArtifacts(db, { sandboxId: id });
      assert.deepEqual(
        rows.map((row) => row.kind).sort(),
        [...kinds].sort(),
      );
      assert.equal(rows[0]?.size_bytes, 1026);
    } finally {
      await deleteSandboxRows(db, [id]);
      await db.query("DELETE FROM artifacts WHERE sandbox_id = $1", [id]);
    }
  });
});

describe("Phase 8 · 状态集合", () => {
  test("五个状态就是 §D 那五个（没有 PAUSED 之类）", () => {
    assert.deepEqual([...SANDBOX_STATES], ["CREATING", "READY", "BUSY", "ERROR", "DESTROYED"]);
    const asStates: SandboxState[] = [...SANDBOX_STATES];
    assert.equal(asStates.length, 5);
  });
});
