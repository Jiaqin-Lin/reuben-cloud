-- 009_repo_index.sql —— 仓库索引（符号 / 文件级引用 / 每次索引的统计与状态）· spec Phase 8 §1。
--
-- 【为什么是四张表，而不是 spec 里的三张】`repo_symbols` 回答"定义在哪"，`repo_refs` 回答
-- "谁引用谁"，`repo_indexes` 回答"这个 (repo, commit) 索引成功了吗"。第四张 `repo_file_refs`
-- 是**增量**需要的第三个事实："文件 A 里出现过名字 X"（还没解析成边的那一步）。
-- 没有它，增量重建就只能靠"上一版的边"反推候选，而"n > 5 时丢弃"的歧义边在上一版里恰恰
-- 没有留下任何痕迹——于是"增量 == 全量"（spec 测试要点 5）会在那个角落里不成立。见附录 A-49。
--
-- 【索引键为什么是 (repo_key, commit_sha) 而不是 repo_key】索引是**某一个代码快照**的派生物：
-- 同一个仓库连着推三个 commit 就有三份事实，混在一起会让"改一行代码"变成"整张符号表作废"。
-- 增量重建读的正是上一份快照的行（同一张表、不同的 commit_sha）。
--
-- 【为什么全是"先删后插"】spec 测试要点 9（幂等）：同一个 commit 索引两次不能产生重复行。
-- 主键约束能挡住重复，但挡不住"这次解析出来的符号比上次少了几个"——那是**过期行**，
-- 主键不会报错，地图会读到已经不存在的定义。所以写入方一律先 `DELETE` 这个 commit 的行。
--
-- 【保留几个 commit】每多存一个 commit，就多一整份符号表；M2 只需要"当前 + 上一版"（增量的
-- 基准就是上一版）。`pruneRepoIndexes()` 在每次成功索引之后按 `built_at` 保留最近 N 版，
-- 默认 2。删掉的只是可供增量的历史，随时可以重新全量建出来。
--
-- 【kind 为什么两个表各有一份 CHECK】`repo_symbols.kind` 与 `repo_file_refs.kind` 是两套词汇
-- （定义 / 候选引用），而且都被 `switch` 按值读。拼错一个字母 = 那个分支永远走不到
-- （与 006/007 的 CHECK 同一条理由，见附录 A-31）。

CREATE TABLE repo_indexes (
  repo_key    text NOT NULL,                -- owner/name（不含 token；与 environments.project_key 同口径）
  commit_sha  text NOT NULL,                -- 索引的是哪一个快照
  status      text NOT NULL,                -- building | ready | failed | unsupported
  files       integer NOT NULL DEFAULT 0,   -- 扫描到的文件数（含不支持的语言）
  symbols     integer NOT NULL DEFAULT 0,
  edges       integer NOT NULL DEFAULT 0,
  languages   jsonb NOT NULL DEFAULT '{}',  -- {tsx: 120, python: 30}
  duration_ms integer,
  error       text,                         -- failed / partial 时的一句话（partial_timeout / partial_max_files）
  built_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_key, commit_sha),
  CONSTRAINT repo_indexes_status_check CHECK (status IN ('building', 'ready', 'failed', 'unsupported'))
);

-- "这个仓库上一版成功的索引是哪个 commit"——增量的基准，也是 P9 拿最新地图的入口。
CREATE INDEX repo_indexes_recent_idx ON repo_indexes (repo_key, built_at DESC);

CREATE TABLE repo_symbols (
  repo_key   text NOT NULL,
  commit_sha text NOT NULL,
  path       text NOT NULL,                     -- 仓库相对路径，/ 分隔
  lang       text NOT NULL,
  name       text NOT NULL,
  kind       text NOT NULL,                     -- function | class | method | interface | type | const
  signature  text NOT NULL,                     -- 单行，最多 200 字符（symbols.ts 的 MAX_SIGNATURE_LENGTH）
  start_line integer NOT NULL,                  -- 1 起（人对行号的理解）
  end_line   integer NOT NULL,
  PRIMARY KEY (repo_key, commit_sha, path, name, start_line),
  CONSTRAINT repo_symbols_kind_check CHECK (kind IN ('function', 'class', 'method', 'interface', 'type', 'const')),
  CONSTRAINT repo_symbols_lines_check CHECK (start_line > 0 AND end_line >= start_line)
);

-- 引用解析的输入：名字 → 定义它的文件（可能多个 = 歧义）。
CREATE INDEX repo_symbols_name_idx ON repo_symbols (repo_key, commit_sha, name);

CREATE TABLE repo_refs (
  repo_key   text NOT NULL,
  commit_sha text NOT NULL,
  from_path  text NOT NULL,
  to_path    text NOT NULL,
  -- 这一条边是"因为哪个名字"产生的：候选标识符（`Ledger`）或 import 路径（`./ledger.ts`）。
  -- 增量重建要用它反查"哪些文件引用了会变的那个名字"，所以它也在主键里。
  symbol     text NOT NULL,
  weight     real NOT NULL DEFAULT 1.0,         -- 唯一同名 1.0、歧义 1/n、import 2.0
  PRIMARY KEY (repo_key, commit_sha, from_path, to_path, symbol),
  CONSTRAINT repo_refs_weight_check CHECK (weight > 0)
);

-- 增量：按名字反查"谁还在引用它"（`from_path` 在增量里是排除项）。
CREATE INDEX repo_refs_symbol_idx ON repo_refs (repo_key, commit_sha, symbol);
-- 地图的失效判断（"这个文件被改过了"）与按目标反查都用它。
CREATE INDEX repo_refs_to_idx ON repo_refs (repo_key, commit_sha, to_path);

-- 候选引用（还没解析成边的那一步）：一行 = "文件 path 里出现过 symbol"。
-- 它存在的唯一理由是让**增量**能精确重建边（见文件头第一段）：变化文件重新解析出候选，
-- 受影响文件用这里的旧候选重算，其余文件的边整段复制。于是"增量 == 全量"是一条定理而不是期望。
CREATE TABLE repo_file_refs (
  repo_key   text NOT NULL,
  commit_sha text NOT NULL,
  path       text NOT NULL,
  symbol     text NOT NULL,
  kind       text NOT NULL,                     -- identifier | import
  PRIMARY KEY (repo_key, commit_sha, path, symbol, kind),
  CONSTRAINT repo_file_refs_kind_check CHECK (kind IN ('identifier', 'import'))
);

-- 增量重建时"哪些文件的候选里有名字 X"。
CREATE INDEX repo_file_refs_symbol_idx ON repo_file_refs (repo_key, commit_sha, symbol);
