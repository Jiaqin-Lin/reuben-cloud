-- 001_init.sql —— 三张业务表 + 一张审计表（§G + A-7）。
--
-- 【为什么是裸 SQL 而不是 ORM】spec §0.2 / §Phase 8 §1：三张表而已。SQL 直接看得见最好，
-- 而且这里有几处**只能**用 SQL 表达的约束（CHECK、索引、SECURITY DEFINER），
-- ORM 的迁移 DSL 只会把它们藏起来。
--
-- 【谁在写】业务代码只读这些表，唯一改 state 的入口是 002 里的 sandbox_transition()。
-- 表结构本身刻意留宽了：task_id / run_id 是**可空 text、没有外键**——tasks / runs 表是
-- M3 的事，现在建了就是空壳（Phase 8 §2）。对账要处理"归属未知"的行，所以不能 NOT NULL。

-- ---------------------------------------------------------------- sandboxes（§G.1）

CREATE TABLE sandboxes (
  id               text PRIMARY KEY,                        -- sbx_<ulid>
  task_id          text,                                    -- 可空：tasks 表是 M3
  run_id           text,                                    -- 可空：runs 表是 M3
  provider         text NOT NULL,                           -- provider.kind（M0 是 local-docker）
  provider_ref     text,                                    -- 容器 id；创建成功前是 null
  endpoint         text,                                    -- agent 基地址；创建成功前是 null
  auth_token       text,                                    -- 明文（有意为之，见文件末尾）
  image            text NOT NULL,                           -- 完整镜像引用（带 digest）
  image_digest     text NOT NULL,                           -- 权威身份：tag 只是展示（§G.1）
  state            text NOT NULL,
  state_reason     text,                                    -- 最近一次转换原因；ERROR 时是结构化错误码
  limits           jsonb NOT NULL DEFAULT '{}'::jsonb,      -- {cpu, memMb, pids, diskMb, ttlSec}
  workspace_volume text,                                    -- 命名卷名
  last_active_at   timestamptz NOT NULL DEFAULT now(),      -- 每次 exec 开始时刷新
  created_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  destroyed_at     timestamptz,
  -- 状态集合写进约束：迁移漏了一个新状态会立刻炸在写入处，而不是让一个非法值悄悄落库。
  CONSTRAINT sandboxes_state_check CHECK (
    state IN ('CREATING', 'READY', 'BUSY', 'ERROR', 'DESTROYED')
  )
);

-- 超时扫描靠它（sweeper 的 WHERE state = ANY(...) AND last_active_at < ...）。
-- 注意：per-sandbox 的 limits->>'ttlSec' 是逐行的表达式，用不上 last_active_at 的范围扫描，
-- 所以这个索引实际提供的是"按 state 先剪枝"。表里同时存在的沙箱数量是几十个量级，
-- 这一点点扫描差距换来的是"每个沙箱可以有自己的 TTL"（§D 的 6h 只是缺省值）。
CREATE INDEX sandboxes_state_active_idx ON sandboxes (state, last_active_at);
CREATE INDEX sandboxes_run_idx ON sandboxes (run_id);
-- 对账拿 provider_ref 反查（§G.1）。
CREATE INDEX sandboxes_provider_ref_idx ON sandboxes (provider_ref);

-- ---------------------------------------------------------------- executions（§G.2）

CREATE TABLE executions (
  id           text PRIMARY KEY,                            -- exe_<ulid>，沙箱侧生成
  sandbox_id   text NOT NULL REFERENCES sandboxes (id),     -- 执行必有沙箱；沙箱行不删，所以不会悬空
  run_id       text,
  cmd          jsonb NOT NULL,                              -- argv 数组，原样存（不存 shell 字符串）
  cwd          text,
  env_keys     jsonb NOT NULL DEFAULT '[]'::jsonb,          -- **只有 key 名，绝不存值**
  state        text NOT NULL,
  reason       text,                                        -- 终态原因（watchdog_timeout / cp_restart …）
  exit_code    integer,
  stdout_bytes bigint NOT NULL DEFAULT 0,
  stderr_bytes bigint NOT NULL DEFAULT 0,
  truncated    boolean NOT NULL DEFAULT false,
  log_path     text,                                        -- 沙箱内路径；销毁后失效（重要的要转存对象存储）
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  CONSTRAINT executions_state_check CHECK (
    state IN ('running', 'completed', 'failed', 'timeout', 'killed')
  ),
  -- 值里只要有一滴内容，这条就挡住了。真正"只存 key"的保证在 insert 那一侧（executions.ts），
  -- 这里只是让"不小心把整个 env 塞进去"变成一个立刻可见的错误，而不是一个安全事件。
  CONSTRAINT executions_env_keys_is_array CHECK (jsonb_typeof(env_keys) = 'array')
);

CREATE INDEX executions_sandbox_idx ON executions (sandbox_id, started_at DESC);
CREATE INDEX executions_run_idx ON executions (run_id);

-- ---------------------------------------------------------------- artifacts（§G.3 + A-8）

CREATE TABLE artifacts (
  id          text PRIMARY KEY,                             -- art_<ulid>
  run_id      text,
  sandbox_id  text,
  -- A-8：多了 exec_log——被截断的执行日志在销毁前需要转存。
  kind        text NOT NULL,
  object_key  text NOT NULL,                                -- S3/MinIO 路径
  size_bytes  bigint NOT NULL,
  sha256      text NOT NULL,                                -- 完整性
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_kind_check CHECK (
    kind IN ('diff', 'workspace_archive', 'exec_log')
  )
);

CREATE INDEX artifacts_run_idx ON artifacts (run_id);
CREATE INDEX artifacts_sandbox_idx ON artifacts (sandbox_id);

-- ---------------------------------------------------------------- sandbox_state_transitions（A-7）

-- §D：「每次转换写审计日志，这是崩溃恢复的唯一依据」——这张表就是那个落点。
-- 写入者是 sandbox_transition()（002）与创建时的那一条 INSERT，业务代码没有别的入口。
CREATE TABLE sandbox_state_transitions (
  id         bigserial PRIMARY KEY,
  sandbox_id text NOT NULL,
  -- 可空：创建那一行是"没有前驱"的（NULL → CREATING）。其余转换永远有 from。
  from_state text,
  to_state   text NOT NULL,
  reason     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

-- 读轨迹：WHERE sandbox_id = $1 ORDER BY at, id（同一毫秒内靠 id 定序）。
CREATE INDEX sandbox_state_transitions_sandbox_idx ON sandbox_state_transitions (sandbox_id, at, id);

-- ---------------------------------------------------------------- 关于明文 auth_token

-- `sandboxes.auth_token` 是明文（§G.1 + Phase 8「技术边界」的最后一条）：
-- TTL 6h、只保护一个仅内网可达的端口、DB 本身在可信域内。这条是**有意识记下的账**，
-- 不是遗漏——把它变成 code review 时的惊喜才是真正的风险。要做加密的话，
-- 解法是凭据服务（§I 的正交演进线），不是在这里塞一个自制的加密层。
-- 同理：provider 在 create 时把同一个 token 放进容器 env，对账时也要能读回来
-- （CP 重启后 provider 是个新对象，而沙箱还活着）。
