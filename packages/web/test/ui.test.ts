/**
 * Phase 13 · 前端资源的契约（不需要浏览器、不需要网络）。
 *
 * 【为什么这些"只是读文件"的检查值得写】这个前端**没有构建**，所以也没有构建会把错误
 * 拦在前面：一个 JS 语法错误、一个漏掉的事件分支、一个指向 CDN 的字体，都会一直安静地
 * 待到"打开浏览器才发现"。这里把三类问题变成 `npm test` 里的红：
 *
 *  ① **契约**：`index.html` 里引的东西必须真的存在，而且在 CP 的静态白名单里
 *     （白名单是唯一的出口，见 `web/static.ts`，漏一个就是线上 404）。
 *  ② **完整**：`app.js` 必须能解析（`vm.Script` 整份语法检查），且 `RunEvent` 的每一个
 *     `type` 都有一个 `case`（后端加了事件类型而前端没跟上时，页面上会少一整类信息）。
 *  ③ **可比对的性质**：不引外部资源（离线可用）、不用 innerHTML（外部输入进 DOM 的唯一
 *     安全通道是 textContent）、对比度真的到 AA。
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { RunEvent } from "../../control-plane/src/agent/events.ts";
import { STATIC_FILES } from "../../control-plane/src/web/static.ts";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

const html = await readFile(path.join(publicDir, "index.html"), "utf8");
const appJs = await readFile(path.join(publicDir, "app.js"), "utf8");
const css = await readFile(path.join(publicDir, "style.css"), "utf8");

/**
 * 编译期清单：漏掉一个 `RunEvent.type` 这里就是类型错误（不是运行期才发现）。
 * 运行期再把这份清单与 `app.js` 的 `case` 比一遍。
 */
const EVENT_TYPES: Record<RunEvent["type"], true> = {
  run_start: true,
  turn: true,
  text: true,
  tool_call: true,
  tool_result: true,
  exec_start: true,
  exec_output: true,
  exec_end: true,
  note: true,
  run_end: true,
  run_error: true,
};

/** 页面里出现的外部地址（一个都不该有：离线可用是它的前提之一）。 */
function externalRefs(source: string): string[] {
  return [...source.matchAll(/https?:\/\/[^\s"')]+/g)].map((match) => match[0]);
}

describe("Phase 13 · 静态资源的契约", () => {
  test("index.html 引到的每个资源都存在，并且都在 CP 的静态白名单里", async () => {
    const referenced = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(referenced.length >= 2, "至少要有样式表和脚本");
    for (const url of referenced) {
      assert.equal(STATIC_FILES[url] !== undefined, true, `${url} 不在静态白名单里，打开页面就会 404`);
      const file = STATIC_FILES[url]!;
      const body = await readFile(path.join(publicDir, file.file));
      assert.ok(body.byteLength > 0, `${file.file} 是空的`);
    }
  });

  test("public/ 里的每个文件都是可访问的（不存在「放了但拿不到」的资源）", async () => {
    const files = await readdir(publicDir);
    const served = new Set(Object.values(STATIC_FILES).map((entry) => entry.file));
    for (const file of files) {
      assert.equal(served.has(file), true, `${file} 在白名单里没有对应项，浏览器永远拿不到它`);
    }
  });

  test("页面结构：run id、日志容器、状态行、主题按钮都在，且声明了中文与模块脚本", () => {
    assert.match(html, /<html lang="zh-CN"/);
    assert.match(html, /<script type="module" src="\/app\.js">/);
    for (const id of ["log", "state", "state-text", "theme", "run-id", "jump", "jump-button", "sentinel"]) {
      assert.match(html, new RegExp(`id="${id}"`), `index.html 少了 #${id}`);
    }
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<noscript>/);
  });

  test("没有任何外部地址（字体 / CDN / 分析都不许有）", () => {
    assert.deepEqual(externalRefs(html), []);
    assert.deepEqual(externalRefs(appJs), []);
    assert.deepEqual(externalRefs(css), []);
    // CSS 里的 `@import` 与 `url(...)` 也算外部依赖（哪怕是相对的，也不再是"三个文件"）。
    assert.equal(/@import/.test(css), false, "样式表不许 import");
    assert.equal(/url\(/.test(css), false, "样式表不许引外部资源");
  });
});

describe("Phase 13 · app.js 的完整性", () => {
  test("整份语法检查（一个笔误就会让整页白屏，这里必须拦住）", () => {
    assert.doesNotThrow(() => new vm.Script(appJs, { filename: "app.js" }));
  });

  test("每个 RunEvent.type 都有分支（后端加事件时前端不会静默丢一类）", () => {
    const types = Object.keys(EVENT_TYPES) as Array<RunEvent["type"]>;
    assert.ok(types.length >= 11);
    for (const type of types) {
      assert.match(appJs, new RegExp(`case "${type}":`), `app.js 没有处理 ${type}`);
    }
  });

  test("外部输入一律走 textContent：不拼 HTML", () => {
    // 看**用法**而不是关键词：注释里说"不拼 HTML"不该被自己的检查拦住。
    for (const pattern of [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML\(/, /document\.write\(/]) {
      assert.equal(pattern.test(appJs), false, `app.js 里出现了 ${pattern}：模型输出、命令输出、题面都是外部输入`);
    }
    assert.match(appJs, /textContent/);
    assert.match(appJs, /createTextNode/);
  });

  test("EventSource 自带重连，但状态要显示对（onopen / onerror 都有）", () => {
    assert.match(appJs, /new EventSource\(/);
    assert.match(appJs, /source\.onopen/);
    assert.match(appJs, /source\.onerror/);
    assert.match(appJs, /重连中/);
  });
});

describe("Phase 13 · 样式里的可比对性质", () => {
  test("浅色与深色两套 token 都在，且只有一个圆角尺度", () => {
    assert.match(css, /:root\[data-theme="light"\]\s*\{/);
    assert.match(css, /:root\[data-theme="dark"\]\s*\{/);
    // 只看声明（行首缩进的那种），注释里提到 `--radius: 10px` 不算。
    const declarations = [...css.matchAll(/^\s*--radius:/gm)];
    assert.equal(declarations.length, 1, "圆角只该有一个尺度（声明点）");
    // 各处不许写死 px 圆角；`50%` 是状态点，那本来就是个圆点。
    assert.equal(/border-radius:\s*[0-9.]+px/.test(css), false, "不许在各处写死圆角，统一用 var(--radius)");
  });

  test("prefers-reduced-motion 与键盘焦点都有兜底", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /:focus-visible/);
  });

  test("正文 / 次要文字 / 强调文字 / 实心按钮上的字，对比度都在 WCAG AA 之上", () => {
    for (const theme of ["light", "dark"]) {
      const tokens = tokensOf(css, `:root[data-theme="${theme}"]`);
      const check = (label: string, fg: string, bg: string, min = 4.5): void => {
        const ratio = contrast(tokens[fg]!, tokens[bg]!);
        assert.ok(
          ratio >= min,
          `${theme} 的 ${label}（${fg} on ${bg}）只有 ${ratio.toFixed(2)}:1，低于 ${min}:1`,
        );
      };
      check("正文", "--ink", "--bg");
      check("正文 / 卡片", "--ink", "--surface");
      check("正文 / 代码区", "--ink", "--sunken");
      check("次要文字", "--ink-muted", "--bg");
      check("次要文字 / 代码区", "--ink-muted", "--sunken");
      check("强调文字", "--accent-text", "--bg");
      check("强调文字 / 卡片", "--accent-text", "--surface");
      check("强调文字 / 代码区", "--accent-text", "--sunken");
      check("错误文字", "--danger", "--sunken");
      check("实心按钮上的字", "--on-accent", "--accent");
    }
  });
});

// ---------------------------------------------------------------- 小工具

/** 取一段选择器里的自定义属性（只认 `--name: value;`，够用且不引 CSS 解析器）。 */
function tokensOf(source: string, selector: string): Record<string, string> {
  const at = source.indexOf(selector);
  assert.notEqual(at, -1, `样式里找不到 ${selector}`);
  const start = source.indexOf("{", at);
  const end = source.indexOf("}", start);
  const body = source.slice(start + 1, end);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) tokens[match[1]!] = match[2]!.trim();
  return tokens;
}

/** WCAG 相对亮度对比度。`#rrggbb` 进，比值出。 */
function contrast(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const channel = (raw: number): number => {
    const scaled = raw / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255)
  );
}
