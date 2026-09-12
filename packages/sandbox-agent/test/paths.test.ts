/**
 * RootResolver 的单元测试：验路径包含性校验。这是安全边界之一，所以用例尽量把
 * 典型的绕过手法都盖了：字符串前缀（/workspace-evil）、NUL 字节、符号链接逃逸
 * （ln -s /etc link 这种）。不要删其中的“符号链接逃逸”那一条——它是这个文件存在的理由。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRootResolver, type RootResolver } from "../src/paths.ts";

/** 建一个临时根目录 + 一个指向它的 resolver；cleanup 删目录。 */
async function fixture(): Promise<{ root: string; resolver: RootResolver; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-paths-"));
  const resolver = await createRootResolver(root);
  return { root, resolver, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("resolve: root 之内的相对路径与绝对路径都通过", async () => {
  const { root, resolver, cleanup } = await fixture();
  try {
    await mkdir(path.join(root, "repo"), { recursive: true });
    await writeFile(path.join(root, "repo", "a.ts"), "x");

    const relative = resolver.resolve("repo/a.ts");
    assert.equal(relative.ok, true);
    assert.equal(relative.ok && relative.abs, path.join(resolver.realRoot, "repo/a.ts"));

    const absolute = resolver.resolve(path.join(resolver.realRoot, "repo", "a.ts"));
    assert.equal(absolute.ok, true);

    assert.equal(resolver.resolve(".").ok, true);
    assert.equal(resolver.resolve("").ok, false);
  } finally {
    await cleanup();
  }
});

test("resolve: 越界路径一律拒", async () => {
  const { resolver, cleanup } = await fixture();
  try {
    const cases = [
      "../../etc/passwd",
      path.join(resolver.realRoot, "..", "..", "etc", "passwd"),
      "/etc/passwd",
      "/",
      // 前缀绕过：裸 startsWith 会让它通过
      `${resolver.realRoot}-evil/file`,
      `${resolver.realRoot}evil`,
    ];
    for (const input of cases) {
      const result = resolver.resolve(input);
      assert.equal(result.ok, false, `${input} 应该被拒`);
      assert.equal(result.ok === false && result.reason, "out_of_bounds");
    }
  } finally {
    await cleanup();
  }
});

test("resolve: NUL 与非字符串拒", async () => {
  const { resolver, cleanup } = await fixture();
  try {
    assert.deepEqual(resolver.resolve("a\0b"), { ok: false, reason: "nul" });
    assert.equal(resolver.resolve(undefined).ok, false);
    assert.equal(resolver.resolve(42).ok, false);
  } finally {
    await cleanup();
  }
});

test("resolve: 符号链接逃逸被拒（第 4 步 realpath 检查）", async () => {
  const { root, resolver, cleanup } = await fixture();
  try {
    await symlink("/etc", path.join(root, "link"));
    const escaped = resolver.resolve("link/passwd");
    assert.equal(escaped.ok, false);
    assert.equal(escaped.ok === false && escaped.reason, "out_of_bounds");
  } finally {
    await cleanup();
  }
});

test("resolve: root 之内不存在的路径仍然通过（运行期事实，不是策略违规）", async () => {
  const { resolver, cleanup } = await fixture();
  try {
    const result = resolver.resolve("does/not/exist");
    assert.equal(result.ok, true);
  } finally {
    await cleanup();
  }
});

test("resolve: root 之内的符号链接正常通过", async () => {
  const { root, resolver, cleanup } = await fixture();
  try {
    await mkdir(path.join(root, "real-dir"), { recursive: true });
    await symlink(path.join(root, "real-dir"), path.join(root, "alias"));
    const result = resolver.resolve("alias/file.txt");
    assert.equal(result.ok, true);
  } finally {
    await cleanup();
  }
});
