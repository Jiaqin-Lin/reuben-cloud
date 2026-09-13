/**
 * Phase 7 · 容器里的文件 API（`--tag=files`）。
 *
 * 与 exec 组同样的理由：Phase 2 在宿主机裸跑里测过路径校验与二进制安全，这一份把同样的事
 * 放进**真容器**再走一遍——只读根、tmpfs、uid 1000 的归属，任何一条都可能让"裸跑没问题"
 * 的行为在容器里变样（比如往根写被拒绝时的错误码、符号链接落点是不是真的落在卷里）。
 *
 * 覆盖 §J 功能闭环第 4 条（写入后读出的内容含二进制完全一致）与隔离表里的
 * "越界路径（`../../etc/passwd`、symlink 逃逸）被拒绝"。
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { SmokeSandbox, execOk, smokeGroup } from "../src/harness.ts";
import type { FileListPayload, FileReadPayload } from "../src/harness.ts";

/** 一份"什么字节都有"的内容：全部 256 个字节值重复若干遍，末尾再补一段 NUL。 */
function binaryBlob(): Buffer {
  const all = Buffer.alloc(256);
  for (let index = 0; index < 256; index += 1) all[index] = index;
  return Buffer.concat([all, all, all, Buffer.alloc(1024, 0), all]);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

smokeGroup("文件 API（容器内）", { tags: ["files"] }, () => {
  let box: SmokeSandbox;

  before(async () => {
    box = await SmokeSandbox.create({ label: "files" });
  });

  after(async () => {
    await box?.destroy();
  });

  test("P1 · 二进制往返：写入 → base64 读 → raw 读，三段 sha256 完全一致", async () => {
    const blob = binaryBlob();
    const written = await box.putFile("/workspace/rc-blob.bin", blob);
    assert.equal(written.size, blob.length, `写入报告的字节数不对：${written.size}`);
    assert.equal(written.sha256, sha256Hex(blob), "写入响应的 sha256 与本地不符");

    // 内联 JSON（base64）：不是所有调用方都用 raw，两条路都要验。
    const inline = await box.getJson<FileReadPayload>(
      `/files?path=${encodeURIComponent("/workspace/rc-blob.bin")}&encoding=base64`,
    );
    assert.equal(inline.size, blob.length, `size 是文件总字节数：${inline.size}`);
    assert.equal(inline.bytes, blob.length);
    assert.equal(inline.sha256, sha256Hex(blob), "base64 读的 sha256 与本地不符");
    assert.ok(Buffer.from(inline.content, "base64").equals(blob), "base64 解出来的内容与写入的不一样");

    // raw 流：CP 读大文件走的就是它。
    const raw = await box.readRaw("/workspace/rc-blob.bin");
    assert.ok(raw.equals(blob), `raw 读回的 ${raw.length} 字节与写入的 ${blob.length} 字节不一致`);
    assert.equal(sha256Hex(raw), sha256Hex(blob), "raw 读的 sha256 与本地不符");
  });

  test("P2 · 越界路径读写被拒绝（含符号链接逃逸）", async () => {
    // —— 读：绝对路径跑出写根（/etc/passwd 是最经典的一条）
    const absolute = await box.errorOf(`/files?path=${encodeURIComponent("/etc/passwd")}`);
    assert.equal(absolute.status, 400, `读 /etc/passwd 应该 400，得到 ${absolute.status}`);
    assert.equal(absolute.body.error, "path_out_of_bounds", `错误码不是 path_out_of_bounds：${String(absolute.body.error)}`);

    // —— 读：相对路径往上翻
    const relative = await box.errorOf(`/files?path=${encodeURIComponent("../etc/passwd")}`);
    assert.equal(relative.status, 400);
    assert.equal(relative.body.error, "path_out_of_bounds");

    // —— 写：同样两条
    const writeRelative = await box.errorOf(`/files?path=${encodeURIComponent("../escaped.txt")}`, {
      method: "PUT",
      body: "nope",
    });
    assert.equal(writeRelative.status, 400);
    assert.equal(writeRelative.body.error, "path_out_of_bounds", `写越界没被拒：${String(writeRelative.body.error)}`);

    // —— 符号链接逃逸：链接本身在 workspace 里，落点在外面。
    //    这是路径校验里最容易漏的一条（"路径字符串看着没问题"）。
    await execOk(box, ["ln", "-sf", "/etc", "/workspace/rc-escape"]);
    const readThroughLink = await box.errorOf(`/files?path=${encodeURIComponent("/workspace/rc-escape/passwd")}`);
    assert.equal(readThroughLink.status, 400, "顺着符号链接读到了 /etc/passwd");
    assert.equal(readThroughLink.body.error, "path_out_of_bounds");

    const writeThroughLink = await box.errorOf(
      `/files?path=${encodeURIComponent("/workspace/rc-escape/rc-should-not-exist")}`,
      { method: "PUT", body: "nope" },
    );
    assert.equal(writeThroughLink.status, 400, "顺着符号链接往 /etc 里写成功了");
    assert.equal(writeThroughLink.body.error, "path_out_of_bounds");

    // 反向验证：宿主上 /etc 里确实没有留下那个文件（断言真的没写进去，而不是"报了错但还是写了"）。
    const check = await box.exec(["bash", "-c", "test ! -e /etc/rc-should-not-exist && echo CLEAN"]);
    assert.match(check.stdout, /CLEAN/, "/etc 里留下了文件——越界写是失败的但副作用发生了");
  });

  test("P3 · 列目录：文件与符号链接的类型正确", async () => {
    const listing = await box.getJson<FileListPayload>(
      `/files/list?path=${encodeURIComponent("/workspace")}&depth=1`,
    );
    assert.equal(listing.path, "/workspace");
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry.type]));
    assert.equal(byName.get("rc-blob.bin"), "file", `rc-blob.bin 的类型不对：${String(byName.get("rc-blob.bin"))}`);
    assert.equal(byName.get("rc-escape"), "symlink", `rc-escape 的类型不对：${String(byName.get("rc-escape"))}`);
    assert.equal(listing.truncated, false);
  });
});
