-- 008_env_health.sql —— 环境的镜像身份、缓存键、父指针与健康检查结论（spec Phase 7 §1-§3；设计文档 §C.5/§C.6）。
--
-- 【为什么这些列现在才加】006 的注释写明了"P7 才建 image_digest / cache_key / parent_revision /
-- health*"：P5 只推断、P6 只构建，那时这五列没有写入方，建了就是一批永远是 NULL 的列，
-- 而 NULL 的语义（"没体检"与"体检失败"）要到 P7 才定得下来。迁移只增不改，后加列是安全的。
--
-- 【为什么 health 是一个 jsonb 而不是几个散列】`status` 回答"能不能用"，`health_reason`
-- 回答"为什么"，而"哪一步失败了、受影响的是哪些动作（集成测试 / e2e）"是一段结构。
-- UI 与 ContextCompiler 都要读后者，压成一句话之后两边就得各自解析人话文本。
-- 形状是 `HealthReport`（`environment/health.ts`）：{status, reason, detail, facts[], steps[]}。
--
-- 【为什么 parent_revision 不做外键】沿用 001/005/006 的约定：跨表归属用可空 text/integer
-- 表达。真正的约束是 `(project_key, revision)` 的唯一键与 revision 单调递增这条应用层性质。
--
-- 【ALTER 的顺序为什么是 image_digest 打头】它对应 007 里"只有成功那一行才有值"的那一列：
-- `env_builds.image_digest` 是"这一次尝试产出了哪个镜像"，`environments.image_digest` 是
-- "这一版环境长什么样"（P7 把它定成事实，Run 的 `SandboxSpec.image` 直接用它）。

ALTER TABLE environments ADD COLUMN image_digest text;                    -- repo@sha256:… 或裸 sha256:…
ALTER TABLE environments ADD COLUMN cache_key    text;                    -- sha256（§C.5 的公式）
ALTER TABLE environments ADD COLUMN parent_revision integer;              -- 上一版；首版为 NULL
ALTER TABLE environments ADD COLUMN health       jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE environments ADD COLUMN health_reason text;                   -- degraded / failed 的一句话原因
ALTER TABLE environments ADD COLUMN health_checked_at timestamptz;        -- 没体检过就是 NULL
ALTER TABLE environments ADD COLUMN health_log_key text;                  -- 体检日志（env-logs/…，与构建日志同一个落点）

-- 缓存命中是**最高频的读**（会话创建、`env:build`、Run 的解析都先问它一次），
-- 而且它只按 (project_key, cache_key) 查——不带上 status 进索引是因为 status 是会变的那一列，
-- 放进索引只会让每次状态推进都多写一次索引；过滤在 SQL 里做（一次扫描就是几行）。
CREATE INDEX environments_cache_idx ON environments (project_key, cache_key);

-- 【这张表解决什么】设计文档 §C.5 说"回滚 = 把指针指回旧 revision"，spec P7 §2 也说
-- "promote / 回滚"都作用在一个"当前 revision"上。指针必须落在一个地方，而且不能是
-- "最新那一行"（最新一行可能正在构建、可能 failed）——所以它是一张一行的小表。
--
-- 【为什么不做成 environments 上的一列】"哪个 revision 是当前"与"这一版环境是什么"是
-- 两个不同的事实：前者每个仓库一行、会被 rollback 改；后者每个 revision 一行、只追加。
-- 混在一起之后，"把当前指针指回 1"就变成了改一条环境记录，而那条记录是历史证据。
--
-- 【为什么没有外键指向 environments】同样的理由：数据库层的存在性约束会把"环境行先写、
-- 指针后指"这条写入顺序变成一个 23503，而那本来是我们自己编排里的一步。
CREATE TABLE project_env_state (
  project_key      text PRIMARY KEY,           -- owner/name（与 environments 同一口径）
  current_revision integer NOT NULL,           -- 现在生效的那一版
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_env_state_revision_check CHECK (current_revision > 0)
);
