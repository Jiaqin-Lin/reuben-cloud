-- 007_env_builds.sql —— 环境构建的每次尝试（spec Phase 6 §5；设计文档 §C.4）。
--
-- 【这张表和 environments 的分工】`environments` 一行是"这个仓库的这份环境定义"（revision），
-- `env_builds` 一行是"为了把这一定义变成镜像，我们试了一次"。一次定义可能试三次（自愈循环），
-- 所以是 1:N。**每次尝试的 Dockerfile 文本都存在这里**——自愈会把上一版改掉，而
-- `environments.dockerfile` 只留最终生效的那份；中间的差异只有这张表记得住。
--
-- 【为什么 attempt 行在 build 开始时就写】UI 要能看见"正在建"（status=building），
-- 而不是构建完才有记录。10 分钟的构建没有任何中间记录，会让"卡住了还是在跑"无法区分。
--
-- 【为什么 trigger 与 status 有 CHECK】两个都是下游按值分支的口径（UI 徽章、队列去重、
-- 成本看板按触发源汇总）。写错一个字母不会报错，只会让某个分支永远走不到——与 006 的
-- environments 同一条理由（spec 的建表语句只写了 trigger 的 CHECK，这里补上 status 与
-- inference：它们同样会被 `switch` 读）。
--
-- 【error_class 为什么不加 CHECK】它是**诊断结论**，取值域会随分类表长大（P6 落地时
-- 已经有 9 个日志类 + 2 个生成阶段的类）。让它自由一点，比每加一条正则就要一次迁移便宜；
-- 代价是这一列的取值以 `build.ts` 的常量为准（`ENV_BUILD_ERROR_CLASSES`）。
--
-- 【image_digest 为什么在这里而不在 environments】P7 才把 digest 定成"这一版环境长什么样"
-- 的事实（`environments.image_digest`）；P6 只需要回答"这一次尝试产出了哪个镜像"。
-- 三行里只有成功那一行有值。

CREATE TABLE env_builds (
  id           text PRIMARY KEY,               -- bld_<ulid>
  project_key  text NOT NULL,                  -- owner/name（与 environments 同一口径）
  revision     integer NOT NULL,               -- 对应 environments 的那一版
  attempt      integer NOT NULL,               -- 1..3（上限是代码里的常量，不是约定）
  inference    text NOT NULL,                  -- devcontainer | dockerfile | signals | llm
  trigger      text NOT NULL,                  -- first_seen | manual | promote（设计文档 §C.8）
  status       text NOT NULL,                  -- building | built | failed
  error_class  text,                           -- build.ts 的分类结论；成功时为空
  -- 这次尝试**实际要构建的文本**。生成阶段就失败时（模型没给出代码块）这里放模型原文，
  -- 好让这一行能独立解释"为什么没成"——一个 NOT NULL 的列必须总有话说。
  dockerfile   text NOT NULL,
  log_key      text,                           -- 对象存储里的日志（env-logs/…）
  duration_ms  integer,
  image_digest text,                           -- sha256:<64 hex>（本地镜像 ID 形态）
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT env_builds_trigger_check CHECK (trigger IN ('first_seen','manual','promote')),
  CONSTRAINT env_builds_status_check CHECK (status IN ('building','built','failed')),
  CONSTRAINT env_builds_inference_check CHECK (inference IN ('devcontainer','dockerfile','signals','llm'))
);

-- "这个仓库这一版试过几次、现在在试第几次"是 UI 与排障的读法（按 attempt 升序就是时间序）。
CREATE INDEX env_builds_project_idx ON env_builds (project_key, revision, attempt);

-- 【为什么没有 (project_key, revision, attempt) 的唯一约束】M2 单实例，队列的去重在进程内
-- （`queue.ts` 的 pending map）；DB 层的唯一约束会把"同一 revision 又被构建了一次"变成
-- 一个 23505，而不是一条可以解释的记录。P7 的 revision 逻辑负责"重复构建 = 新 revision"，
-- 那时如果再需要一道 DB 闸，加索引是一次只增不改的迁移。
