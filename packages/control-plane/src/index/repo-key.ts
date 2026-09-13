/**
 * `owner/name` 的推导（索引与地图的键）——**只有这一处**知道怎么从一个 clone 目录得到它。
 *
 * 【为什么单独一个文件】两个手工验收脚本（`index:repo` / `map:repo`）都要它，而它的值就是
 * `repo_key`：一边用目录名、另一边用 `owner/name`，同一个仓库就会变成两份互不相干的数据
 * （附录 A-54 就是踩到这件事才加的 `--repo`）。P8 的 `scripts/index-repo.ts` 里原本有一份私有实现，
 * P9 抽到这里，两份脚本共用同一个答案。
 *
 * 【为什么读 remote 而不是直接拿目录名】手工跑的场景几乎都是"clone 在随便一个目录里"
 * （`~/code/my-project`），而生产用的键是 `owner/name`。多问一次 git 就能让手工跑出来的行与
 * 生产里的行对得上；读不出来（不是 git 仓库 / 没有 origin / 不是 GitHub 地址）才退回目录名。
 */

import path from "node:path";
import { runGit } from "../repo/git.ts";

/** 从 GitHub 的 clone 地址里取 `owner/name`；取不出来返回 null（本地 fixture、非 GitHub remote 都走这条路）。 */
export function repoKeyFromRemoteUrl(remote: string): string | null {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** `--repo` 优先；否则读 clone 的 origin；最后退回目录名。**不抛异常**（读不出一律降级）。 */
export async function repoKeyOf(cloneDir: string, explicit: string | null = null): Promise<string> {
  if (explicit !== null && explicit !== "") return explicit;
  const result = await runGit(["remote", "get-url", "origin"], { cwd: cloneDir }).catch(() => null);
  const remote = result !== null && result.code === 0 ? result.stdout.toString("utf8") : "";
  return repoKeyFromRemoteUrl(remote) ?? path.basename(path.resolve(cloneDir));
}
