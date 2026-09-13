-- 002_transition.sql —— 状态的唯一写入口（§D + Phase 8 §3）。
--
-- 【它为什么是 SQL 函数，不是 TS 函数】Phase 8 §3 要求"业务代码不许直接 UPDATE state"，
-- 并且"推荐 SECURITY DEFINER 函数 + 收掉 UPDATE(state) 权限"。这两条只有放在数据库里
-- 才是真的：TS 里的 transition() 只是一个好习惯，而数据库权限是任何人（包括未来的
-- 另一个进程、一次手工 psql）都绕不过去的墙。
--
-- 【一个事务，四步】SELECT … FOR UPDATE（拿真正的旧状态）→ 校验旧状态在期望集合里
-- → UPDATE（含可选补丁列）→ INSERT 审计行。整个函数体就是一个事务，
-- 中途退出（非法转换）返回 jsonb 而不是抛异常——调用方要的是"当前状态是什么"，
-- 不是一条没人能分类的 SQL 错误（那个错误还会让整个事务 abort，而这里什么都没改）。
--
-- 返回值（CP 侧见 db/sandboxes.ts 的 TransitionResult）：
--   {"ok": true,  "from": "READY"}                成功
--   {"ok": false, "current": "BUSY"}              非法转换：行还在，返回当前状态
--   {"ok": false, "current": "READY", "illegal": true}
--                                                 当前状态对得上，但这条边不存在（READY→CREATING 这类）
--   {"ok": false, "missing": true}                行不存在
--
-- 【为什么要维护一张边的表，而不只看调用方给的 from 集合】`from` 是调用方**期望的当前状态**，
-- 它拦不住"期望对得上、但目标状态不合法"的写法：`transition(id, ["READY"], "CREATING")`
-- 在只检查 from 的实现里会一路走完。§D 的状态机是设计的一部分（5 个状态、没有 PAUSED，
-- 换来的好处是"只有两个转换会改变谁在等"），所以它应该和"谁在改 state"一样由数据库守着。
-- 两条检查都做：先看 from（调用方的期望是否成立），再看边（这次转换本身是否合法）。

CREATE OR REPLACE FUNCTION sandbox_transition(
  p_id      text,
  p_from    text[],                       -- 期望的当前状态集合；不在里面就拒绝
  p_to      text,
  p_reason  text,
  p_patch   jsonb DEFAULT '{}'::jsonb     -- 顺带要改的列（Partial<SandboxRow>）
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- 补丁里允许出现的列。**state 不在这个列表里**：那个列只能由本函数写。
  -- 也不允许 id / created_at：它们不是"可以顺带改"的东西。
  c_patchable constant text[] := ARRAY[
    'task_id', 'run_id', 'provider', 'provider_ref', 'endpoint', 'auth_token',
    'image', 'image_digest', 'limits', 'workspace_volume',
    'last_active_at', 'ready_at', 'destroyed_at', 'state_reason'
  ];
  -- 允许的边，照 §D 的生命周期图逐条抄下来（编码成 `FROM>TO` 是为了能直接和 "= ANY" 比）。
  --  · CREATING → READY（创建成功）/ ERROR（创建失败）/ DESTROYED（建到一半被销毁）
  --  · READY    → BUSY（开始执行）/ ERROR（销毁失败等）/ DESTROYED（正常销毁）
  --  · BUSY     → READY（执行收尾）/ ERROR（看门狗、销毁失败）/ DESTROYED（TTL 到点）
  --  · ERROR    → DESTROYED（TTL 重试把删不掉的沙箱删掉）——**没有 ERROR → READY**：
  --    §D 说 ERROR 是"需人工处理"，自动复活会让故障悄悄消失。
  --  · DESTROYED 没有出边。
  c_edges constant text[] := ARRAY[
    'CREATING>READY', 'CREATING>ERROR', 'CREATING>DESTROYED',
    'READY>BUSY', 'READY>ERROR', 'READY>DESTROYED',
    'BUSY>READY', 'BUSY>ERROR', 'BUSY>DESTROYED',
    'ERROR>DESTROYED'
  ];
  v_current   text;
  v_patch     jsonb;
  v_effective jsonb;
  v_cols      text[];
BEGIN
  -- ① 锁住这一行并拿旧状态。FOR UPDATE 是"校验 + 更新"原子性的全部依靠：
  -- 两个并发的 READY→BUSY 只有一个能拿到 READY。
  SELECT s.state INTO v_current FROM sandboxes s WHERE s.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'missing', true);
  END IF;

  -- ② 非法转换：什么都不改，把事实（当前状态）告诉调用方，由它转 409。
  IF NOT (v_current = ANY (p_from)) THEN
    RETURN jsonb_build_object('ok', false, 'current', v_current);
  END IF;

  -- ②' 状态机里没有这条边（例如 READY→CREATING）。同样是"不改任何东西 + 返回当前状态"，
  -- 但多带一个 illegal 标记：它和"期望落空"是两件事（后者重试可能成功，前者是代码 bug）。
  IF NOT ((v_current || '>' || p_to) = ANY (c_edges)) THEN
    RETURN jsonb_build_object('ok', false, 'current', v_current, 'illegal', true);
  END IF;

  v_patch := coalesce(p_patch, '{}'::jsonb) - 'state' - 'id' - 'created_at';

  -- ③ 只取白名单里的列。这里先算出列名列表，值一律走 jsonb_populate_record，
  -- 所以列名是我们自己的常量、值从来不拼进 SQL 字符串（注入面为零）。
  SELECT coalesce(array_agg(entry.key ORDER BY entry.key), ARRAY[]::text[]) INTO v_cols
    FROM jsonb_object_keys(v_patch) AS entry(key)
   WHERE entry.key = ANY (c_patchable);

  -- state / state_reason 永远写：state_reason 取"补丁里显式给的"或本次 reason。
  v_effective := v_patch
    || jsonb_build_object('state', p_to)
    || jsonb_build_object('state_reason', coalesce(v_patch ->> 'state_reason', p_reason));
  v_cols := v_cols || ARRAY['state', 'state_reason'];

  -- 多列赋值 + 标量子查询：把 jsonb 里的键值按**表列的真实类型**转换后一次写回。
  -- 这样 timestamptz / jsonb / text 都不需要在这里各写一遍 cast（也不会写漏一个）。
  EXECUTE format(
    'UPDATE sandboxes SET (%1$s) = (SELECT %1$s FROM jsonb_populate_record(null::sandboxes, $1::jsonb)) WHERE id = $2',
    array_to_string(v_cols, ', ')
  ) USING v_effective, p_id;

  -- ④ 审计行。§D 的原话：这是崩溃恢复的唯一依据。
  INSERT INTO sandbox_state_transitions (sandbox_id, from_state, to_state, reason)
  VALUES (p_id, v_current, p_to, p_reason);

  RETURN jsonb_build_object('ok', true, 'from', v_current);
END;
$fn$;

-- ---------------------------------------------------------------- 应用角色与权限
--
-- 【为什么迁移里要建角色】"收掉 state 列的 UPDATE 权限"必须有一个**非属主**的角色才成立：
-- 表属主（跑迁移的那个人）永远能改自己的表，权限模型对它不起作用。所以这里建一个
-- 应用角色，把除 state 之外的列授给它。
--
-- 【它没有密码】迁移里不写死凭据（那是个比明文 auth_token 更糟的习惯）。本地开发/测试
-- 用 `SET ROLE reuben_cloud_app` 验证权限（超级用户可以切到任何角色）；真实部署时
-- 由运维 `ALTER ROLE reuben_cloud_app LOGIN PASSWORD '…'` 补登录能力，并通过 DATABASE_URL
-- 让 CP 用这个角色连库。**没有这一步，DB 层的制约就退化成了"靠自觉"**——
-- 这是 Phase 8 验收里"DB 真的会拦"那一条的前提。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reuben_cloud_app') THEN
    CREATE ROLE reuben_cloud_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO reuben_cloud_app;

-- 读 + 追加。**没有 DELETE**：沙箱行与审计行都是只增不删的（DESTROYED 也是一行状态）。
GRANT SELECT, INSERT ON sandboxes, executions, artifacts, sandbox_state_transitions TO reuben_cloud_app;

-- 非 state 列的 UPDATE（endpoint / provider_ref / last_active_at / … 由业务代码直接改）。
-- 逐个列列出是有意的：这样"将来加了一个列却忘了授权"会立刻炸在写入处，而不是静默通过。
GRANT UPDATE (
  task_id, run_id, provider, provider_ref, endpoint, auth_token,
  image, image_digest, state_reason, limits, workspace_volume,
  last_active_at, created_at, ready_at, destroyed_at
) ON sandboxes TO reuben_cloud_app;

-- executions / artifacts / 审计表没有需要收起来的列。
GRANT UPDATE ON executions, artifacts, sandbox_state_transitions TO reuben_cloud_app;

-- 审计表的 id 是 bigserial：INSERT 需要序列的 USAGE。
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reuben_cloud_app;

-- 函数是 SECURITY DEFINER，以属主身份跑，所以应用角色只需要 EXECUTE。
GRANT EXECUTE ON FUNCTION sandbox_transition(text, text[], text, text, jsonb) TO reuben_cloud_app;
