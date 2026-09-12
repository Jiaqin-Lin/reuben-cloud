/**
 * RootResolver 的单元测试：验路径包含性校验。这是安全边界之一，所以用例尽量把
 * 典型的绕过手法都盖了：字符串前缀（/workspace-evil）、NUL 字节、符号链接逃逸
 * （ln -s /etc link 这种）。不要删其中的“符号链接逃逸”那一条——它是这个文件存在的理由。
 *
 * Phase 2 起多两件事：读多根 / 写单根。fixture 会额外建一个**不在 workspace 里**的读根，
 * 用它验证「读得到、写不进去」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRootResolver, resolveFailureError, type RootResolver } from "../src/paths.ts";

/** 建一个临时写根 + 一个临时读根 + 指向它们的 resolver；cleanup 删两个目录。 */
async function fixture(): Promise<{
  root: string;
  extraRoot: string;
  resolver: RootResolver;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-paths-"));
  const extraRoot = await mkdtemp(path.join(os.tmpdir(), "rc-paths-read-"));
  const resolver = await createRootResolver({ writeRoot: root, readRoots: [extraRoot] });
  return {
    root,
    extraRoot,
    resolver,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(extraRoot, { recursive: true, force: true });
    },
  };
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

    // 写路径同样要拦：尾段不存在也不能例外（ln -s /etc x && echo pwn > x/passwd）
    const writeEscaped = resolver.resolve("link/pwn", { forWrite: true });
    assert.equal(writeEscaped.ok, false);
    assert.equal(writeEscaped.ok === false && writeEscaped.reason, "out_of_bounds");
  } finally {
    await cleanup();
  }
});

test("resolve: root 之内不存在的路径仍然通过（运行期事实，不是策略违规）", async () => {
  const { resolver, cleanup } = await fixture();
  try {
    assert.equal(resolver.resolve("does/not/exist").ok, true);
    // 写路径更常见：目标就是要新建的文件
    assert.equal(resolver.resolve("does/not/exist.txt", { forWrite: true }).ok, true);
  } finally {
    await cleanup();
  }
});

test("resolve: root 之内的符号链接正常通过", async () => {
  const { root, resolver, cleanup } = await fixture();
  try {
    await mkdir(path.join(root, "real-dir"), { recursive: true });
    await symlink(path.join(root, "real-dir"), path.join(root, "alias"));
    assert.equal(resolver.resolve("alias/file.txt").ok, true);
  } finally {
    await cleanup();
  }
});

test("resolve: 读能在任一读根之下，写只能在写根之下", async () => {
  const { root, extraRoot, resolver, cleanup } = await fixture();
  try {
    await writeFile(path.join(extraRoot, "out.txt"), "externalized tool result");

    // 读：额外读根（绝对路径）→ 通过
    const read = resolver.resolve(path.join(extraRoot, "out.txt"));
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.abs, path.join(resolver.realReadRoots[1]!, "out.txt"));

    // 写：同一个路径 → 拒。写必须落在 workspace，否则 diff/archive 看不见它。
    const write = resolver.resolve(path.join(extraRoot, "out.txt"), { forWrite: true });
    assert.equal(write.ok, false);
    assert.equal(write.ok === false && write.reason, "out_of_bounds");

    // 读：写根照样是读根之一（刚 PUT 进去的东西必须能 GET 回来）
    await writeFile(path.join(root, "in.txt"), "workspace file");
    assert.equal(resolver.resolve("in.txt").ok, true);
    assert.equal(resolver.resolve("in.txt", { forWrite: true }).ok, true);
  } finally {
    await cleanup();
  }
});

test("resolveFailureError: 措辞按读/写分开，错误码稳定", async () => {
  const { resolver, cleanup } = await fixture();
  try {
    const write = resolveFailureError("out_of_bounds", resolver, true);
    assert.equal(write.error, "path_out_of_bounds");
    assert.match(String(write.message), /write root/);

    const read = resolveFailureError("out_of_bounds", resolver, false);
    assert.equal(read.error, "path_out_of_bounds");
    assert.match(String(read.message), /read roots/);

    assert.equal(resolveFailureError("empty", resolver, false).error, "invalid_path");
    assert.equal(resolveFailureError("nul", resolver, true).error, "invalid_path");
  } finally {
    await cleanup();
  }
});

test("resolve: 额外读根不存在时会被建出来（启动期 mkdir -p）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-paths-"));
  const missing = path.join(root, "not-yet");
  try {
    const resolver = await createRootResolver({ writeRoot: root, readRoots: [missing] });
    assert.equal(resolver.resolve(path.join(missing, "future.txt")).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve: 相对根路径在启动期就报错，不等到运行时", async () => {
  await assert.rejects(
    () => createRootResolver({ writeRoot: "relative/path", readRoots: [] }),
    /must be absolute/,
  );
});
