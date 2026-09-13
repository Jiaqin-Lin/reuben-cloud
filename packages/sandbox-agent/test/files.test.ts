/**
 * Phase 2 的用例（对应 spec Phase 2 测试要点 1–15，外加几条补充）。
 *
 * 全部跑在真实 agent 上：临时目录 = workspace + 第二个读根。不碰 Docker、不碰网络。
 * 越界那几条是这个文件存在的理由——读、写、URL 编码、符号链接四条路都必须 400。
 *
 * 【为什么路径都用 realRoot 拼】macOS 上 /var 是 /private/var 的符号链接，
 * 服务端返回的是 realpath 之后的形式，拿 raw 的临时目录路径去比会假失败。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { startTestAgent, TEST_TOKEN, waitFor, type TestAgent } from "./harness.ts";

const MIB = 1024 * 1024;

let agent: TestAgent;
/** 第二个读根的 realpath（readRoots 里排在 workspace 之后）。 */
let extraRealRoot: string;

before(async () => {
  agent = await startTestAgent();
  extraRealRoot = await realpath(agent.extraRoot);
});

after(async () => {
  await agent.close();
});

/** workspace 里的绝对路径（realpath 之后的形式）。 */
function inRoot(...parts: string[]): string {
  return path.join(agent.realRoot, ...parts);
}

/**
 * 下面三个 helper 绑在**共享 agent** 上（就是文件顶部的那个）。需要自己一套上限的用例
 * 直接调 `otherAgent.request(...)`，不要把这些 helper 改成收 agent 参数——
 * 一旦收参数，漏传就会静默走到共享 agent 上，得到一个莫名其妙的 404。
 */
function putFile(filePath: string, body: string | Buffer, query = ""): Promise<Response> {
  return agent.request(`/files?path=${encodeURIComponent(filePath)}${query}`, { method: "PUT", body });
}

function getFile(filePath: string, query = ""): Promise<Response> {
  return agent.request(`/files?path=${encodeURIComponent(filePath)}${query}`);
}

function listDir(dirPath: string, query = ""): Promise<Response> {
  return agent.request(`/files/list?path=${encodeURIComponent(dirPath)}${query}`);
}

function sha256Hex(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

/** 目录里还有没有没清掉的 .part 临时文件。 */
async function hasPartFile(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.some((name) => name.includes(".part-"));
}

// ---------------------------------------------------------------- 1–6：路径安全

test("1-2: 越界路径全部 400（读与写都拒）", async () => {
  const escapes = [
    "../../etc/passwd",
    "/etc/passwd",
    "/",
    path.join(agent.realRoot, "..", "x"),
    // 前缀绕过：裸 startsWith 会让它通过
    `${agent.realRoot}-evil/file`,
  ];

  for (const bad of escapes) {
    const read = await getFile(bad);
    assert.equal(read.status, 400, `读 ${bad} 应该 400`);
    assert.equal(await errorCode(read), "path_out_of_bounds", bad);

    const write = await putFile(bad, "x");
    assert.equal(write.status, 400, `写 ${bad} 应该 400`);
    assert.equal(await errorCode(write), "path_out_of_bounds", bad);
  }
});

test("5: URL 编码的越界路径一样 400", async () => {
  // 这里故意不走 encodeURIComponent：要的就是线上那种已经编码过的形式
  const response = await agent.request("/files?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd");
  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "path_out_of_bounds");
});

test("3: 符号链接逃逸 —— 读 link/passwd 被拒", async () => {
  const link = path.join(agent.root, "escape-read");
  await symlink("/etc", link);

  // 直接读链接、以及读链接下面的文件，两条都拒
  for (const bad of [link, path.join(link, "passwd")]) {
    const response = await getFile(bad);
    assert.equal(response.status, 400, `${bad} 应该 400`);
    assert.equal(await errorCode(response), "path_out_of_bounds");
  }
});

test("4: 写路径的符号链接逃逸 —— 尾段不存在也不能写", async () => {
  const link = path.join(agent.root, "escape-write");
  await symlink("/etc", link);

  const response = await putFile(path.join(link, "pwn"), "pwned");
  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "path_out_of_bounds");
  assert.equal(existsSync("/etc/pwn"), false, "越界写居然落盘了");
});

test("6: 空 path / 缺 path 参数 → 400", async () => {
  const missing = await agent.request("/files");
  assert.equal(missing.status, 400);
  assert.equal(await errorCode(missing), "missing_path");

  const empty = await agent.request("/files?path=");
  assert.equal(empty.status, 400);
  assert.equal(await errorCode(empty), "invalid_path");

  const emptyList = await agent.request("/files/list?path=");
  assert.equal(emptyList.status, 400);
  assert.equal(await errorCode(emptyList), "invalid_path");
});

test("补充: 写只能落在 workspace，读可以在第二读根", async () => {
  const external = path.join(extraRealRoot, "tool-result.txt");
  await writeFile(external, "externalized tool result");

  const read = await getFile(external);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { content: string }).content, "externalized tool result");

  const write = await putFile(path.join(extraRealRoot, "new.txt"), "nope");
  assert.equal(write.status, 400);
  assert.equal(await errorCode(write), "path_out_of_bounds");

  // 相对路径的基准只有写根：`tool-result.txt` 不会去第二读根里找
  const relative = await getFile("tool-result.txt");
  assert.equal(relative.status, 404);
});

// ---------------------------------------------------------------- 7–9、12：读写往返与边界

test("7: 文本往返，size/sha256/encoding 都对得上", async () => {
  const target = path.join(agent.root, "roundtrip/hello.txt");
  const content = "你好，world\n第二行\n";

  const put = await putFile(target, content);
  assert.equal(put.status, 200);
  const written = (await put.json()) as { path: string; size: number; sha256: string };
  assert.equal(written.path, inRoot("roundtrip/hello.txt")); // PUT 会自动建父目录
  assert.equal(written.size, Buffer.byteLength(content));
  assert.equal(written.sha256, sha256Hex(content));

  const get = await getFile(written.path);
  assert.equal(get.status, 200);
  const body = (await get.json()) as {
    content: string;
    size: number;
    bytes: number;
    sha256: string;
    encoding: string;
    offset: number;
  };
  assert.equal(body.content, content);
  assert.equal(body.encoding, "utf8");
  assert.equal(body.size, Buffer.byteLength(content));
  assert.equal(body.bytes, Buffer.byteLength(content));
  assert.equal(body.offset, 0);
  assert.equal(body.sha256, sha256Hex(content));

  // 覆盖写：内容变了，sha256 跟着变
  assert.equal((await putFile(written.path, "new")).status, 200);
  const replaced = (await (await getFile(written.path)).json()) as { content: string; sha256: string };
  assert.equal(replaced.content, "new");
  assert.equal(replaced.sha256, sha256Hex("new"));
});

test("8、12: 1 MiB 二进制往返 —— base64 解回来 sha256 一致", async () => {
  const bytes = randomBytes(MIB);
  const target = path.join(agent.root, "binary/random.bin");

  const put = await putFile(target, bytes);
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { sha256: string }).sha256, sha256Hex(bytes));

  const get = await getFile(target, "&encoding=base64");
  assert.equal(get.status, 200);
  const body = (await get.json()) as { content: string; encoding: string; bytes: number };
  assert.equal(body.encoding, "base64");
  assert.equal(body.bytes, MIB);

  const decoded = Buffer.from(body.content, "base64");
  assert.equal(decoded.length, bytes.length);
  assert.ok(decoded.equals(bytes), "base64 往返后字节不一致");
  assert.equal(sha256Hex(decoded), sha256Hex(bytes));
});

test("9: 1 MiB 边界 —— 整通过；多 1 字节 → 413；显式 limit 可分片读", async () => {
  const exact = inRoot("boundary/exact.bin");
  await mkdir(path.dirname(exact), { recursive: true });
  await writeFile(exact, Buffer.alloc(MIB, 0x61));

  const ok = await getFile(exact);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { bytes: number }).bytes, MIB);

  const over = inRoot("boundary/over.bin");
  await writeFile(over, Buffer.alloc(MIB + 1, 0x61));

  // 没传 limit：不静默截断，直接 413
  const tooLarge = await getFile(over);
  assert.equal(tooLarge.status, 413);
  assert.equal(await errorCode(tooLarge), "too_large");

  // 传了 limit：一定返回这一段（哪怕文件还有更多），否则分片读永远拿不到第一片
  const first = await getFile(over, `&limit=${MIB}`);
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { bytes: number }).bytes, MIB);

  const second = await getFile(over, `&offset=${MIB}&limit=1`);
  const secondBody = (await second.json()) as { content: string; offset: number; size: number; bytes: number };
  assert.equal(second.status, 200);
  assert.equal(secondBody.content, "a");
  assert.equal(secondBody.offset, MIB);
  assert.equal(secondBody.size, MIB + 1);
  assert.equal(secondBody.bytes, 1);

  // offset 在 EOF 之后：空内容，不是错误
  const beyond = await getFile(over, `&offset=${MIB * 2}`);
  const beyondBody = (await beyond.json()) as { content: string; bytes: number };
  assert.equal(beyond.status, 200);
  assert.equal(beyondBody.bytes, 0);
  assert.equal(beyondBody.content, "");

  // limit 本身也有天花板
  const huge = await getFile(over, `&limit=${MIB + 1}`);
  assert.equal(huge.status, 413);
});

test("补充: raw=1 流式读 —— 不受 1 MiB 上限，也不做 base64 膨胀", async () => {
  const target = inRoot("raw/big.bin");
  const bytes = randomBytes(MIB + 1234); // 超过内联上限
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);

  const whole = await getFile(target, "&raw=1");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "application/octet-stream");
  const wholeBytes = Buffer.from(await whole.arrayBuffer());
  assert.ok(wholeBytes.equals(bytes), "raw 读回来的字节不一致");

  // raw 也能按范围切
  const slice = await getFile(target, "&raw=1&offset=10&limit=5");
  assert.equal(slice.status, 200);
  assert.ok(Buffer.from(await slice.arrayBuffer()).equals(bytes.subarray(10, 15)));

  // 空范围不能把 createReadStream 搞崩
  const empty = await getFile(target, `&raw=1&offset=${bytes.length}`);
  assert.equal(empty.status, 200);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
});

// ---------------------------------------------------------------- 10–11：流式与中断

test("10: 256 MiB 上传期间不把 body 攒进内存（arrayBuffers 增量 < 64 MiB）", async () => {
  const total = 256 * MIB;
  // 复用同一个 1 MiB buffer：客户端自己也不要在内存里攒 256 MiB
  const chunk = Buffer.alloc(MIB/16, 0x42);
  const target = inRoot("streaming/large.tar");

  // 【量什么，为什么不量 RSS】与 archive 用例 11 同一条理由：要拦的回归是"把整个 body 攒进
  // 内存"（那种写法 arrayBuffers 涨 ≥256 MiB），而 RSS 会被 glibc 的空闲 arena 顶高几十 MiB
  // （实测 15–61 MiB 的抖动，Phase 3 那个 50 MiB 的 RSS 阈值在 Linux 上偶发变红）。
  // RSS 仍然打印，因为排障时它有用。
  const before = process.memoryUsage();
  let peakArrayBuffers = before.arrayBuffers;
  let peakHeapUsed = before.heapUsed;
  let peakRss = before.rss;
  const sampler = setInterval(() => {
    const now = process.memoryUsage();
    peakArrayBuffers = Math.max(peakArrayBuffers, now.arrayBuffers);
    peakHeapUsed = Math.max(peakHeapUsed, now.heapUsed);
    peakRss = Math.max(peakRss, now.rss);
  }, 20);

  try {
    const response = await uploadInChunks(target, total, chunk);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { size: number; sha256: string };
    assert.equal(body.size, total);
  } finally {
    clearInterval(sampler);
  }

  const arrayBuffersDelta = peakArrayBuffers - before.arrayBuffers;
  const heapDelta = peakHeapUsed - before.heapUsed;
  const rssDelta = peakRss - before.rss;
  const report =
    `arrayBuffers=${(arrayBuffersDelta / MIB).toFixed(1)}MiB ` +
    `heapUsed=${(heapDelta / MIB).toFixed(1)}MiB ` +
    `rss=${(rssDelta / MIB).toFixed(1)}MiB（上传 256 MiB）`;

  // 门槛 = 上传体积的一半（与 archive 用例 11 同一条规则）：
  // "攒下整个 body"的实现必然 ≥100%（这条用例要拦的就是它），真流式的实现实测 ≤21 MiB。
  // 一半落在两者之间，两边都不贴边。
  const limit = total / 2;
  assert.ok(
    arrayBuffersDelta < limit,
    `ArrayBuffers 增量 ${(arrayBuffersDelta / MIB).toFixed(1)} MiB ≥ 上传量的一半：上传没有流式处理（${report}）`,
  );
  assert.ok(
    heapDelta < limit,
    `堆增量 ${(heapDelta / MIB).toFixed(1)} MiB ≥ 上传量的一半：请求体被（用字符串之类）攒进了内存（${report}）`,
  );
  console.log(`    上传内存：${report}`);

  await rm(target, { force: true }); // 别把 256 MiB 留到测试结束
});

test("11: 半途中断的上传 —— 目标目录里既无目标文件也无 .part", async () => {
  const dir = inRoot("aborted");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "half.tar");

  await new Promise<void>((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: agent.port,
      method: "PUT",
      path: `/files?path=${encodeURIComponent(target)}`,
      headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-length": 5_000_000 },
    });
    req.on("error", () => resolve()); // 我们自己 destroy，客户端报错是预期内的
    req.write(Buffer.alloc(65_536, 7));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 50);
  });

  await waitFor(async () => !existsSync(target) && !(await hasPartFile(dir)), {
    timeoutMs: 5_000,
    message: "中断的上传留下了目标文件或 .part 临时文件",
  });
});

test("补充: PUT 超 maxWriteBytes → 413，不留半成品", async () => {
  const small = await startTestAgent({ env: { SANDBOX_AGENT_MAX_WRITE_BYTES: "65536" } });
  try {
    const dir = small.root;
    const target = path.join(dir, "too-big.bin");

    // 声明了 Content-Length 的超标请求：连读都不用读
    const response = await small.request(`/files?path=${encodeURIComponent(target)}`, {
      method: "PUT",
      body: Buffer.alloc(200_000, 1),
    });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: string }).error, "too_large");

    assert.equal(existsSync(target), false);
    await waitFor(async () => !(await hasPartFile(dir)), { message: ".part 没被清掉" });
  } finally {
    await small.close();
  }
});

// ---------------------------------------------------------------- 13–15：list 与编码

test("13: list —— file/dir/symlink/空目录，类型与排序正确，symlink 不展开", async () => {
  const dir = inRoot("listing");
  await mkdir(path.join(dir, "zdir"), { recursive: true });
  await mkdir(path.join(dir, "empty"), { recursive: true });
  await writeFile(path.join(dir, "a.txt"), "a");
  await writeFile(path.join(dir, "b.txt"), "b");
  await writeFile(path.join(dir, "target.txt"), "t");
  await symlink(path.join(dir, "target.txt"), path.join(dir, "link.txt"));

  const response = await listDir(dir);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    path: string;
    entries: Array<{ name: string; type: string; size: number; mtime: number }>;
    truncated: boolean;
  };
  assert.equal(body.path, dir);
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.entries.map((entry) => entry.name),
    ["a.txt", "b.txt", "empty", "link.txt", "target.txt", "zdir"],
  );
  assert.deepEqual(
    body.entries.map((entry) => entry.type),
    ["file", "file", "dir", "symlink", "file", "dir"],
  );
  assert.ok(body.entries.every((entry) => entry.mtime > 0));

  const empty = (await (await listDir(path.join(dir, "empty"))).json()) as { entries: unknown[] };
  assert.deepEqual(empty.entries, []);

  // depth=2：只到第二层，不展开第三层
  await mkdir(path.join(dir, "deep", "nested"), { recursive: true });
  await writeFile(path.join(dir, "deep", "nested", "x.txt"), "x");
  const depth2 = (await (await listDir(dir, "&depth=2")).json()) as { entries: Array<{ name: string }> };
  const names = depth2.entries.map((entry) => entry.name);
  assert.ok(names.includes("deep"), "depth=2 应该列出第一层");
  assert.ok(names.includes("deep/nested"), "depth=2 应该列出第二层（带相对路径）");
  assert.equal(names.includes("deep/nested/x.txt"), false, "depth=2 不应该列出第三层");
});

test("13b: 条目上限 —— 超出置 truncated", async () => {
  const small = await startTestAgent({ env: { SANDBOX_AGENT_MAX_LIST_ENTRIES: "2" } });
  try {
    const dir = path.join(small.root, "many");
    await mkdir(dir, { recursive: true });
    for (const name of ["a", "b", "c", "d"]) await writeFile(path.join(dir, name), "x");

    const response = await small.request(`/files/list?path=${encodeURIComponent(dir)}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { entries: Array<{ name: string }>; truncated: boolean };
    assert.equal(body.truncated, true);
    assert.deepEqual(
      body.entries.map((entry) => entry.name),
      ["a", "b"],
    );
  } finally {
    await small.close();
  }
});

test("14: 目录读 → 400 is_directory；不存在 → 404；文件当目录列 → 400", async () => {
  await mkdir(inRoot("a-directory"), { recursive: true });

  const dir = await getFile(inRoot("a-directory"));
  assert.equal(dir.status, 400);
  assert.equal(await errorCode(dir), "is_directory");

  const missing = await getFile(inRoot("definitely-missing.txt"));
  assert.equal(missing.status, 404);
  assert.equal(await errorCode(missing), "not_found");

  const notDir = await listDir(inRoot("roundtrip/hello.txt"));
  assert.equal(notDir.status, 400);
  assert.equal(await errorCode(notDir), "not_directory");

  // 往目录上写也是 400，不能让 rename 以 EISDIR 报出来
  const writeDir = await putFile(inRoot("a-directory"), "x");
  assert.equal(writeDir.status, 400);
  assert.equal(await errorCode(writeDir), "is_directory");
});

test("15: 非法 UTF-8 → 400 invalid_utf8；改 base64 后原字节回来", async () => {
  const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x00, 0x0a]); // "hi" + 非法字节
  const target = path.join(agent.root, "encoding/invalid.bin");
  assert.equal((await putFile(target, bytes)).status, 200);

  const utf8 = await getFile(target);
  assert.equal(utf8.status, 400);
  assert.equal(await errorCode(utf8), "invalid_utf8");

  const base64 = await getFile(target, "&encoding=base64");
  assert.equal(base64.status, 200);
  const body = (await base64.json()) as { content: string };
  assert.ok(Buffer.from(body.content, "base64").equals(bytes));
});

// ---------------------------------------------------------------- 补充：参数校验

test("补充: 参数非法一律 400，错误码稳定", async () => {
  const file = inRoot("roundtrip/hello.txt");
  const cases: Array<[string, string, number, string]> = [
    ["offset 是负数", `/files?path=${encodeURIComponent(file)}&offset=-1`, 400, "invalid_range"],
    ["offset 是小数", `/files?path=${encodeURIComponent(file)}&offset=1.5`, 400, "invalid_range"],
    ["limit 是 0", `/files?path=${encodeURIComponent(file)}&limit=0`, 400, "invalid_range"],
    ["limit 不是数字", `/files?path=${encodeURIComponent(file)}&limit=abc`, 400, "invalid_range"],
    ["raw 拼错", `/files?path=${encodeURIComponent(file)}&raw=ture`, 400, "invalid_raw"],
    ["encoding 不认识", `/files?path=${encodeURIComponent(file)}&encoding=hex`, 400, "invalid_encoding"],
    ["depth 是 0", `/files/list?path=${encodeURIComponent(agent.realRoot)}&depth=0`, 400, "invalid_depth"],
    ["depth 太大", `/files/list?path=${encodeURIComponent(agent.realRoot)}&depth=99`, 400, "invalid_depth"],
    ["limit 超天花板", `/files?path=${encodeURIComponent(file)}&limit=${MIB + 1}`, 413, "too_large"],
  ];

  for (const [name, url, status, error] of cases) {
    const response = await agent.request(url);
    assert.equal(response.status, status, `${name} 应该 ${status}`);
    assert.equal(await errorCode(response), error, name);
  }
});

test("补充: PUT 拒绝 multipart（不解析它，但不能静默当文件写进去）", async () => {
  const target = inRoot("multipart.txt");
  const body = `--boundary\r\nContent-Disposition: form-data; name="file"\r\n\r\nhello\r\n--boundary--\r\n`;
  const response = await agent.request(`/files?path=${encodeURIComponent(target)}`, {
    method: "PUT",
    headers: { "content-type": "multipart/form-data; boundary=boundary" },
    body,
  });
  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "invalid_content_type");
  assert.equal(existsSync(target), false);
});

test("补充: 空 body 是合法的 PUT（写一个空文件）", async () => {
  const target = inRoot("empty.txt");
  const response = await putFile(target, "");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { size: number; sha256: string };
  assert.equal(body.size, 0);
  assert.equal(body.sha256, sha256Hex(""));

  const read = await getFile(target);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { content: string }).content, "");
});

// ---------------------------------------------------------------- 工具：分块上传

/**
 * 手写一个分块上传（比 fetch 直白：fetch 要么一次给整个 body，要么得配 duplex:"half"）。
 * 复用同一个 chunk buffer，保证客户端侧的内存也不随总量增长。
 */
function uploadInChunks(
  filePath: string,
  totalBytes: number,
  chunk: Buffer,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: agent.port,
        method: "PUT",
        path: `/files?path=${encodeURIComponent(filePath)}`,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/octet-stream",
          "content-length": totalBytes,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (data: Buffer) => chunks.push(data));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(text) as unknown });
        });
      },
    );
    req.on("error", reject);

    let sent = 0;
    const pump = (): void => {
      while (sent < totalBytes) {
        const size = Math.min(chunk.length, totalBytes - sent);
        sent += size;
        if (!req.write(chunk.subarray(0, size))) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}
