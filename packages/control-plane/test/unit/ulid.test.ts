/**
 * CP 侧 ULID 的最小契约测试。
 *
 * 不去重测编码细节（沙箱侧的 `packages/sandbox-agent/test/ulid.test.ts` 已经覆盖过）——
 * 这里只盯住**跨层契约**：id 的形状（前缀 + 26 字符）与"字典序 = 时间序"。
 * 后者是 DB 主键、容器标签、日志文件名都依赖的性质（spec §0.1）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prefixedId, ulid } from "../../src/ulid.ts";

describe("ulid", () => {
  test("26 个 Crockford base32 字符，且同一毫秒内不重复", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = ulid(1_700_000_000_000);
      assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      ids.add(id);
    }
    assert.equal(ids.size, 200, "同一毫秒里生成了重复的 ULID");
  });

  test("字典序 = 时间序", () => {
    const early = ulid(1_700_000_000_000);
    const late = ulid(1_700_000_001_000);
    assert.ok(early < late, `${early} 应该排在 ${late} 前面`);
  });

  test("prefixedId 带上前缀（sbx_ / art_）", () => {
    const id = prefixedId("sbx", 1_700_000_000_000);
    assert.match(id, /^sbx_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
