/**
 * `artifacts` 表：任务产出的凭证（§G.3 + A-8）。
 *
 * 【为什么归档必须落对象存储而不是留在沙箱】沙箱是易失的，销毁后容器和卷都没了；
 * 而归档的生命周期必须长于沙箱。这张表记的是"对象存储里那个东西的身份证"
 * （object_key + size + sha256），本体在 S3/MinIO —— Phase 10 才会有写入者。
 *
 * 【kind 三个取值】`diff` / `workspace_archive` / `exec_log`（第三个是 A-8 新增：
 * 被截断的执行日志在销毁前需要转存）。CHECK 约束与这个联合类型是同一份语义。
 *
 * 【什么时候写】只有上传成功之后才落行（三列都是 NOT NULL）：一行"指向不存在对象的
 * artifact"比没有这行更坏——它会让上层相信那份产出还在。Phase 10 的上传失败路径
 * 应该是"只有对象、没有行"（下一次对账/重跑可以覆盖），而不是反过来。
 */

import type { Queryable } from "./client.ts";
import { many, maybeOne } from "./client.ts";

export const ARTIFACT_KINDS = ["diff", "workspace_archive", "exec_log"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactRow {
  id: string;
  run_id: string | null;
  sandbox_id: string | null;
  kind: ArtifactKind;
  object_key: string;
  size_bytes: number;
  sha256: string;
  created_at: Date;
}

export interface InsertArtifactInput {
  /** `art_<ulid>`。 */
  id: string;
  runId?: string | null;
  sandboxId?: string | null;
  kind: ArtifactKind;
  /** S3/MinIO 路径。 */
  objectKey: string;
  sizeBytes: number;
  /** 十六进制 sha256（小写）。 */
  sha256: string;
}

export async function insertArtifact(q: Queryable, input: InsertArtifactInput): Promise<ArtifactRow> {
  const rows = await many<ArtifactRow>(
    q,
    `INSERT INTO artifacts (id, run_id, sandbox_id, kind, object_key, size_bytes, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.id,
      input.runId ?? null,
      input.sandboxId ?? null,
      input.kind,
      input.objectKey,
      input.sizeBytes,
      input.sha256,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("INSERT artifacts 没有返回结果");
  return row;
}

export function listArtifacts(
  q: Queryable,
  filter: { runId?: string; sandboxId?: string; kind?: ArtifactKind; limit?: number } = {},
): Promise<ArtifactRow[]> {
  return many<ArtifactRow>(
    q,
    `SELECT * FROM artifacts
      WHERE ($1::text IS NULL OR run_id = $1)
        AND ($2::text IS NULL OR sandbox_id = $2)
        AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [filter.runId ?? null, filter.sandboxId ?? null, filter.kind ?? null, filter.limit ?? 100],
  );
}

export function getArtifact(q: Queryable, id: string): Promise<ArtifactRow | null> {
  return maybeOne<ArtifactRow>(q, "SELECT * FROM artifacts WHERE id = $1", [id]);
}
