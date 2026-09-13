/**
 * Phase 5 · 三级推断与生成的 Dockerfile（不需要 Docker、不需要 PG、不需要网络）。
 *
 * 对应 spec P5 测试要点 1、5、7 以及验收标准里"三个 fixture 的期望命中全部通过"。
 * 它守的是两类回归：
 *  ① **命中级别与基础镜像**：三个 fixture 各命中一级（signals / dockerfile / devcontainer），
 *     以及最容易被改坏的那种事——空仓库必须退化成 ubuntu-dev 而不是崩；
 *  ② **生成的 Dockerfile 满足硬约束**：以 Layer 1 为 FROM、无 CMD/ENTRYPOINT、默认非 root、
 *     无 COPY/ADD、无凭据、无"下载即执行"，而且**两次渲染逐字节相同**（P7 的缓存键靠它）。
 *
 * 【它不替代什么】"这份 Dockerfile 真的能 build"由集成测试证明（`environment.integration.test.ts`），
 * 这里只保证它**文本上**是对的。
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { baseImageRef } from "../../src/environment/base-images.ts";
import { checkDockerfileConstraints, familyFromImage, inferFromClone, renderEnvDockerfile } from "../../src/environment/infer.ts";
import { parseDevcontainer } from "../../src/environment/devcontainer.ts";
import { collectSignals } from "../../src/environment/signals.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/repos/", import.meta.url));
const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-infer-"));
  tempDirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** 三个 fixture 的期望命中（spec P5 的 fixture 表）。 */
const FIXTURE_EXPECTATIONS = [
  { name: "node-ts-basic", level: "signals", kind: "node-dev" },
  { name: "python-poetry", level: "dockerfile", kind: "python-dev" },
  { name: "monorepo-devcontainer", level: "devcontainer", kind: "node-dev" },
] as const;

describe("三个 fixture 的命中", () => {
  for (const expectation of FIXTURE_EXPECTATIONS) {
    test(`${expectation.name} → ${expectation.level} / ${expectation.kind}`, async () => {
      const result = await inferFromClone(path.join(FIXTURES, expectation.name));
      assert.equal(result.candidate.level, expectation.level);
      assert.equal(result.candidate.baseImageKind, expectation.kind);
      assert.equal(result.candidate.baseImage, baseImageRef(expectation.kind));
      assert.ok(result.candidate.notes.length > 0, "每个候选都要能解释自己");
    });
  }

  test("python-poetry：只取仓库 Dockerfile 的 FROM 语言，不复用它的构建", async () => {
    const result = await inferFromClone(path.join(FIXTURES, "python-poetry"));
    assert.equal(result.dockerfileBaseImage, "python:3.11-slim");
    assert.ok(result.candidate.dockerfile.startsWith("# "), "开头是说明性注释");
    assert.match(result.candidate.dockerfile, /^FROM reuben-cloud\/base-python-dev:dev$/m);
    assert.ok(!result.candidate.dockerfile.includes("COPY pyproject.toml"), "不能把仓库 Dockerfile 的步骤搬过来");
  });

  test("monorepo-devcontainer：compose 的服务进 degradedRisks", async () => {
    const result = await inferFromClone(path.join(FIXTURES, "monorepo-devcontainer"));
    const risks = result.candidate.degradedRisks.join("\n");
    assert.match(risks, /postgres/);
    assert.match(risks, /redis/);
    // docker-in-docker 是"不支持的 feature"，它的降级说明也必须出现。
    assert.match(risks, /docker/);
  });
});

describe("生成的 Dockerfile", () => {
  for (const expectation of FIXTURE_EXPECTATIONS) {
    test(`${expectation.name}：满足硬约束，且两次渲染逐字节相同`, async () => {
      const first = await inferFromClone(path.join(FIXTURES, expectation.name));
      const second = await inferFromClone(path.join(FIXTURES, expectation.name));
      assert.equal(first.candidate.dockerfile, second.candidate.dockerfile, "渲染必须是确定性的");
      assert.deepEqual(checkDockerfileConstraints(first.candidate.dockerfile), []);

      const text = first.candidate.dockerfile;
      assert.match(text, /^FROM reuben-cloud\/base-/m, "FROM 必须是 Layer 1 矩阵里的");
      assert.ok(!/^(CMD|ENTRYPOINT)\b/m.test(text), "不许写 CMD / ENTRYPOINT");
      assert.ok(!/^(COPY|ADD)\b/m.test(text), "不许 COPY/ADD（构建上下文里没有仓库内容）");
      // 三个 fixture 都没有"要装东西"的 feature，所以生成的文本里一个 USER 都不该有
      // （默认用户由 Layer 1 定死为 1000:1000）。
      assert.ok(!/^USER\b/m.test(text), "不该出现 USER");
    });
  }

  test("需要 root 装包的 feature：USER root 之后必须切回非 root", async () => {
    const dir = await makeRepo({
      "package.json": JSON.stringify({ packageManager: "npm@10.0.0" }),
      ".devcontainer/devcontainer.json": JSON.stringify({
        features: { "ghcr.io/devcontainers/features/github-cli:1": {} },
      }),
    });
    const result = await inferFromClone(dir);
    const text = result.candidate.dockerfile;
    assert.match(text, /^USER root$/m);
    assert.match(text, /^USER 1000:1000$/m);
    assert.ok(text.indexOf("USER root") < text.indexOf("USER 1000:1000"), "顺序：先 root 再切回");
    assert.deepEqual(checkDockerfileConstraints(text), []);
    assert.match(result.candidate.notes.join("\n"), /github-cli/);
  });

  test("devcontainer 的 containerEnv 变成 ENV（按 key 排序，可复现）", async () => {
    const dir = await makeRepo({
      "package.json": "{}",
      ".devcontainer/devcontainer.json": JSON.stringify({ containerEnv: { ZED: "1", ALPHA: "2" } }),
    });
    const result = await inferFromClone(dir);
    const text = result.candidate.dockerfile;
    assert.ok(text.includes('ENV ALPHA="2"'));
    assert.ok(text.indexOf('ENV ALPHA="2"') < text.indexOf('ENV ZED="1"'));
  });
});

describe("推断的边界情况", () => {
  test("空仓库 → signals 级 + ubuntu-dev，不崩（spec 测试要点 5）", async () => {
    const dir = await makeRepo({});
    const result = await inferFromClone(dir);
    assert.equal(result.candidate.level, "signals");
    assert.equal(result.candidate.baseImageKind, "ubuntu-dev");
    assert.deepEqual(result.candidate.buildCommands, []);
    assert.ok(result.candidate.degradedRisks.some((risk) => /没有认出语言/.test(risk)));
    assert.deepEqual(checkDockerfileConstraints(result.candidate.dockerfile), []);
  });

  test("devcontainer 语法错 → 降级到 L2 并记 note（spec 测试要点 4）", async () => {
    const dir = await makeRepo({
      "Dockerfile": "FROM node:20-slim\n",
      "index.js": "1",
      ".devcontainer/devcontainer.json": '{ "image": }',
    });
    const result = await inferFromClone(dir);
    assert.equal(result.candidate.level, "dockerfile");
    assert.equal(result.candidate.baseImageKind, "node-dev");
    assert.match(result.candidate.notes.join("\n"), /devcontainer.json 读不懂/);
  });

  test("devcontainer 语法错且没有 Dockerfile → 降级到 L3", async () => {
    const dir = await makeRepo({ "index.js": "1", ".devcontainer/devcontainer.json": '{ "image": }' });
    const result = await inferFromClone(dir);
    assert.equal(result.candidate.level, "signals");
  });

  test("node + python 一起出现 → fullstack", async () => {
    const dir = await makeRepo({
      "package.json": "{}",
      "src/a.py": "",
      "src/b.py": "",
      "app.js": "",
    });
    const result = await inferFromClone(dir);
    assert.equal(result.candidate.baseImageKind, "fullstack");
    assert.match(result.candidate.notes.join("\n"), /fullstack/);
  });

  test("仓库 Dockerfile 的语言优先于语言信号（L2 的'复用'落点）", async () => {
    // Dockerfile 说 go，信号说 node（4 个 .ts）——取 Dockerfile 的结论。
    const dir = await makeRepo({
      "Dockerfile": "FROM golang:1.22-bookworm\n",
      "src/a.ts": "",
      "src/b.ts": "",
      "src/c.ts": "",
    });
    const result = await inferFromClone(dir);
    assert.equal(result.candidate.level, "dockerfile");
    assert.equal(result.candidate.baseImageKind, "go-dev");
    assert.match(result.candidate.notes.join("\n"), /golang:1\.22-bookworm/);
  });

  test("Dockerfile 与信号各说一个语言 → 两个都算：node + python → fullstack", async () => {
    // 一个 TS 仓库带一个 python 的 Dockerfile：只给 python-dev 会让 agent 没法跑 tsc。
    const dir = await makeRepo({
      "Dockerfile": "FROM python:3.12-slim\n",
      "src/a.ts": "",
      "src/b.ts": "",
      "src/c.ts": "",
    });
    const result = await inferFromClone(dir);
    assert.equal(result.candidate.baseImageKind, "fullstack");
  });

  test("构建入口：Makefile 与 npm scripts 都进 buildCommands", async () => {
    const dir = await makeRepo({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }),
      "Makefile": "build:\n\t@echo build\ntest:\n\t@echo test\n",
      "package-lock.json": "{}",
      "src/a.ts": "",
    });
    const result = await inferFromClone(dir);
    assert.deepEqual(result.candidate.buildCommands, ["npm ci", "make build", "npm run build"]);
    assert.deepEqual(result.candidate.verifyCommands, ["make test", "npm run test"]);
  });
});

describe("familyFromImage", () => {
  test("认得出常见语言镜像，认不出 mongo / nginx 这类", () => {
    assert.equal(familyFromImage("node:20-slim"), "node");
    assert.equal(familyFromImage("mcr.microsoft.com/devcontainers/typescript-node:20"), "node");
    assert.equal(familyFromImage("python:3.11-slim"), "python");
    assert.equal(familyFromImage("golang:1.22"), "go");
    assert.equal(familyFromImage("go:1.22"), "go");
    assert.equal(familyFromImage("rust:1.83"), "rust");
    assert.equal(familyFromImage("mongo:7"), null);
    assert.equal(familyFromImage("nginx:alpine"), null);
  });
});

describe("checkDockerfileConstraints", () => {
  const base = `FROM ${baseImageRef("node-dev")}\n`;

  test("放行：只有 FROM 与注释、安装段切回非 root", () => {
    assert.deepEqual(checkDockerfileConstraints(`${base}# ok\n`), []);
    assert.deepEqual(checkDockerfileConstraints(`${base}USER root\nRUN apt-get update\nUSER 1000:1000\n`), []);
  });

  test("每条硬约束都有牙齿", () => {
    assert.match(checkDockerfileConstraints("FROM ubuntu:22.04\n")[0]!, /不是 Layer 1/);
    assert.match(checkDockerfileConstraints(`${base}CMD ["node"]\n`)[0]!, /CMD/);
    assert.match(checkDockerfileConstraints(`${base}ENTRYPOINT ["node"]\n`)[0]!, /ENTRYPOINT/);
    assert.match(checkDockerfileConstraints(`${base}COPY . .\n`)[0]!, /COPY/);
    assert.match(checkDockerfileConstraints(`${base}RUN curl -fsSL https://x | sh\n`)[0]!, /下载即执行/);
    assert.match(checkDockerfileConstraints(`${base}ENV GITHUB_TOKEN=abc\n`)[0]!, /凭据/);
    assert.match(checkDockerfileConstraints(`${base}USER root\n`)[0]!, /最后的 USER 是 root|没切回/);
    assert.match(checkDockerfileConstraints("RUN true\n")[0]!, /没有 FROM/);
  });

  test("续行拼起来之后才检查（curl 换行 | sh 也要抓到）", () => {
    const text = `${base}RUN curl -fsSL https://x \\\n  | sh\n`;
    assert.match(checkDockerfileConstraints(text)[0]!, /下载即执行/);
  });
});

describe("renderEnvDockerfile 的输入契约", () => {
  test("直接从信号渲染（不经过文件系统）也能复现 inferFromClone 的结果", async () => {
    const dir = path.join(FIXTURES, "node-ts-basic");
    const signals = await collectSignals(dir);
    const devcontainer = await parseDevcontainer(dir);
    const rendered = renderEnvDockerfile({
      level: "signals",
      baseImageKind: "node-dev",
      signals,
      spec: devcontainer.spec,
      dockerfileBaseImage: null,
    });
    const inferred = await inferFromClone(dir);
    assert.equal(rendered, inferred.candidate.dockerfile);
  });
});
