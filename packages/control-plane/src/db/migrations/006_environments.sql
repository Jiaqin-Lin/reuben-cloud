-- 006_environments.sql —— 环境定义与推断结果（spec Phase 5 §1；设计文档 §G.1）。
--
-- 【这张表是什么】一个仓库（project_key）在不同 revision 上的**环境定义**：选中了哪一级推断、
-- 用哪个 Layer 1 基础镜像、生成的 Dockerfile 全文、采集到的信号、以及人话说明与降级风险。
-- 它是配置与派生物（§G.4 的"坏了可以重建"那一类），不是证据——所以它可以被重新推断覆盖为
-- 新 revision，而不是只追加。
--
-- 【为什么 revision 与 project_key 是一对唯一键】设计文档 §C.5：同一个仓库的 revision 单调递增，
-- 回滚 = 把指针指回旧值。唯一键是这条性质的**执行者**：没有它，"revision 单调"只是一句注释。
--
-- 【为什么 dockerfile / signals / notes 都是 NOT NULL】一条环境记录存在的意义就是这几个字段。
-- 允许 NULL 只会让"读取方到处判空"，而唯一会写 NULL 的场合是"写一半崩了"——那本来就该回滚。
--
-- 【P7 会加什么】`image_digest` / `cache_key` / `parent_revision` / `health*`（spec P7 的交付物
-- 明确把"environments 表的剩余字段"留给了 P7）。这里先不建它们，因为 P5 不构建也不体检：
-- 建了就会有一批"永远是 NULL"的列，而 NULL 的语义要到 P7 才确定。迁移只增不改，后加列是安全的。

CREATE TABLE environments (
  id              text PRIMARY KEY,              -- env_<ulid>
  project_key     text NOT NULL,                 -- owner/name（base 行用镜像名）
  revision        integer NOT NULL,              -- 同一 project_key 内单调递增
  kind            text NOT NULL,                 -- base（Layer 1 的登记）| project（仓库环境）
  level           text NOT NULL,                 -- devcontainer | dockerfile | signals
  status          text NOT NULL,                 -- draft | building | ready | degraded | failed
  base_image      text NOT NULL,                 -- Layer 1 的引用（P7 起是 digest）
  dockerfile      text NOT NULL,                 -- 完整文本（可复现：同一信号 → 同一份）
  signals         jsonb NOT NULL,                -- RepoSignals（归一化之后，是缓存键的输入）
  notes           jsonb NOT NULL DEFAULT '[]'::jsonb,
  degraded_risks  jsonb NOT NULL DEFAULT '[]'::jsonb,
  build_commands  jsonb NOT NULL DEFAULT '[]'::jsonb,
  verify_commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- kind / level / status 是**下游按值分支的口径**（UI 徽章、P7 的健康检查、P6 的生成循环）。
  -- 写错一个字母不会报错，只会让某个分支永远走不到——所以在数据库层可见（与 sandboxes.state 同一条理由）。
  CONSTRAINT environments_revision_unique UNIQUE (project_key, revision),
  CONSTRAINT environments_kind_check CHECK (kind IN ('base','project')),
  CONSTRAINT environments_level_check CHECK (level IN ('devcontainer','dockerfile','signals')),
  CONSTRAINT environments_status_check CHECK (status IN ('draft','building','ready','degraded','failed'))
);

-- "这个仓库最新的环境是哪个"是最高频的查询（P6 要接着上一个 revision 自愈，P7 要 promote）。
CREATE INDEX environments_project_idx ON environments (project_key, revision DESC);
-- 构建队列与看板会按状态扫（P7）。
CREATE INDEX environments_status_idx ON environments (status, created_at DESC);

-- 【为什么没有 image / env_builds 的外键】沿用 M0 的约定（001 / 005）：跨表的归属用可空 text
-- 表达，因为这批表在崩溃恢复与对账场景下必须先能写入"归属未知"的行。真正的约束靠应用层与
-- revision 的唯一键。
