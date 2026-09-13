/**
 * `anchors.ts` —— 大文件按行续读的锚点表（从 M0 的 `tools/types.ts` 拆出来）。
 *
 * 【它解决什么】`read(path, {offset: 5000})` 如果每次都从 0 开始扫，那么读完一个
 * 10 MB 文件会变成 O(n²)（读第 5 片要把前 4 片再扫一遍）。锚点让我们从"上次返回的
 * 最后一行"直接跳到对应字节，只数剩下的行。
 *
 * 【为什么没有 mtime】沙箱的 `GET /files` 不返回 mtime（只有 `/files/list` 有），
 * 而为了取 mtime 多打一次请求，比"失效时机明确"更不划算。失效规则是**穷尽的**：
 * 能够改动文件内容的只有 `write`（失效那一个路径）与 `bash`（清空整张表）——
 * 模型的全部写入口就是这两个。这个约定写在 `write.ts` 与 `bash.ts` 里。
 */

/** 锚点：某一行在文件里的起始字节偏移。 */
export interface ReadAnchor {
  /** 锚点行是第几行（1 起）。 */
  lineNumber: number;
  /** 这一行在文件里的起始字节偏移。 */
  byteOffset: number;
}

export interface ReadAnchors {
  get(path: string): ReadAnchor | null;
  set(path: string, anchor: ReadAnchor): void;
  invalidate(path: string): void;
  clear(): void;
}

/** LRU 锚点表（一个 Run 一份，默认 8 个文件）。 */
export function createReadAnchors(limit = 8): ReadAnchors {
  const entries = new Map<string, ReadAnchor>();
  return {
    get(path) {
      const found = entries.get(path);
      if (found === undefined) return null;
      // 命中就挪到队尾（Map 保持插入序 = LRU 顺序）。
      entries.delete(path);
      entries.set(path, found);
      return found;
    },
    set(path, anchor) {
      entries.delete(path);
      entries.set(path, anchor);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    invalidate(path) {
      entries.delete(path);
    },
    clear() {
      entries.clear();
    },
  };
}
