/**
 * P9 · `memoryRepoMapStore` 跑一遍 `RepoMapStore` 的契约（真库那一半在集成测试里）。
 *
 * 【为什么这条值得单独一个文件】内存实现是单测里"缓存命中 / 指纹失效 / 保留策略"的底座：
 * 它要是把 upsert 写成插入、把 prune 写成"删掉最新的一条"，上面那些用例会全绿着骗人。
 * 契约断言只描述可观察行为，所以两个实现能跑同一份。
 *
 * 【它不替代什么】`ON CONFLICT DO UPDATE`、`timestamptz` 的往返精度只有真 PG 能证——
 * 见 `test/integration/repo-index.integration.test.ts` 的 P9 那一节。
 */

import { memoryRepoMapStore } from "../index-fakes.ts";
import { repoMapStoreContract } from "../repo-map-store-contract.ts";

repoMapStoreContract("内存实现", () => memoryRepoMapStore(), "contract-memory");
