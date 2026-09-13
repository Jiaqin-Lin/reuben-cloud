-- 010_repo_map.sql —— Repo Map 的缓存（spec Phase 9 §4）。
--
-- 【为什么缓存的是渲染结果，而不是排名】地图的输入（符号表 + 边 + 个性化向量 + 预算）到输出
-- 是一条**确定性**的流水线（设计文档 §D.3 第 3 条），所以缓存的键就是那几个输入，值是文本。
-- 缓存的键少一项都会让"同一份输入渲染出两份东西"变成可能，而地图每轮都进缓存前缀
-- （tools → system → repo_map），前缀一变就是整段提示词缓存失效。
--
-- 【为什么 personalization_hash 是"任务词的哈希"而不是完整任务文本】地图只依赖任务里的
-- 标识符（`personalize.ts` 切出来的词），两句话提到同一批词就该命中同一条缓存。存哈希而不是词本身，
-- 是因为这一列在主键里——键长得越小越好，而词列表能从哈希反推不出来也不需要反推。
--
-- 【为什么多一列 index_built_at（spec 的表里没有）】它是**索引指纹**，与 `repo_indexes.built_at`
-- 比对。没有它就有这一条错：同一个 commit 先索引失败（或建得少），缓存了一份树/瘦地图，
-- 之后 `index:repo --rebuild` 修好了同一个 commit —— 缓存键（repo, commit, 词, 预算）一模一样，
-- 于是"地图永远停在旧的那份"，而模型看到的符号列表是错的。加上指纹之后，重新索引会换 built_at，
-- 缓存自然失效。见附录 A-57。
--
-- 【为什么要按 commit 保留版本】每条地图是几 KB 的文本，而一个活跃仓库每个 commit 都可能
-- 有好几条（不同的任务词）。与 009 的符号表同一条理由：留最近两版（当前 + 上一版足够回放排障），
-- 更老的整段删掉（`pruneRepoMaps()`）。地图是派生物，删了随时能重算。
--
-- 【为什么 budget_tokens 在主键里而不是当个普通列】1500 与 3000 渲染出来的是**两份不同的文本**
-- （截断位置不同），共用一行会让"读到一份不属于自己预算的地图"变成可能——那正是回放对不齐的原因。

CREATE TABLE repo_maps (
  repo_key             text NOT NULL,               -- owner/name（与 repo_indexes / environments 同口径）
  commit_sha           text NOT NULL,               -- 地图建在哪一个快照上（base commit）
  personalization_hash text NOT NULL,               -- 任务词的哈希（personalize.ts 的 terms）
  budget_tokens        integer NOT NULL,            -- 渲染用的 token 预算
  text                 text NOT NULL,               -- 地图正文（不含"本次 Run 已改动"那行）
  hash                 text NOT NULL,               -- sha256(text)，回放比对与 UI 用
  tokens               integer NOT NULL,            -- 正文的 token 估算（chars/4）
  index_built_at       timestamptz NOT NULL,        -- 索引指纹：与 repo_indexes.built_at 相等才算命中
  built_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_key, commit_sha, personalization_hash, budget_tokens),
  CONSTRAINT repo_maps_budget_check CHECK (budget_tokens > 0),
  CONSTRAINT repo_maps_tokens_check CHECK (tokens >= 0)
);

-- 保留策略（"这个 (repo, commit) 上次渲染是什么时候"）与排障都按它排。
CREATE INDEX repo_maps_recent_idx ON repo_maps (repo_key, commit_sha, built_at DESC);
