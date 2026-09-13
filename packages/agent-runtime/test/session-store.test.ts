/**
 * Phase 2 · `SessionStore` 的内存实现 + 同一条契约的本地执行。
 *
 * 契约体在 `session-store-contract.ts`（不匹配 `test/*.test.ts`，所以不会被单独跑）；
 * 同一份断言在 CP 的 `session-store.integration.test.ts` 里对 Postgres 再跑一遍。
 * 这份单测回答的是"没有 PG 时，编排能不能被验证"——P2 的沙箱租约与续轮测试都建立在它上。
 */

import { MemorySessionStore } from "../src/session/memory.ts";
import { sessionStoreContract } from "./session-store-contract.ts";

sessionStoreContract("内存实现", {
  async create() {
    return new MemorySessionStore();
  },
  async breakUsageWrite(store) {
    (store as MemorySessionStore).failNextUsageWrite();
  },
});
