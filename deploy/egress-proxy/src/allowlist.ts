/**
 * 白名单的解析与匹配：**纯函数，零依赖**。整个出网边界就落在这个文件上。
 *
 * 【为什么单独一个文件】spec 的交付物里只写了 `src/proxy.ts`，把它拆出来和 Phase 1 的
 * `config.ts`、Phase 3 的 `stream.ts` 是同一条理由：**边界规则必须是可单测的纯函数**。
 * 判断"这个域名放不放行"如果混在 socket 代码里，就只能靠起容器、连网络去验证；
 * 拆出来之后，大小写/尾点/IP/裸通配这些绕过手法全部是毫秒级的断言。
 *
 * 【这一层只回答一个问题】"这个域名在不在名单里"（§F.2）。它不解密流量、不认识端口、
 * 不区分 GET/POST、不认识密钥。正因为简单，它才能在 MVP 里做对。
 *
 * 【三条防绕过规则，每条都是刻意的】
 *  1. 归一化：小写 + 去尾部点。`REGISTRY.NPMJS.ORG.` 与 `registry.npmjs.org` 是同一个域名，
 *     不归一化就等于开了一个"加个点就能绕过"的后门。
 *  2. IP 直连一律拒绝：CONNECT 到 `1.1.1.1:443` 不匹配任何域名模式，也不需要额外分支——
 *     但要在**名单侧**也拒掉 IP 条目，否则一条 `1.1.1.1` 会让"IP 永远不通"这个不变量变得暧昧。
 *  3. 禁止裸 `*`：加载时就抛。子域通配只允许 `*.example.com` 这一种形式——它至少要求
 *     攻击者去控制一个真实存在的子域。
 */

import { readFileSync } from "node:fs";
import { isIP } from "node:net";

/** 域名单个标签（label）的形状。长度上限 63 是 DNS 的规定，写出来免得有人以为可以随意。 */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 域名总长度上限（RFC 1035）。它同时也是"别把整篇文档塞进白名单"的兜底。 */
const MAX_HOST_LENGTH = 253;

/** 一条白名单规则。`value` 永远是归一化之后的形态。 */
export interface AllowlistRule {
  /** 文件里那一行的原文（去掉注释和空白之后），报错与日志都用它。 */
  readonly raw: string;
  /** `exact` = 精确域名；`subdomain` = `*.value` 形式的子域通配。 */
  readonly kind: "exact" | "subdomain";
  /** 归一化后的域名。子域通配时是不含 `*.` 的那一段（`npmjs.org`）。 */
  readonly value: string;
}

/** 解析结果。`warnings` 不阻止启动，只打日志（见 parseAllowlist）。 */
export interface Allowlist {
  /** 来源（文件路径），日志与错误里用。 */
  readonly source: string;
  readonly rules: readonly AllowlistRule[];
  /** 加载时的非致命问题（比如 TLD 级通配）。启动器负责把它们打出来。 */
  readonly warnings: readonly string[];
}

/** 解析/加载白名单失败。`line` 是 1-based 的行号，0 表示不是"某一行的错"。 */
export class AllowlistError extends Error {
  readonly source: string;
  readonly line: number;

  constructor(source: string, line: number, message: string) {
    super(line === 0 ? `${source}: ${message}` : `${source}:${line}: ${message}`);
    this.name = "AllowlistError";
    this.source = source;
    this.line = line;
  }
}

/**
 * 解析一份白名单文本。
 *
 * 语法（故意只有两种模式）：
 *  - `example.com`     精确匹配
 *  - `*.example.com`   匹配任意深度的子域，**不匹配 apex**（`example.com` 本身要单独写一行）
 *  - `# 注释`          整行或行尾注释
 *
 * @throws AllowlistError 任一行的值不是上面两种形式；**裸 `*`、IP 条目、含端口/斜杠的
 *         条目都会走到这里**。宁可启动失败，也不要带着一条自己看不懂的规则跑起来。
 */
export function parseAllowlist(text: string, source = "<inline>"): Allowlist {
  const rules: AllowlistRule[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    // 行尾注释：先砍 `#` 之后的部分再 trim。域名里不可能有 `#`，所以这个切法是安全的。
    const hash = lines[index]!.indexOf("#");
    const raw = (hash >= 0 ? lines[index]!.slice(0, hash) : lines[index]!).trim();
    if (raw === "") continue;

    const value = normalizeHost(raw);
    if (value === "*" ) {
      throw new AllowlistError(
        source,
        lineNumber,
        "裸 `*` 不允许：它会把整个出网边界变成装饰品。要放行子域请写 `*.example.com`",
      );
    }
    if (value.includes("*")) {
      if (!value.startsWith("*.")) {
        throw new AllowlistError(
          source,
          lineNumber,
          `通配符只允许出现在最前面（\`*.example.com\`），得到 ${JSON.stringify(raw)}`,
        );
      }
      const suffix = value.slice(2);
      if (!isDomainName(suffix)) {
        throw new AllowlistError(source, lineNumber, `通配条目 ${JSON.stringify(raw)} 的后缀不是合法域名`);
      }
      if (isIpLiteral(suffix)) {
        throw new AllowlistError(source, lineNumber, `通配条目的后缀不能是 IP：${JSON.stringify(raw)}`);
      }
      addRule(rules, seen, { raw, kind: "subdomain", value: suffix });
      // TLD 级通配（`*.com`）会被规则允许，但它几乎等于放行半个互联网——值得一条警告。
      if (!suffix.includes(".")) {
        warnings.push(`第 ${lineNumber} 行 ${JSON.stringify(raw)} 通配了整个 TLD：请确认这是有意的`);
      }
      continue;
    }

    if (!isDomainName(value)) {
      throw new AllowlistError(
        source,
        lineNumber,
        `${JSON.stringify(raw)} 不是合法的域名条目（不允许端口、路径、下划线；IP 直连一律拒绝）`,
      );
    }
    if (isIpLiteral(value)) {
      throw new AllowlistError(
        source,
        lineNumber,
        `IP 条目一律拒绝（${JSON.stringify(raw)}）：代理只按域名放行，IP 直连本来就不通`,
      );
    }
    addRule(rules, seen, { raw, kind: "exact", value });
  }

  if (rules.length === 0) {
    // 空名单是合法配置（最严格的形态：谁都出不去），但几乎总是配置事故，所以要说一声。
    warnings.push("白名单是空的：所有出网请求都会被拒绝（如果这不是本意，检查文件路径与内容）");
  }

  return { source, rules, warnings };
}

/** 读文件并解析。启动时与 SIGHUP 时都走这一条路径，规则只有一份。 */
export function loadAllowlistFile(path: string): Allowlist {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new AllowlistError(path, 0, `读不到白名单文件：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseAllowlist(text, path);
}

/**
 * 域名归一化：trim、小写、去掉**所有**尾部点。
 * 去尾部点是防绕过的一环（`registry.npmjs.org.` 是同一个域名），不是洁癖。
 * 方括号形式（IPv6 的 `[::1]`）保留括号——它随后会被 isIpLiteral 认出来。
 */
export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    // `[::1]` / `[::1]:443` 两种都还原成带括号的主机部分。
    if (closing >= 0) value = value.slice(0, closing + 1);
    return value;
  }
  while (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

/**
 * 是不是 IP 字面量（IPv4 或 IPv6）。用 `net` 模块的解析器，不自己写正则——
 * IPv4 的八进制/十六进制写法、IPv6 的压缩写法都是"正则写不对"的重灾区。
 * `net.isIP("[::1]")` 认不出来，所以要先脱括号。
 */
export function isIpLiteral(host: string): boolean {
  return isIP(stripBrackets(host)) !== 0;
}

/**
 * 匹配。返回命中的规则（日志里要记是哪一条放行的），没有命中返回 null。
 *
 * 子域通配**不匹配 apex**：`*.npmjs.org` 不会放行 `npmjs.org`。这是 TLS 证书的同一套惯例，
 * 而且 apex 往往是一台跟包管理器无关的机器；要放行它就显式写一行。
 */
export function matchAllowlist(allowlist: Allowlist, host: string): AllowlistRule | null {
  const value = normalizeHost(host);
  if (value === "") return null;
  for (const rule of allowlist.rules) {
    if (rule.kind === "exact") {
      if (value === rule.value) return rule;
      continue;
    }
    // `*.npmjs.org` → 必须命中 `x.npmjs.org` 或更深的 `a.b.npmjs.org`。
    if (value.length > rule.value.length + 1 && value.endsWith(`.${rule.value}`)) return rule;
  }
  return null;
}

/** 给日志用的一行摘要：规则条数 + 前几条模式（不打印整份名单）。 */
export function describeAllowlist(allowlist: Allowlist): { source: string; rules: number; sample: string[] } {
  return {
    source: allowlist.source,
    rules: allowlist.rules.length,
    sample: allowlist.rules.slice(0, 5).map((rule) => rule.raw),
  };
}

/**
 * 解析 authority（`host:port` / `[::1]:port` / `host`）。
 *
 * 端口缺省由调用方定（CONNECT 是 443，明文 HTTP 是 80）。任何含糊的输入
 * （空、带 userinfo、端口不是数字或越界）都返回 null —— 让上层回 400/403，
 * 而不是猜一个可能被用来绕过的解释。
 */
export function splitAuthority(authority: string, defaultPort: number): { host: string; port: number } | null {
  const value = authority.trim();
  if (value === "" || value.includes("@")) return null;

  // IPv6 的方括号形式：`[::1]:443` / `[::1]`。
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    if (closing < 0) return null;
    const host = value.slice(1, closing);
    const rest = value.slice(closing + 1);
    if (rest !== "" && !rest.startsWith(":")) return null;
    const port = rest === "" ? defaultPort : parsePort(rest.slice(1));
    return port === null ? null : { host, port };
  }

  const colon = value.lastIndexOf(":");
  // 没有冒号 = 没写端口。多个冒号且不带方括号 = 一个没加方括号的 IPv6，无法可靠解析，拒掉。
  if (colon < 0) return { host: value, port: defaultPort };
  if (value.indexOf(":") !== colon) return null;
  const port = parsePort(value.slice(colon + 1));
  if (port === null) return null;
  return { host: value.slice(0, colon), port };
}

// ---------------------------------------------------------------- 内部零件

function parsePort(raw: string): number | null {
  if (raw === "") return null;
  if (!/^[0-9]{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * 是不是一个合法的域名。`localhost` 这类单标签名字是允许的（它仍然是一条精确规则，
 * 不会被任何别的域名命中）；`1.2.3.4` 也会通过标签检查，所以调用方要另外查 IP。
 */
function isDomainName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOST_LENGTH) return false;
  return value.split(".").every((label) => LABEL_RE.test(label));
}

/** 去重：同一条规则写两遍没有意义，而且会让"规则条数"这个日志字段变得不可信。 */
function addRule(rules: AllowlistRule[], seen: Set<string>, rule: AllowlistRule): void {
  const key = `${rule.kind}:${rule.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  rules.push(rule);
}
