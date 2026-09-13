/**
 * `provider/image-ref.ts` —— 把本地镜像 tag 解析成 **digest 引用**（`repo@sha256:…`）。
 *
 * 【为什么必须带 digest】`SandboxSpec.image` 只接受 digest（`sandbox.md` §C.1）：tag 是可以被
 * 重新指向的，而"这次 Run 用的是哪个镜像"必须是一个不可变的事实。所以任何"按 tag 引用镜像"
 * 的地方（默认沙箱镜像、Layer 1 的六档基础镜像）都要经过这一个函数。
 *
 * 【本地镜像的 digest 在哪】docker 把本地镜像的 digest 放在 `RepoDigests` / `Id` 里：
 *  · pull 过或 push 过的镜像有 `RepoDigests`（`repo@sha256:…`）——优先用它，它与 tag 同名；
 *  · 本地构建且从没 push 过的镜像没有 `RepoDigests`，只能退回 `.Id`（`sha256:<64 hex>`）。
 * 两种形态都是不可变的内容寻址，`validateSpec()` 都接受（`local-docker.ts` 的注释里写着
 * "裸本地镜像 ID 也是合法 digest"）。必须带 digest 的规矩没有因此松动：tag 仍然不被接受。
 *
 * 【为什么从测试脚手架搬进产品代码】P7 的 Run 侧回退要在**生产路径**上把 Layer 1 的 tag
 * 解析成 digest（以前只有脚本与集成测试需要它，所以它一直住在 `test/support.ts`）。
 * 产品代码 import 测试脚手架是反向依赖（AGENTS.md §1 的依赖方向），所以实现搬到这里，
 * 测试脚手架改成 re-export——调用方一行不动。
 *
 * 【为什么要 spawn 而不是用 provider 的 HTTP API】这是显示与解析，不是容器操作：`docker image
 * inspect` 是最直接、跨存储驱动最稳的一条路（provider 侧仍然只用 HTTP API，那条线没有变）。
 */

import { spawn } from "node:child_process";

/** 集成测试与脚本的默认 tag（`npm run build:image` 建出来的）。 */
export const DEFAULT_IMAGE_TAG = process.env["SANDBOX_IMAGE"] ?? "reuben-cloud/sandbox-base:dev";

/** egress-proxy 的本地镜像 tag（`npm run build:proxy-image` 建出来的）。 */
export const DEFAULT_PROXY_IMAGE_TAG = process.env["EGRESS_PROXY_IMAGE"] ?? "reuben-cloud/egress-proxy:dev";

interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function docker(args: string[]): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * 把本地镜像解析成 digest 引用。
 *
 * @param tag 本地 tag（`reuben-cloud/base-node-dev:dev`）。
 * @param hint 镜像不存在时告诉使用者该跑哪条命令——比让 create 报"拉镜像失败"清楚得多。
 * @throws 镜像不存在或解析不出 digest 时抛出（消息里带上该跑的命令）。
 */
export async function resolveImageRef(tag: string = DEFAULT_IMAGE_TAG, hint = "npm run build:image"): Promise<string> {
  const result = await docker(["image", "inspect", "--format", "{{.Id}} {{json .RepoDigests}}", tag]);
  if (result.code !== 0) {
    throw new Error(
      `本地没有镜像 ${tag}。先跑 \`${hint}\`（或用 SANDBOX_IMAGE / EGRESS_PROXY_IMAGE 指定别的镜像）。\n${result.stderr.trim()}`,
    );
  }
  const [id, repoDigestsJson] = result.stdout.trim().split(" ");
  const repoDigests = JSON.parse(repoDigestsJson ?? "[]") as string[];
  // RepoDigests 里已经有完整的 `repo@sha256:…` 时优先用它（它和 tag 同名，最不容易搞混）。
  const preferred = repoDigests.find((item) => item.startsWith(`${tag.split(":")[0]}@`)) ?? repoDigests[0];
  if (preferred !== undefined) return preferred;
  if (id !== undefined && /^sha256:[0-9a-f]{64}$/.test(id)) return id;
  throw new Error(`无法从 ${tag} 解析出 digest 引用：${result.stdout.trim()}`);
}
