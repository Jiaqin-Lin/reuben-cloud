-- 005_agent_runtime.sql —— 会话 / 一次执行 / 对话树 / 工具调用 / 用量 / 编译产物（spec Phase 2 §1）。
--
-- 【这张迁移里最重要的一句话】会话（sessions）与 Run（runs）是**两张表**。
-- 会话是长期实体（几天、几周），用户的对话历史挂在它下面；Run 只是"用户这一句话的处理过程"。
-- 把两者合成一张 `run_sessions` 的后果在设计文档 §A.1 里写得很直白：**用户回第二句话就开了一个新会话**，
-- 历史、成本、沙箱归属全部跟着错。所以这里宁可多一张表，也不要一个"看起来更简单"的合并。
--
-- 【与既有三张表的关系】sandboxes / executions / artifacts 的列一个不改，只给 sandboxes 加
-- `session_id`（把沙箱从"某次执行的附属品"改成"某个会话的工作区"）。既有行的 session_id 是 NULL，
-- 对账、sweeper、状态机的代码一个字不用动。
--
-- 【为什么新表的 run_id 是可空 text、没有外键】沿用 001 / 002 的约定：M0 的 sandboxes.run_id 就是这样，
-- 对账要能处理"归属未知"的行。真正的归属（会话）用 session_id 表达，那是 NOT NULL + 外键的。
--
-- 【为什么记录类表只追加】session_entries / usage_ledger / tool_invocations 是**证据**：
-- 压缩不改历史（只加一条 compaction 条目），结算不改意图（只把 status 从 intent 推到 settled）。
-- 凭证、审计、回放三件事都挂在这条性质上（设计文档 §G.4）。

-- ---------------------------------------------------------------- 会话（长期实体）

CREATE TABLE sessions (
  id            text PRIMARY KEY,               -- ses_<ulid>
  task_id       text,                           -- 可空：tasks 表是 M3（与 sandboxes 同一约定）
  repo_key      text NOT NULL,                  -- owner/name，不含凭据
  base_commit   text NOT NULL,                  -- 会话开始时的 commit
  head_ref      text,                           -- 会话当前的工作分支（reuben-cloud/<task>）
  head_commit   text,                           -- 当前分支的 head（冷启动重建沙箱时的仓库起点）
  cwd           text NOT NULL,                  -- 沙箱内的仓库根（工具层相对路径的基准）
  title         text,                           -- 给 UI 用的一句话（第一轮后生成，可空）
  leaf_entry_id text,                           -- 当前 leaf；下一句从这里往后接
  sandbox_id    text,                           -- 当前热着的沙箱（可空：还没干活）
  sandbox_last_used_at timestamptz,             -- 最后一次用到沙箱的时间（空闲 TTL 从它算）
  -- 【下面两列是 spec 的表结构里没有的（附录 A-4）】"回收前落地"失败时需要一个**不销毁沙箱**
  -- 又能被下一轮看见的标记。放进 sandboxes.state 不行：ERROR 没有出边（§D），标了它就再也回不到
  -- READY，等于把一次网络抖动升级成"必须人工处理"。放在会话上是诚实的：失败的是"这次会话的落地"。
  sandbox_flush_failures integer NOT NULL DEFAULT 0,
  sandbox_flush_failed_at timestamptz,
  active_run_id text,                           -- 正在跑的执行；不为空 = 本会话忙（并发保护）
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 空闲回收扫的就是"有沙箱的会话"。
CREATE INDEX sessions_sandbox_idx ON sessions (sandbox_id) WHERE sandbox_id IS NOT NULL;
-- UI 的会话列表（按最近活动倒序）。
CREATE INDEX sessions_updated_idx ON sessions (updated_at DESC);

-- M0 的 sandboxes 表加一列：沙箱归属**会话**（不是归属某一次执行）。
-- 只需 ALTER，既有行 session_id 为 NULL，所有既有查询照旧。
ALTER TABLE sandboxes ADD COLUMN session_id text;
CREATE INDEX sandboxes_session_idx ON sandboxes (session_id, last_active_at DESC);

-- ---------------------------------------------------------------- Run（一次执行）

CREATE TABLE runs (
  id             text PRIMARY KEY,              -- run_<ulid>
  session_id     text NOT NULL REFERENCES sessions (id),
  sandbox_id     text,                          -- 可空：创建前；M0 的 sandboxes 表已能按它反查
  start_entry_id text,                          -- 这一轮从哪条 entry 之后开始
  end_entry_id   text,                          -- 结束时 leaf 在哪（下一轮的起点）
  provider       text NOT NULL,
  model          text NOT NULL,
  env_revision   text,                          -- 用了哪个环境版本（Phase 7）
  status         text NOT NULL,                 -- running | stopped | failed
  stop_reason    text,                          -- 与 AgentStopReason 同一套取值
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  CONSTRAINT runs_status_check CHECK (status IN ('running','stopped','failed'))
);
CREATE INDEX runs_session_idx ON runs (session_id, started_at DESC);

-- ---------------------------------------------------------------- 对话树（挂在会话上）

CREATE TABLE session_entries (
  id         text PRIMARY KEY,                 -- ent_<ulid>
  session_id text NOT NULL REFERENCES sessions (id),
  run_id     text,                             -- 哪一次执行写的（压缩/自定义条目可空）
  parent_id  text,                             -- 直线；结构上支持分叉（M3）
  seq        bigserial NOT NULL,               -- 全局单调（排序与分页用）
  type       text NOT NULL,
  payload    jsonb NOT NULL,                   -- AgentMessage 或压缩条目
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_entries_type_check CHECK (type IN ('message','compaction','custom'))
);
CREATE INDEX session_entries_session_idx ON session_entries (session_id, seq);

-- 【为什么 seq 用 bigserial 而不是"会话内自增"】全局单调即可满足排序与分页（pi 的 seq 也是
-- storage-assigned 全局序号）。会话内顺序用 (session_id, seq) 表达，不需要额外的计数列——
-- 少一个需要事务保护的计数器，就少一类并发 bug。

-- ---------------------------------------------------------------- 工具调用：意图 → 结算

CREATE TABLE tool_invocations (
  id              text PRIMARY KEY,            -- inv_<ulid>
  session_id      text NOT NULL REFERENCES sessions (id),
  run_id          text NOT NULL,
  turn            integer NOT NULL,            -- 本次执行内的模型往返序号
  source_index    integer NOT NULL,            -- 在 assistant 消息里的位置（顺序恢复要用）
  tool            text NOT NULL,
  args            jsonb NOT NULL,
  replay          text NOT NULL DEFAULT 'never',
  status          text NOT NULL,               -- intent | settled | interrupted
  result_entry_id text,                        -- 预留的结果 entry id（结算时用同一个）
  is_error        boolean,
  result_bytes    integer,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  CONSTRAINT tool_invocations_status_check CHECK (status IN ('intent','settled','interrupted'))
);
CREATE INDEX tool_invocations_run_idx ON tool_invocations (run_id, turn, source_index);
-- kill -9 之后"哪些调用停在 intent"要能一眼查出来（M2 只保证可见，不做恢复）。
CREATE INDEX tool_invocations_intent_idx ON tool_invocations (status) WHERE status = 'intent';

-- ---------------------------------------------------------------- 用量账本（只追加）

CREATE TABLE usage_ledger (
  id                text PRIMARY KEY,          -- usg_<ulid>
  session_id        text,                      -- 环境自愈可能没有 session
  run_id            text,
  kind              text NOT NULL,             -- main | compaction | env_build | embedding
  provider          text NOT NULL,
  model             text NOT NULL,
  input_tokens      bigint NOT NULL DEFAULT 0,
  output_tokens     bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cost_usd          numeric(12,6),             -- 账本允许为空（未知模型）
  entry_id          text,                      -- 对应的 entry（可空）
  at                timestamptz NOT NULL DEFAULT now(),
  -- kind 是**账本的口径**：写错一个字母，按 kind 汇总的账就当月对不上。
  -- 所以让它在数据库层可见（和 sandboxes 的 state 约束同一条理由）。
  CONSTRAINT usage_ledger_kind_check CHECK (kind IN ('main','compaction','env_build','embedding'))
);
CREATE INDEX usage_ledger_session_idx ON usage_ledger (session_id, at);
CREATE INDEX usage_ledger_run_idx ON usage_ledger (run_id, at);

-- ---------------------------------------------------------------- 每轮模型调用看到的编译产物

CREATE TABLE model_requests (
  id            text PRIMARY KEY,              -- req_<ulid>
  session_id    text NOT NULL REFERENCES sessions (id),
  run_id        text NOT NULL,
  turn          integer NOT NULL,
  compiled_hash text NOT NULL,
  sections      jsonb NOT NULL,                -- [{name, tokens, hash}]
  system        text NOT NULL,
  tools_hash    text NOT NULL,
  usage_id      text,
  inline_messages jsonb,                       -- ≤ 256 KiB 内联
  object_key    text,                          -- 超出部分落对象存储
  bytes         integer NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_requests_run_idx ON model_requests (run_id, turn);

-- 【为什么不加 (run_id, turn) 的唯一约束】P3 的溢出恢复会在**同一个 turn** 里压缩后重试：
-- 第一次（被 provider 拒绝的）输入与重试的输入是两份不同的事实，都值得留下。
-- 唯一约束会逼着实现去 upsert，等于提前替 P3 做了一个它还没做的决定。
