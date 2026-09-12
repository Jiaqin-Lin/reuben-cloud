/**
 * Phase 3 的解析器单测：`git diff --name-status -z` 与 `--numstat -z` 的解码。
 *
 * 【为什么要单独测】这两条命令的输出格式里有几个"不去看字节就想不到"的坑：
 *  - 去掉引号转义后，路径里可以有空格、换行（所以我们坚持用 `-z`，不用按行解析）
 *  - 重命名的 numstat 记录形如 `0\t0\t\0<旧路径>\0<新路径>\0`——第三个字段是**空的**，
 *    后面再跟两个 NUL 字段
 *  - 二进制文件用 `-` 而不是数字表示行数
 * 走真实仓库去造这些情况太贵，所以解析器是导出的，直接喂字节。
 *
 * 下面的字节都是真 git（2.50）产出的形状，不是凭空编的。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseNameStatusZ, parseNumStatZ } from "../src/diff.ts";

test("name-status -z：普通项、重命名、复制、类型变化、特殊路径", () => {
  const buffer = Buffer.from(
    "A\0bin.dat\0" +
      "D\0del.txt\0" +
      "M\0f.txt\0" +
      "R100\0sub/old.txt\0sub/new.txt\0" +
      "C75\0a.txt\0copy.txt\0" +
      "T\0link\0" +
      "U\0conflict.txt\0" +
      "M\0dir with space/文 件.txt\0",
    "utf8",
  );

  assert.deepEqual(parseNameStatusZ(buffer), [
    { status: "added", path: "bin.dat" },
    { status: "deleted", path: "del.txt" },
    { status: "modified", path: "f.txt" },
    { status: "renamed", path: "sub/new.txt", oldPath: "sub/old.txt" },
    { status: "copied", path: "copy.txt", oldPath: "a.txt" },
    { status: "typechanged", path: "link" },
    { status: "unknown", path: "conflict.txt" },
    { status: "modified", path: "dir with space/文 件.txt" },
  ]);
});

test("name-status -z：输出被截断时能解多少算多少，不抛", () => {
  // 一个重命名记录只给了旧路径就断了
  assert.deepEqual(parseNameStatusZ(Buffer.from("R100\0old.txt\0", "utf8")), []);
  assert.deepEqual(parseNameStatusZ(Buffer.alloc(0)), []);
});

test("numstat -z：数字、二进制、重命名（真实 git 形状）", () => {
  const buffer = Buffer.from(
    "-\t-\tbin.dat\0" +
      "0\t1\tdel.txt\0" +
      "1\t1\tf.txt\0" +
      "1\t0\tnew.txt\0" +
      "0\t0\t\0sub/old.txt\0sub/new.txt\0",
    "utf8",
  );
  const stats = parseNumStatZ(buffer);

  // 二进制：`-` 翻译成 0 行 + binary 标记（0/0 本身也是普通变更的合法值，两者靠这个标志区分）
  assert.deepEqual(stats.get("bin.dat"), { additions: 0, deletions: 0, binary: true });
  assert.deepEqual(stats.get("del.txt"), { additions: 0, deletions: 1, binary: false });
  assert.deepEqual(stats.get("f.txt"), { additions: 1, deletions: 1, binary: false });
  assert.deepEqual(stats.get("new.txt"), { additions: 1, deletions: 0, binary: false });

  // 重命名：键是**新路径**，旧路径不单独占一项
  assert.deepEqual(stats.get("sub/new.txt"), { additions: 0, deletions: 0, binary: false });
  assert.equal(stats.has("sub/old.txt"), false);
  assert.equal(stats.size, 5);
});

test("numstat -z：路径里的换行与制表符不会把记录切错", () => {
  const buffer = Buffer.from("3\t4\tweird\nname.txt\0", "utf8");
  const stats = parseNumStatZ(buffer);
  assert.deepEqual(stats.get("weird\nname.txt"), { additions: 3, deletions: 4, binary: false });
});
