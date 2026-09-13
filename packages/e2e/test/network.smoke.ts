/**
 * Phase 7 · 出网白名单（`--tag=network`）。
 *
 * §J 的红线里网络占两条："非白名单域名不可达（含 github.com）"与"白名单域名可访问
 * （npm install / pip install 成功）"。前一条在 `isolation` 组（I5/I6，走 curl），
 * 这一组的价值是把**真装一个包**走一遍——它是 §J 的原话，也是唯一能证明
 * "沙箱里 npm 这个工具链真的能用"的断言：curl 能过不等于 npm 能过（npm 还要走 SSL、
 * 重定向、可能走别的域名）。
 *
 * 这一组**不需要 Linux**：白名单是代理容器的事，macOS 的 Docker Desktop 上它同样在跑，
 * 而且 darwin 的端口转发链路（宿主 → 转发容器 → 沙箱 agent）本来就是本地开发最该测的一条。
 * 所以 `--tag=network` 是 macOS 上少数几条可以完整跑完的红线相关用例（三条全都跑）。
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SmokeSandbox, execFail, execOk, smokeGroup } from "../src/harness.ts";

smokeGroup("出网白名单", { tags: ["network"] }, () => {
  let box: SmokeSandbox;

  before(async () => {
    box = await SmokeSandbox.create({ label: "net" });
  });

  after(async () => {
    await box?.destroy();
  });

  test("N1 · 真实装包：npm install 从 registry 拉下来一个包并跑起来", async () => {
    const result = await execOk(
      box,
      [
        "bash",
        "-c",
        // 固定版本、关掉 audit/fund/update-notifier：这些都是对别的域名或非必要流量的请求，
        // 会让"到底是哪一步走了网络"变得模糊，也拖慢 CI。
        [
          "mkdir -p /tmp/npm-install && cd /tmp/npm-install",
          "npm install --no-audit --no-fund --no-save --loglevel=error left-pad@1.3.0",
          "node -e \"const pad=require('/tmp/npm-install/node_modules/left-pad'); console.log('PADDED=[' + pad('x',3) + ']')\"",
        ].join(" && "),
      ],
      {
        timeoutMs: 120_000,
        env: {
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_AUDIT: "false",
        },
      },
    );
    // 装上了、而且可用：`left-pad('x',3)` 用空格左侧补齐成 "  x"。
    assert.match(result.stdout, /PADDED=\[\s\sx\]/, `包没装上或者没跑起来：${result.stdout.trim()} ${result.stderr.trim()}`);
  });

  test("N2 · 内网没有出口 DNS，但代理的服务名能解析", async () => {
    // 没有出口 DNS 正是"想联网就得走代理"的一半原因：就算把代理关掉，
    // 沙箱也解析不出 npmjs.org，不会退化成"直连公网"。
    const external = await execFail(box, ["bash", "-c", "getent hosts npmjs.org"]);
    assert.equal(external.stdout.trim(), "", `内网居然解析出了外网域名：${external.stdout.trim()}`);

    // 反过来的那一半：代理的**服务名**必须能解析（Docker 内网 DNS）。
    // 它挂了的话 HTTP_PROXY 就指向一个不存在的名字，所有出网都会变成 EAI_AGAIN。
    const proxy = await execOk(box, ["bash", "-c", "getent hosts reuben-cloud-proxy"]);
    assert.match(proxy.stdout, /^\d+\.\d+\.\d+\.\d+\s+reuben-cloud-proxy/m, `代理的服务名解析不了：${proxy.stdout.trim()}`);
  });

  test("N3 · 明文 HTTP 走代理时同样按白名单拒掉", async () => {
    // CONNECT（HTTPS）之外的另一条路：明文 HTTP 是绝对 URI 请求，代理按 Host 判。
    // 两条路都要堵，只堵一条等于没堵。
    //
    // 断言的是**状态码不是退出码**：明文 HTTP 的拒绝就是一个普通的 403 响应，
    // curl 认为"请求完成"，退出码是 0（不像 CONNECT 那样报错退出）。
    const result = await execOk(box, [
      "curl",
      "-sS",
      "--max-time",
      "20",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "http://example.com/",
    ]);
    assert.equal(result.stdout.trim(), "403", `明文 HTTP 没有被白名单拒掉（拿到 ${result.stdout.trim()}）`);
  });
});
