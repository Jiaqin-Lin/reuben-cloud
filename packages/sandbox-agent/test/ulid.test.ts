import test from "node:test";
import assert from "node:assert/strict";
import { ulid } from "../src/ulid.ts";

test("ulid: 26 个 Crockford base32 字符（无 I/L/O/U）", () => {
  for (let i = 0; i < 100; i += 1) {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  }
});

test("ulid: 时间戳前缀按字典序单调", () => {
  const early = ulid(1_700_000_000_000);
  const late = ulid(1_700_000_001_000);
  assert.ok(early < late, `${early} 应该排在 ${late} 之前`);
  assert.ok(early.slice(0, 10) < late.slice(0, 10));
});

test("ulid: 同一毫秒内不重复", () => {
  const seen = new Set<string>();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 10_000; i += 1) seen.add(ulid(now));
  assert.equal(seen.size, 10_000);
});

test("ulid: 按 id 排序等价于按时间排序", () => {
  const ids = [ulid(1), ulid(2), ulid(3_000), ulid(4_000_000)];
  assert.deepEqual([...ids].sort(), ids);
});
