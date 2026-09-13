/**
 * Phase 6 · `generate.ts` 的单测（`npm test`，**不需要 docker / PG / 网络 / 真模型**）。
 *
 * 【它证明什么】
 *  ① **prompt 里真的有该有的东西**：信号、规则基线、上一轮的错误分类与日志尾部。prompt 是
 *     自愈循环的输入，它漏掉信号时模型会"凭空发挥"，而那种失败在集成测试里只表现为"没修好"，
 *     查起来很贵；
 *  ② **回复解析**：带围栏的代码块、裸 Dockerfile、以及"两者都不是"（要如实失败，不能把
 *     一段散文当成 Dockerfile 去 build）；
 *  ③ **硬约束真的会拦下生成结果**（fixture 里每一条约束都有一个反例文件）；
 *  ④ **生成请求的形状**：`cache: "none"`（一次性请求）、无工具、system 是那份固定提示词，
 *     以及失败被包成 `GenerationError`（自愈循环靠类型分支，不靠字符串）。
 *
 * 【它不替代什么】真模型会不会按格式输出、会不会把包名改对——那是 live 测试与运气的事，
 * 这里只保证"模型给了什么，我们怎么处理"这一段是确定的。
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  createAssistantMessageEventStream,
  emptyUsage,
} from "@reuben-cloud/agent-runtime";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  ModelClient,
  ModelRequest,
  StopReason,
  Usage,
} from "@reuben-cloud/agent-runtime";
import type { BuildFailure } from "../../src/environment/build.ts";
import {
  buildGenerationUserMessage,
  ENV_GENERATION_SYSTEM_PROMPT,
  GenerationError,
  ModelDockerfileGenerator,
  parseDockerfileBlock,
  renderSignalsForPrompt,
  validateGeneratedDockerfile,
  GENERATION_MAX_TOKENS,
} from "../../src/environment/generate.ts";
import { fakeCandidate, fakeSignals } from "../environment-fakes.ts";

const DOCKERFILE_FIXTURES = fileURLToPath(new URL("../fixtures/dockerfiles/", import.meta.url));

// ---------------------------------------------------------------- 脚本化模型

/** 一步脚本：往流里推事件（与 agent-compaction.test.ts 的写法同源）。 */
function stepText(text: string, options: { stopReason?: StopReason; usage?: Usage; errorMessage?: string } = {}) {
  const reason = options.stopReason ?? "stop";
  return (stream: AssistantMessageEventStream): void => {
    const usage = options.usage ?? emptyUsage();
    if (reason === "error" || reason === "aborted") {
      const message: AssistantMessage = {
        role: "assistant",
        content: text === "" ? [] : [{ type: "text", text }],
        usage,
        stopReason: reason,
        errorMessage: options.errorMessage ?? "boom",
      };
      stream.push({ type: "error", reason, error: message });
      return;
    }
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      usage,
      stopReason: reason,
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [] } });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    stream.push({ type: "done", reason: reason === "length" ? "length" : "stop", message });
  };
}

function scriptedModel(steps: Array<(stream: AssistantMessageEventStream) => void>): {
  model: ModelClient;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let calls = 0;
  return {
    requests,
    model: {
      provider: "scripted",
      model: "scripted-env",
      stream(request: ModelRequest): AssistantMessageEventStream {
        requests.push(request);
        const stream = createAssistantMessageEventStream();
        const step = steps[calls] ?? stepText("");
        calls += 1;
        void Promise.resolve().then(() => step(stream));
        return stream;
      },
    },
  };
}

// ---------------------------------------------------------------- prompt

describe("Phase 6 · 生成 prompt", () => {
  test("system prompt 写了全部硬约束与 Layer 1 的可选清单", () => {
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /FROM 必须是 Layer 1/);
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /reuben-cloud\/base-node-dev:dev/);
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /reuben-cloud\/base-ubuntu-dev:dev/);
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /CMD \/ ENTRYPOINT/);
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /COPY \/ ADD/);
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /USER 1000:1000/);
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /凭据/);
    assert.match(ENV_GENERATION_SYSTEM_PROMPT, /curl/);
  });

  test("信号段落带上了仓库事实与规则基线，且第一轮没有【上一次尝试】", () => {
    const message = buildGenerationUserMessage({
      signals: fakeSignals({
        languages: ["python"],
        packageManagers: ["poetry"],
        services: ["postgres"],
        monorepo: true,
        ignored: [{ source: "compose.yaml", field: "depends_on", reason: "只做行级扫描" }],
      }),
      baseline: "FROM reuben-cloud/base-python-dev:dev\n",
    });
    assert.match(message, /python/);
    assert.match(message, /poetry/);
    assert.match(message, /package-lock\.json/);
    assert.match(message, /npm test/);
    assert.match(message, /make build/);
    assert.match(message, /postgres/);
    assert.match(message, /compose\.yaml#depends_on（只做行级扫描）/);
    assert.match(message, /规则生成的基线/);
    assert.match(message, /FROM reuben-cloud\/base-python-dev:dev/);
    assert.doesNotMatch(message, /上一次尝试/);
  });

  test("第二轮带上错误分类、一句诊断、日志尾部与上一版 Dockerfile", () => {
    const failure: BuildFailure = {
      klass: "apt_package_missing",
      detail: "libvips42-dev",
      advice: "这个包在基础镜像的发行版里不存在（libvips42-dev）",
    };
    const log = Array.from({ length: 60 }, (_, index) => `log-line-${index + 1}`).join("\n");
    const message = buildGenerationUserMessage({
      signals: fakeSignals(),
      baseline: "FROM reuben-cloud/base-node-dev:dev\n",
      retry: { previousDockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN apt-get install -y libvips42-dev\n", failure, logTail: log },
    });
    assert.match(message, /错误分类：apt_package_missing/);
    assert.match(message, /libvips42-dev/);
    assert.match(message, /log-line-60/);
    // 只带尾部 40 行：第 20 行不该出现（60 - 40 = 20）。
    assert.doesNotMatch(message, /log-line-19\n/);
    assert.match(message, /RUN apt-get install -y libvips42-dev/);
  });

  test("生成阶段失败的那一轮（没有构建日志）不会给模型看一个空日志块", () => {
    const message = buildGenerationUserMessage({
      signals: fakeSignals(),
      baseline: "FROM reuben-cloud/base-node-dev:dev\n",
      retry: {
        previousDockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
        failure: { klass: "constraint_violation", detail: "出现了 CMD", advice: "别再写 CMD" },
        logTail: "",
      },
    });
    assert.match(message, /没有构建日志/);
    assert.match(message, /constraint_violation/);
  });

  test("信号里很长的清单会被截断（prompt 不能被采集的噪声撑爆）", () => {
    const rendered = renderSignalsForPrompt(
      fakeSignals({ ciCommands: Array.from({ length: 30 }, (_, index) => `cmd-${index}`) }),
    );
    assert.match(rendered, /cmd-19/);
    assert.doesNotMatch(rendered, /cmd-20/);
    assert.match(rendered, /还有 10 条/);
  });
});

// ---------------------------------------------------------------- 解析与校验

describe("Phase 6 · Dockerfile 解析", () => {
  test("带围栏的代码块（有/无语言标记都行）", () => {
    assert.deepEqual(parseDockerfileBlock("说明\n```dockerfile\nFROM a\nRUN b\n```\n尾巴"), {
      ok: true,
      dockerfile: "FROM a\nRUN b\n",
    });
    assert.deepEqual(parseDockerfileBlock("```\nFROM a\n```"), { ok: true, dockerfile: "FROM a\n" });
  });

  test("整段回复就是 Dockerfile（注释开头也算）时不浪费一轮尝试", () => {
    assert.deepEqual(parseDockerfileBlock("FROM a\nRUN b"), { ok: true, dockerfile: "FROM a\nRUN b\n" });
    assert.deepEqual(parseDockerfileBlock("# 注释\n  \nFROM a\n"), { ok: true, dockerfile: "# 注释\n  \nFROM a\n" });
  });

  test("不是 Dockerfile 的内容如实失败（不能拿散文去 build）", () => {
    const prose = parseDockerfileBlock("我建议你先装 libvips，然后重试。");
    assert.equal(prose.ok, false);
    const empty = parseDockerfileBlock("```dockerfile\n\n```");
    assert.equal(empty.ok, false);
  });

  test("硬约束：每个反例都被拦、正例通过（fixture 逐条）", async () => {
    const files = (await readdir(DOCKERFILE_FIXTURES)).sort();
    assert.ok(files.includes("good.Dockerfile"), "fixture 目录应当有一个正例");
    for (const file of files) {
      const text = await readFile(path.join(DOCKERFILE_FIXTURES, file), "utf8");
      const violations = validateGeneratedDockerfile(text);
      if (file === "good.Dockerfile") {
        assert.deepEqual(violations, [], "正例不该有违规");
      } else {
        assert.ok(violations.length > 0, `${file} 应当被拦下`);
      }
    }
    // 四条 headline 约束的报错措辞（测试要点 4）。
    assert.match(validateGeneratedDockerfile(await fixture("cmd.Dockerfile"))[0]!, /CMD/);
    assert.match(validateGeneratedDockerfile(await fixture("entrypoint.Dockerfile"))[0]!, /ENTRYPOINT/);
    assert.match(validateGeneratedDockerfile(await fixture("root-no-switch-back.Dockerfile")).join("；"), /root/);
    assert.match(validateGeneratedDockerfile(await fixture("curl-sh.Dockerfile")).join("；"), /下载即执行/);
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(path.join(DOCKERFILE_FIXTURES, name), "utf8");
}

// ---------------------------------------------------------------- 模型生成器

describe("Phase 6 · ModelDockerfileGenerator", () => {
  test("成功：请求形状对（cache none / 无工具）、返回清洗后的文本与用量", async () => {
    const usage: Usage = { inputTokens: 1234, outputTokens: 56, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const { model, requests } = scriptedModel([
      stepText("```dockerfile\nFROM reuben-cloud/base-node-dev:dev\nRUN apt-get install -y jq\n```\n", { usage }),
    ]);
    const generator = new ModelDockerfileGenerator({ model });
    const result = await generator.generate({ signals: fakeSignals(), baseline: fakeCandidate().dockerfile });
    assert.equal(result.dockerfile, "FROM reuben-cloud/base-node-dev:dev\nRUN apt-get install -y jq\n");
    assert.equal(result.provider, "scripted");
    assert.equal(result.model, "scripted-env");
    assert.deepEqual(result.usage, usage);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.cache, "none");
    assert.deepEqual(requests[0]!.tools, []);
    assert.equal(requests[0]!.system, ENV_GENERATION_SYSTEM_PROMPT);
    assert.ok(requests[0]!.maxTokens > 0 && requests[0]!.maxTokens <= GENERATION_MAX_TOKENS);
    assert.match(JSON.stringify(requests[0]!.messages), /规则生成的基线/);
  });

  test("没有代码块：GenerationError(no_dockerfile_block)，原文带着走", async () => {
    const { model } = scriptedModel([stepText("先装 libvips 再试。")]);
    const generator = new ModelDockerfileGenerator({ model });
    await assert.rejects(
      generator.generate({ signals: fakeSignals(), baseline: "FROM a\n" }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.reason, "no_dockerfile_block");
        assert.equal(error.raw, "先装 libvips 再试。");
        return true;
      },
    );
  });

  test("模型报错：GenerationError(model_error)，用量如实带出", async () => {
    const usage: Usage = { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const { model } = scriptedModel([stepText("", { stopReason: "error", usage, errorMessage: "rate limited" })]);
    const generator = new ModelDockerfileGenerator({ model });
    await assert.rejects(
      generator.generate({ signals: fakeSignals(), baseline: "FROM a\n" }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.reason, "model_error");
        assert.match(error.message, /rate limited/);
        assert.deepEqual(error.usage, usage);
        return true;
      },
    );
  });

  test("被取消：GenerationError(aborted)", async () => {
    const { model } = scriptedModel([stepText("", { stopReason: "aborted" })]);
    const generator = new ModelDockerfileGenerator({ model });
    await assert.rejects(
      generator.generate({ signals: fakeSignals(), baseline: "FROM a\n" }),
      (error: unknown) => error instanceof GenerationError && error.reason === "aborted",
    );
  });
});
