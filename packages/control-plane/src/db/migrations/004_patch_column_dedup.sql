-- 004_patch_column_dedup.sql —— 修复状态机补丁的重复列（Phase 10 发现）。
--
-- 【问题】002 里的 `sandbox_transition()` 把补丁白名单里的列聚合成 `v_cols`，然后无条件
-- 再追加 `ARRAY['state', 'state_reason']`。只要调用方在 patch 里显式传了 `state_reason`
-- （`SandboxPatch` 一直声称支持，Phase 10 的"强制销毁时把 archive_failed 写进 state_reason"
-- 是第一个真的这么做的调用方），生成的 UPDATE 就变成
--   SET (state_reason, state, state_reason) = (…)
-- 而 Postgres 直接报 `multiple assignments to same column`——整次转换失败，销毁卡在那里。
-- 002 的正文没错（`coalesce(v_patch ->> 'state_reason', p_reason)` 正是为这个用法写的），
-- 错在列名没有去重。
--
-- 【修法】初始聚合里排除 `state` / `state_reason`，它们统一由后面那次
-- `v_cols || ARRAY['state','state_reason']` 追加。列名集合从此天然唯一。
--
-- 【为什么整段抄一遍】plpgsql 没有"改函数体的一部分"这种操作，CREATE OR REPLACE 只能
-- 整段替换。函数体与 002 逐字相同，只有 ③ 那一处 WHERE 多了两个排除条件。
-- `CREATE OR REPLACE` 保留原 OID 与权限，所以 002 里的 `GRANT EXECUTE` 不用重写。
-- 下一次再改这个函数时请连同这份一起改，或者写一个更新的迁移——但不要回头改历史迁移。
--
-- 【为什么这里能省掉 002 的其余部分】本文件只替换函数；角色、GRANT、审计表索引都在 002
-- 里已经就位，重复一遍只会让"权限到底是谁授的"多一个出处。

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

  -- ③ 只取白名单里的列，**并排除 state / state_reason**：它们由下面统一追加。
  -- 这一条 `NOT IN` 就是 004 的全部内容——没有它，patch 里带了 state_reason 时
  -- 生成的 UPDATE 会出现同名列两次，Postgres 直接拒绝执行。
  SELECT coalesce(array_agg(entry.key ORDER BY entry.key), ARRAY[]::text[]) INTO v_cols
    FROM jsonb_object_keys(v_patch) AS entry(key)
   WHERE entry.key = ANY (c_patchable)
     AND entry.key NOT IN ('state', 'state_reason');

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
