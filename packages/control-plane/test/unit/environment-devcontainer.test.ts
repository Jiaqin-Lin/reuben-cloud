/**
 * Phase 5 · devcontainer 子集的解析（不需要 Docker、不需要 PG、不需要网络）。
 *
 * 对应 spec P5 测试要点 3、4。它守的是两件事：
 *  ① **容错**：真实仓库里的 devcontainer.json 是 JSONC（注释 + 尾逗号），而"读不懂"
 *     必须是降级（返回 error）而不是抛异常——否则一个坏文件会让整个环境推断失败；
 *  ② **不静默丢弃**：M2 不支持的字段每条都要进 `ignored[]` 并带原因（设计文档 §C.3 的硬要求），
 *     feature 也一样（支持的四类各有结论，不支持的要有 degraded 说明）。
 *
 * 【它不替代什么】真去按 devcontainer 建一个容器（那是 P6/P7 的事）。这里只断言"我们读到了什么"。
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import {
  featureAction,
  featureKey,
  parseDevcontainer,
  parseJsonc,
} from "../../src/environment/devcontainer.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/repos/", import.meta.url));
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 造一个只有 devcontainer.json 的临时仓库。`content` 为 null 表示"不写这个文件"。 */
async function makeDevcontainerRepo(content: string | null, relative = ".devcontainer/devcontainer.json"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-devcontainer-"));
  tempDirs.push(dir);
  if (content !== null) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

describe("parseJsonc", () => {
  test("注释（行 + 块）与尾逗号都能吃", () => {
    const parsed = parseJsonc(`{
      // 行注释
      "a": 1,
      /* 块
         注释 */
      "b": [1, 2, 3,],
      "c": {"d": 2,},
    }`) as Record<string, unknown>;
    assert.deepEqual(parsed, { a: 1, b: [1, 2, 3], c: { d: 2 } });
  });

  test("字符串里的 // 与 ,} 不当作注释/尾逗号", () => {
    const parsed = parseJsonc('{"url": "https://example.com//x", "weird": "a,}", "escape": "\\"//\\""}') as Record<string, unknown>;
    assert.equal(parsed["url"], "https://example.com//x");
    assert.equal(parsed["weird"], "a,}");
    assert.equal(parsed["escape"], '"//"');
  });

  test("字符串没结束 / 块注释没结束 → 抛（调用方据此降级）", () => {
    assert.throws(() => parseJsonc('{"a": "no end}'));
    assert.throws(() => parseJsonc('{"a": 1} /* 没有收尾'));
  });

  test("保留了行号：语法错的位置指得准", () => {
    try {
      parseJsonc('{\n  "a": 1,\n  "b": ,\n}');
      assert.fail("应当抛");
    } catch (error) {
      assert.match(String(error), /position 24|line 3|Unexpected token/);
    }
  });
});

describe("parseDevcontainer", () => {
  test("fixture：支持的字段全部生效", async () => {
    const result = await parseDevcontainer(path.join(FIXTURES, "monorepo-devcontainer"));
    assert.equal(result.error, null);
    const spec = result.spec!;
    assert.equal(spec.image, "mcr.microsoft.com/devcontainers/typescript-node:20");
    assert.equal(spec.postCreateCommand, "pnpm install");
    assert.deepEqual(spec.containerEnv, { NODE_ENV: "development", CI: "true" });
    assert.deepEqual(
      spec.features.map((feature) => feature.id),
      ["ghcr.io/devcontainers/features/node", "ghcr.io/devcontainers/features/docker-in-docker"],
    );
    assert.deepEqual(spec.features[0]!.options, { version: "20" });
  });

  test("fixture：不支持的字段每条都进 ignored 且带原因", async () => {
    const result = await parseDevcontainer(path.join(FIXTURES, "monorepo-devcontainer"));
    const fields = result.ignored.map((item) => item.field);
    for (const expected of ["mounts", "forwardPorts", "remoteUser", "customizations", "image"]) {
      assert.ok(fields.includes(expected), `ignored 里缺 ${expected}：${JSON.stringify(fields)}`);
    }
    for (const item of result.ignored) {
      assert.equal(item.source, ".devcontainer/devcontainer.json");
      assert.ok(item.reason.length > 8 && !item.reason.startsWith("unsupported"), `原因太含糊：${item.reason}`);
    }
  });

  test("语法错 → 返回 error 而不是抛（spec 测试要点 4）", async () => {
    const dir = await makeDevcontainerRepo('{ "image": }');
    const result = await parseDevcontainer(dir);
    assert.equal(result.spec, null);
    assert.match(result.error!, /不是合法 JSONC/);
    assert.deepEqual(result.ignored, []);
  });

  test("顶层不是对象 → error", async () => {
    const dir = await makeDevcontainerRepo('["docker-in-docker"]');
    const result = await parseDevcontainer(dir);
    assert.equal(result.spec, null);
    assert.match(result.error!, /顶层必须是对象/);
  });

  test("文件不在 → spec 与 error 都是 null（这是正常的 L2/L3 路径，不是错误）", async () => {
    const dir = await makeDevcontainerRepo(null);
    const result = await parseDevcontainer(dir);
    assert.deepEqual(result, { spec: null, ignored: [], error: null });
  });

  test("只有 name 的空 devcontainer 也是一个合法的 spec", async () => {
    const dir = await makeDevcontainerRepo('{ "name": "x" }');
    const result = await parseDevcontainer(dir);
    assert.equal(result.error, null);
    assert.equal(result.spec!.image, null);
    assert.deepEqual(result.spec!.features, []);
    assert.deepEqual(result.ignored, []);
  });

  test("postCreateCommand 的三种形态归一成一条命令", async () => {
    const cases: Array<[string, string | null]> = [
      ['{"postCreateCommand": "npm install"}', "npm install"],
      ['{"postCreateCommand": ["npm install", "npm run build"]}', "npm install && npm run build"],
      ['{"postCreateCommand": {"a": "npm ci", "b": ["npm run build"]}}', "npm ci && npm run build"],
      ['{"postCreateCommand": ""}', null],
    ];
    for (const [content, expected] of cases) {
      const dir = await makeDevcontainerRepo(content);
      const result = await parseDevcontainer(dir);
      assert.equal(result.spec!.postCreateCommand, expected, content);
    }
  });

  test("containerEnv 的值只收字符串/数字/布尔，其余记 ignored", async () => {
    const dir = await makeDevcontainerRepo('{"containerEnv": {"A": "x", "B": 2, "C": true, "D": ["${localEnv:HOME}"]}}');
    const result = await parseDevcontainer(dir);
    assert.deepEqual(result.spec!.containerEnv, { A: "x", B: "2", C: "true" });
    assert.deepEqual(result.ignored.map((item) => item.field), ["containerEnv.D"]);
  });

  test("build 的三种写法：字符串 / 对象 / 带 args", async () => {
    const asString = await parseDevcontainer(await makeDevcontainerRepo('{"build": "./docker/Dockerfile"}'));
    assert.deepEqual(asString.spec!.build, { dockerfile: "./docker/Dockerfile", context: null, args: {} });

    const asObject = await parseDevcontainer(
      await makeDevcontainerRepo('{"build": {"dockerfile": "docker/Dockerfile", "context": "..", "args": {"NODE": "20"}}}'),
    );
    assert.deepEqual(asObject.spec!.build, { dockerfile: "docker/Dockerfile", context: "..", args: { NODE: "20" } });
    assert.deepEqual(asObject.ignored.map((item) => item.field), ["build.args"]);
  });
});

describe("feature 映射表", () => {
  test("featureKey 去掉版本与 digest", () => {
    assert.equal(featureKey("ghcr.io/devcontainers/features/node:1.6.1"), "ghcr.io/devcontainers/features/node");
    assert.equal(featureKey("ghcr.io/devcontainers/features/node"), "ghcr.io/devcontainers/features/node");
    assert.equal(featureKey("ghcr.io/devcontainers/features/node:1@sha256:abc"), "ghcr.io/devcontainers/features/node");
  });

  test("四类结论：语言 / 装 / 已有 / 不支持", () => {
    assert.equal(featureAction("ghcr.io/devcontainers/features/node:1").kind, "language");
    assert.equal(featureAction("ghcr.io/devcontainers/features/github-cli:1").kind, "install");
    assert.equal(featureAction("ghcr.io/devcontainers/features/common-utils:2").kind, "builtin");
    const dind = featureAction("ghcr.io/devcontainers/features/docker-in-docker:2");
    assert.equal(dind.kind, "unsupported");
    assert.ok(dind.kind === "unsupported" && dind.degraded !== null, "不支持的 feature 必须给出降级说明");
  });

  test("本地 feature 与未知 feature 都是不支持（各有理由）", () => {
    const local = featureAction("./features/my-tool");
    assert.equal(local.kind, "unsupported");
    assert.match(local.kind === "unsupported" ? local.reason : "", /本地 feature/);

    const unknown = featureAction("ghcr.io/someone/features/magic:1");
    assert.equal(unknown.kind, "unsupported");
    assert.match(unknown.kind === "unsupported" ? unknown.reason : "", /映射表/);
  });
});
