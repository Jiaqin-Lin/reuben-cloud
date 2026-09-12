/**
 * Phase 6 单元测试之一：白名单规则（**不需要 Docker、不需要网络**）。
 *
 * 这一层要守住的是"绕过手法":大小写、尾点、裸通配、IP 直连。它们是出网边界上
 * 最容易被一个想联网的进程（或者一次图省事的改动）打开的口子，而这类东西
 * 只有写成毫秒级断言才会有人真的去跑。
 *
 * 另外顺手把**仓库里那份真的 allowlist.txt** 也断言一遍：它是一份配置，
 * 而配置错误（比如谁把 github.com 加了进去）在这个项目里是红线级别的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AllowlistError,
  describeAllowlist,
  isIpLiteral,
  loadAllowlistFile,
  matchAllowlist,
  normalizeHost,
  parseAllowlist,
  splitAuthority,
} from "../../../../deploy/egress-proxy/src/allowlist.ts";

/** 仓库里那份真清单。它同时也是"交付物之一"——所以它得被测到。 */
const SHIPPED_ALLOWLIST = fileURLToPath(new URL("../../../../deploy/egress-proxy/allowlist.txt", import.meta.url));

test("仓库里的 allowlist.txt：能解析、且没有放行 GitHub", () => {
  const list = loadAllowlistFile(SHIPPED_ALLOWLIST);
  assert.ok(list.rules.length >= 11, `清单太短了，是不是被截断了：${list.rules.length} 条`);

  // 放行的：包管理器源。每条都必须是归一化之后的形态。
  for (const host of ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "deb.debian.org", "proxy.golang.org"]) {
    assert.notEqual(matchAllowlist(list, host), null, `${host} 应该在名单里`);
  }
  assert.equal(parseAllowlist("REGISTRY.NPMJS.ORG", "x").rules[0]!.value, "registry.npmjs.org");

  // §F.2 的红线：GitHub 不在名单里，一个变体也不许有。
  for (const host of ["github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]) {
    assert.equal(matchAllowlist(list, host), null, `${host} 绝不能出现在出网白名单里`);
    assert.equal(
      list.rules.some((rule) => rule.value === host || host.endsWith(`.${rule.value}`)),
      false,
      `清单里有一条规则会放行 ${host}`,
    );
  }

  // 子域通配不匹配 apex：`*.npmjs.org` 不会放行 `npmjs.org` 本身。
  const wildcard = parseAllowlist("*.npmjs.org", "x");
  assert.notEqual(matchAllowlist(wildcard, "registry.npmjs.org"), null);
  assert.notEqual(matchAllowlist(wildcard, "a.b.npmjs.org"), null);
  assert.equal(matchAllowlist(wildcard, "npmjs.org"), null, "apex 需要单独写一行");
  assert.equal(matchAllowlist(wildcard, "evilnpmjs.org"), null, "后缀匹配必须带点边界");
  assert.equal(matchAllowlist(wildcard, "npmjs.org.evil.com"), null);
});

test("解析：注释、空行、CRLF、行尾注释", () => {
  const list = parseAllowlist(
    ["# 头部注释", "", "registry.npmjs.org   # npm", "  ", "pypi.org", "", "# 尾部注释", ""].join("\r\n"),
    "test",
  );
  assert.deepEqual(
    list.rules.map((rule) => rule.value),
    ["registry.npmjs.org", "pypi.org"],
  );
  assert.deepEqual(list.warnings, []);
});

test("解析：重复条目去重（规则条数是日志字段，不能被重复项污染）", () => {
  const list = parseAllowlist("pypi.org\npypi.org\n*.pypi.org\n*.pypi.org", "test");
  assert.equal(list.rules.length, 2);
});

test("解析：空清单是合法的，但会带一条警告", () => {
  const list = parseAllowlist("# 什么都没有\n", "test");
  assert.equal(list.rules.length, 0);
  assert.equal(list.warnings.length, 1);
  assert.match(list.warnings[0]!, /空/);
});

test("解析：裸 `*` 拒绝启动（这条是整个边界的地基）", () => {
  for (const text of ["*", "*.", "* .", "# 注释\n*", "example.com\n*"]) {
    assert.throws(
      () => parseAllowlist(text, "test"),
      (error: unknown) => {
        assert.ok(error instanceof AllowlistError, `抛的不是 AllowlistError：${String(error)}`);
        assert.match(error.message, /裸 `\*`|通配符/);
        return true;
      },
      `应该拒绝：${JSON.stringify(text)}`,
    );
  }
});

test("解析：通配符只允许 `*.` 前缀这一种形式", () => {
  for (const text of ["*example.com", "example.*", "exa*mple.com", "**.example.com", "*.example.*"]) {
    assert.throws(() => parseAllowlist(text, "test"), AllowlistError, `应该拒绝：${text}`);
  }
  // 合法的两种形式。
  assert.equal(parseAllowlist("*.example.com", "test").rules[0]!.kind, "subdomain");
  assert.equal(parseAllowlist("example.com", "test").rules[0]!.kind, "exact");
});

test("解析：IP 条目一律拒绝（名单里出现 IP 会让「IP 永远不通」这个不变量变得暧昧）", () => {
  for (const text of ["1.1.1.1", "[::1]", "2001:db8::1"]) {
    assert.throws(() => parseAllowlist(text, "test"), AllowlistError, `应该拒绝：${text}`);
  }
  assert.throws(() => parseAllowlist("*.1.1.1.1", "test"), AllowlistError);
});

test("解析：端口、路径、下划线、非法标签全部拒绝", () => {
  for (const text of ["example.com:443", "example.com/path", "exa_mple.com", "-example.com", "example-.com", "exa mple.com"]) {
    assert.throws(() => parseAllowlist(text, "test"), AllowlistError, `应该拒绝：${text}`);
  }
});

test("解析：TLD 级通配能用，但会带警告（`*.com` 约等于放行半个互联网）", () => {
  const list = parseAllowlist("*.io", "test");
  assert.equal(list.rules.length, 1);
  assert.equal(list.warnings.length, 1);
  assert.match(list.warnings[0]!, /TLD/);
});

test("归一化：小写 + 去掉所有尾部点", () => {
  assert.equal(normalizeHost("REGISTRY.NPMJS.ORG."), "registry.npmjs.org");
  assert.equal(normalizeHost("EXAMPLE.com.."), "example.com");
  assert.equal(normalizeHost("  example.com  "), "example.com");
  assert.equal(normalizeHost("[::1]:443"), "[::1]");
  assert.equal(normalizeHost(""), "");
});

test("匹配：请求侧的大小写与尾点必须命中同一条规则（防绕过）", () => {
  const list = parseAllowlist("registry.npmjs.org\n*.npmjs.org", "test");
  for (const host of ["registry.npmjs.org", "REGISTRY.NPMJS.ORG", "Registry.Npmjs.Org.", "registry.npmjs.org.."]) {
    assert.notEqual(matchAllowlist(list, host), null, `${host} 应该命中`);
  }
  // 但不能因为归一化把别的域名放进来。注意 `*.npmjs.org` **应该**命中 `xregistry.npmjs.org`
  // ——那确实是它的子域；要拦的是"看起来像"的拼接域名。
  for (const host of ["evil-registry.npmjs.org.evil.com", "registry.npmjs.org.evil.com", "npmjs.org.evil.com"]) {
    assert.equal(matchAllowlist(list, host), null, `${host} 不该命中`);
  }
});

test("isIpLiteral：IPv4 / IPv6 / 带方括号的 IPv6 都认得出来", () => {
  for (const host of ["1.1.1.1", "127.0.0.1", "::1", "[::1]", "2001:db8::1"]) {
    assert.equal(isIpLiteral(host), true, `${host} 应该被认成 IP`);
  }
  for (const host of ["example.com", "localhost", "127.0.0.1.example.com", ""]) {
    assert.equal(isIpLiteral(host), false, `${host} 不该被认成 IP`);
  }
});

test("splitAuthority：CONNECT 的 host:port 解析（含糊的输入一律拒绝）", () => {
  assert.deepEqual(splitAuthority("registry.npmjs.org:443", 443), { host: "registry.npmjs.org", port: 443 });
  assert.deepEqual(splitAuthority("registry.npmjs.org", 443), { host: "registry.npmjs.org", port: 443 });
  assert.deepEqual(splitAuthority("[::1]:8443", 443), { host: "::1", port: 8443 });
  assert.deepEqual(splitAuthority("[::1]", 443), { host: "::1", port: 443 });

  for (const bad of ["", "user@host:443", "host:0", "host:65536", "host:abc", "host:44x", "::1:443", "[::1", "host:"]) {
    assert.equal(splitAuthority(bad, 443), null, `${JSON.stringify(bad)} 不该被解析成功`);
  }
});

test("describeAllowlist：日志只带条数与样本，不打印整份清单", () => {
  const list = parseAllowlist("a.example\nb.example\nc.example\nd.example\ne.example\nf.example", "test");
  const described = describeAllowlist(list);
  assert.equal(described.rules, 6);
  assert.equal(described.sample.length, 5);
  assert.deepEqual(described.sample, ["a.example", "b.example", "c.example", "d.example", "e.example"]);
});
