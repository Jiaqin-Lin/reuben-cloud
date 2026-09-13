/**
 * Phase 7 · `cache.ts` 的单测（`npm test`，**不需要 docker / PG / 网络**）。
 *
 * 【它拦住的是哪一类回归】缓存键的两条性质都只能用"算两次比一比"来证明：
 *  · **稳定**——同一份事实算两次必须逐字节相同。采集顺序、对象键序、注释与空白漂一次，
 *    缓存就永远不命中，而症状是"每次都在重新建环境"（看起来像性能问题，其实是键算错了）。
 *  · **敏感**——任何影响产物的事实变了就必须变。少一项（例如忘了 `BUILDER_VERSION`）的症状
 *    是"本地是好的、线上是旧的"，那是最难查的一类错（设计文档 §C.5 的原话）。
 *
 * 【它不替代什么】"真构建两次第二次真的命中"由集成测试证明；这里只证明键本身的行为。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BUILDER_VERSION, canonicalSignals, computeCacheKey, shortCacheKey } from "../../src/environment/cache.ts";
import { fakeCandidate, fakeSignals } from "../environment-fakes.ts";

describe("Phase 7 · 缓存键", () => {
  test("同一份信号两次计算 → 逐字节相同（含键序与数组序的规范化）", () => {
    const a = fakeSignals({
      runtimeVersions: { node: "24", python: "3.12" },
      lockfiles: ["pnpm-lock.yaml", "package-lock.json"],
      ciCommands: ["npm test", "npm ci"],
      ignored: [
        { source: "compose.yaml", field: "mounts", reason: "忽略挂载" },
        { source: ".github/workflows/ci.yml", field: "run", reason: "块状 run 没解析" },
      ],
    });
    // 同一份事实的另一种写法：数组顺序不同、对象键序不同、带注释与多余空白。
    const b = fakeSignals({
      runtimeVersions: { python: " 3.12 ", node: "24" },
      lockfiles: ["package-lock.json", "pnpm-lock.yaml", "pnpm-lock.yaml"],
      ciCommands: ["npm ci", "# 这是注释", "npm test", "  "],
      ignored: [
        { source: ".github/workflows/ci.yml", field: " run ", reason: "块状 run 没解析" },
        { source: "compose.yaml", field: "mounts", reason: "忽略挂载" },
      ],
    });
    assert.equal(canonicalSignals(a), canonicalSignals(b));
    assert.equal(computeCacheKey({ baseImage: "img", signals: a, dockerfileText: "FROM x\n" }),
      computeCacheKey({ baseImage: "img", signals: b, dockerfileText: "FROM x\n" }));
  });

  test("语言与包管理器的顺序是结论，不参与排序（换了顺序就是换了事实）", () => {
    const node = fakeSignals({ languages: ["typescript", "python"] });
    const python = fakeSignals({ languages: ["python", "typescript"] });
    assert.notEqual(canonicalSignals(node), canonicalSignals(python));
  });

  test("dockerfileText / baseImage 变了 → 键变", () => {
    const signals = fakeSignals();
    const base = computeCacheKey({ baseImage: "base-node-dev", signals, dockerfileText: "FROM a\n" });
    assert.notEqual(base, computeCacheKey({ baseImage: "base-node-dev", signals, dockerfileText: "FROM b\n" }));
    assert.notEqual(base, computeCacheKey({ baseImage: "base-python-dev", signals, dockerfileText: "FROM a\n" }));
  });

  test("BUILDER_VERSION + 1 → 键变（改 prompt / 改 Layer 1 时唯一能失效旧缓存的手段）", () => {
    const signals = fakeSignals();
    const input = { baseImage: "img", signals, dockerfileText: "FROM x\n" };
    assert.equal(computeCacheKey(input), computeCacheKey({ ...input, builderVersion: BUILDER_VERSION }));
    assert.notEqual(computeCacheKey(input), computeCacheKey({ ...input, builderVersion: BUILDER_VERSION + 1 }));
  });

  test("加一条忽略项 / 换一个构建命令 → 键变（省略号里藏的差异不能吞掉）", () => {
    const base = fakeSignals();
    const withIgnored = fakeSignals({ ignored: [{ source: "a", field: "b", reason: "c" }] });
    const withScript = fakeSignals({ scripts: ["build", "test"] });
    const key = (signals: ReturnType<typeof fakeSignals>): string =>
      computeCacheKey({ baseImage: "img", signals, dockerfileText: "FROM x\n" });
    assert.notEqual(key(base), key(withIgnored));
    assert.notEqual(key(base), key(withScript));
  });

  test("短键是前 12 位（UI 与日志用；不会把界面撑爆）", () => {
    const key = computeCacheKey({ baseImage: "img", signals: fakeSignals(), dockerfileText: "FROM x\n" });
    assert.equal(shortCacheKey(key), key.slice(0, 12));
    assert.equal(key.length, 64, "sha256 的十六进制形态");
  });

  test("候选的 dockerfile 就是键里的那份文本（P6 的文本回写让这条成立）", () => {
    const candidate = fakeCandidate({ dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN echo hi\n" });
    const key = computeCacheKey({
      baseImage: candidate.baseImage,
      signals: fakeSignals(),
      dockerfileText: candidate.dockerfile,
    });
    const other = computeCacheKey({
      baseImage: candidate.baseImage,
      signals: fakeSignals(),
      // 自愈改过的那份（A-38 会把它写回 environments.dockerfile）
      dockerfileText: "FROM reuben-cloud/base-node-dev:dev\nRUN echo hi && echo more\n",
    });
    assert.notEqual(key, other);
  });
});
