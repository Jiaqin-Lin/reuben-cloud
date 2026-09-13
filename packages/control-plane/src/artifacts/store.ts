/**
 * 对象存储客户端（Phase 10 §1）：把沙箱吐出来的流**边传边算 sha256**，不落盘、不进内存。
 *
 * 【为什么用 SDK 而不是自己签 SigV4】spec §0.2 的原话：签名逻辑不值得自己写。
 * 这里用到的是 S3 的最小面（分段上传 / GET / HEAD），其余全交给 `@aws-sdk/client-s3`。
 *
 * 【为什么必须是分段上传（`Upload`）】沙箱是**流式**给我们的：CP 在开始读之前不可能知道
 * 归档有多大（`/archive` 是边打包边吐）。S3 的单请求 PUT 要求 `Content-Length`，
 * 而 `@aws-sdk/lib-storage` 的 `Upload` 会自己开 multipart、边读边发、最后 complete——
 * 它不需要预先知道总量。这正是 Phase 10 只能用它的理由。
 *
 * 【为什么要 `queueSize: 1`】默认的多并发分段会让"CP 同时把 N 个 8 MiB 分片读进内存"
 * 变成上传速度的函数（网络越快，内存涨得越猛）。单并发把内存上限钉在"一个分片 + 管道里
 * 的少量排队"，代价是吞吐——归档不是热路径，这个交换划算。
 *
 * 【为什么 sha256 要"边传边算"】归档可能有几个 GiB。为了算 hash 把流读第二遍意味着
 * 要么落盘（CP 的磁盘不该承担这个）要么再拉一次（沙箱可能已经在销毁的路上）。
 * 一个 `Transform` 分流就够：它数字节、更新 hash、原样把块交给上传。
 * **上传成功才返回 hash**——中途失败时那个半截流的 hash 没有任何意义。
 *
 * 【超时为什么是 socketTimeout 而不是 requestTimeout】`requestHandler` 的
 * `requestTimeout` 在新版 SDK 里默认只打警告（要 `throwOnRequestTimeout: true` 才抛），
 * 而我们要拦的是"endpoint 活着但不回字节"这类挂起。`socketTimeout` 是**空闲 socket**
 * 的硬超时，它才真的会把连接掐掉。加上 `connectionTimeout`，一个挂掉的 MinIO
 * 最多让一次尝试卡住这两个量级的时间，而不是永远——这是验收里
 * "MinIO 挂掉时销毁流程不会永远挂着"的第一道闸（第二道在 offload 的重试与宽限期）。
 *
 * 【配置全走 env】`S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
 * 四个齐全才启用；**一个都没给就是"没配"**（裸跑、单测、没对象存储的部署），
 * 而只给了一部分要报错——半份配置会让第一次上传才暴露问题，那是排障最贵的一种。
 */

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

// ---------------------------------------------------------------- 类型

/** 一次成功上传的结果。三个字段都是**上传过程中算出来的**，不是事后 HEAD 拿的。 */
export interface StoredObject {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
}

/** 对象存储的最小接口。`ArtifactOffloader` 只认它，测试可以塞一个假的进来。 */
export interface ArtifactStore {
  /** 流式上传。**不需要 content-length**；返回上传过程中算出的字节数与 sha256。 */
  put(objectKey: string, body: Readable): Promise<StoredObject>;
  /**
   * 流式下载。给的是"从对象存储拿回产物"的能力：Phase 12 的 Run 结果、
   * 集成测试的校验（sha256 必须能独立复算）都要走它。**不落内存**。
   */
  get(objectKey: string): Promise<Readable>;
  /** 对象在不在、多大。不存在给 null（不抛）。 */
  head(objectKey: string): Promise<{ sizeBytes: number } | null>;
  /** 关掉底层连接池（测试与优雅退出用）。 */
  close(): void;
}

export type ArtifactStoreErrorReason =
  /** 配置缺项或形状不对（启动时就该暴露）。 */
  | "config_missing"
  /** 上传失败（连不上、权限、分片失败、源流坏了）。 */
  | "upload_failed"
  /** 下载失败。 */
  | "download_failed";

export class ArtifactStoreError extends Error {
  readonly reason: ArtifactStoreErrorReason;
  readonly objectKey: string | null;
  readonly details: Record<string, unknown>;

  constructor(
    reason: ArtifactStoreErrorReason,
    message: string,
    options: { objectKey?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ArtifactStoreError";
    this.reason = reason;
    this.objectKey = options.objectKey ?? null;
    this.details = options.details ?? {};
  }
}

// ---------------------------------------------------------------- 常量

/**
 * 分段大小（spec 写的 8 MiB）。S3 的下限是 5 MiB，8 是"分片少、内存小"的常用折中：
 * 一个 2 GiB 归档 ≈ 256 个分片，每次只有一个在内存里。
 */
export const DEFAULT_PART_SIZE_BYTES = 8 * 1024 * 1024;

/** 同时挂在途中的分片数（spec 写的 1，理由见文件头）。 */
export const DEFAULT_QUEUE_SIZE = 1;

/** 建连超时。连不上（MinIO 挂了、DNS 错）要快速失败，而不是让销毁流程卡住。 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/** 空闲 socket 超时：60 秒没有任何字节就掐掉。见文件头。 */
export const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------- 配置

export interface ArtifactStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO 之外的 S3 也用它；默认 us-east-1（MinIO 不校验 region）。 */
  region: string;
  /**
   * 强制 path-style（`http://host/bucket/key`）。MinIO 需要它；AWS S3 两种都行。
   * 默认 true——本项目的默认对象存储就是 MinIO。
   */
  forcePathStyle: boolean;
}

const REQUIRED_ENV = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

/**
 * 从 env 读配置。**四个变量一个都没给 → null**（= 这个部署没有对象存储，功能关闭）；
 * 给了一部分 → `config_missing`，把缺的名字列出来。
 *
 * 为什么"全空"和"半空"的处理不同：全空是**合法的部署形态**（本地开发、单测、
 * Phase 11 之前的裸跑），半空一定是配置事故——它只会在第一次上传时才炸，
 * 而那时候沙箱已经在等销毁了。fail fast 是这里的全部意义。
 */
export function artifactStoreConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactStoreConfig | null {
  const present = REQUIRED_ENV.filter((name) => (env[name] ?? "") !== "");
  if (present.length === 0) return null;
  const missing = REQUIRED_ENV.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) {
    throw new ArtifactStoreError("config_missing", `对象存储配置不全：缺 ${missing.join(" / ")}`, {
      details: { missing },
    });
  }
  return {
    endpoint: env["S3_ENDPOINT"]!,
    bucket: env["S3_BUCKET"]!,
    accessKeyId: env["S3_ACCESS_KEY_ID"]!,
    secretAccessKey: env["S3_SECRET_ACCESS_KEY"]!,
    region: env["S3_REGION"] ?? "us-east-1",
    // 只有显式的 "false" 才关掉 path-style（"0"/"no" 这些写法一律当没写，
    // 免得一个拼错的开关把 MinIO 的路由方式悄悄换掉）。
    forcePathStyle: env["S3_FORCE_PATH_STYLE"] !== "false",
  };
}

// ---------------------------------------------------------------- 实现

export interface S3ArtifactStoreOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  forcePathStyle?: boolean;
  partSizeBytes?: number;
  queueSize?: number;
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
  /** SDK 内部的每请求重试用几次。默认 3（SDK 的缺省）；测试会调成 1 让时间可预测。 */
  maxAttempts?: number;
}

export class S3ArtifactStore implements ArtifactStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #partSizeBytes: number;
  readonly #queueSize: number;

  constructor(options: S3ArtifactStoreOptions) {
    this.#bucket = options.bucket;
    this.#partSizeBytes = options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
    this.#queueSize = options.queueSize ?? DEFAULT_QUEUE_SIZE;
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? "us-east-1",
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: options.forcePathStyle ?? true,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: {
        connectionTimeout: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        // **socketTimeout 而不是 requestTimeout**：见文件头。requestTimeout 默认只警告。
        socketTimeout: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
      },
    });
  }

  get bucket(): string {
    return this.#bucket;
  }

  async put(objectKey: string, body: Readable): Promise<StoredObject> {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    // `pipe` **不转发 error**：源流坏掉时 meter 会一直等一个不会来的块，上传就那么挂着。
    // 显式的转发让一次坏掉的沙箱流立刻变成一次失败的上传（然后走 offload 的重试）。
    const forwardError = (error: Error): void => {
      meter.destroy(error);
    };
    body.once("error", forwardError);

    const upload = new Upload({
      client: this.#client,
      params: { Bucket: this.#bucket, Key: objectKey, Body: body.pipe(meter) },
      queueSize: this.#queueSize,
      partSize: this.#partSizeBytes,
      // 失败时 abort 掉 multipart，不给 bucket 留一堆看不见的残片。
      leavePartsOnError: false,
    });

    try {
      await upload.done();
    } catch (error) {
      // 失败路径上不 digest：`hash.digest()` 会终结 hasher，而这里的值没人要。
      // 源头也要一起掐掉：上传都不要了，还让沙箱往 CP 里灌字节只是白耗两边。
      meter.destroy();
      body.destroy();
      throw new ArtifactStoreError("upload_failed", `上传 ${objectKey} 失败：${messageOf(error)}`, {
        objectKey,
        details: { bytesSent: sizeBytes },
      });
    } finally {
      body.off("error", forwardError);
    }

    return { objectKey, sizeBytes, sha256: hash.digest("hex") };
  }

  async get(objectKey: string): Promise<Readable> {
    try {
      const response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
      if (response.Body === undefined) {
        throw new ArtifactStoreError("download_failed", `${objectKey} 的响应没有 Body`, { objectKey });
      }
      // Node 上 SDK 返回的就是一个 Readable；这里原样交出去，不读进内存。
      return response.Body as Readable;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("download_failed", `下载 ${objectKey} 失败：${messageOf(error)}`, {
        objectKey,
      });
    }
  }

  async head(objectKey: string): Promise<{ sizeBytes: number } | null> {
    try {
      const response = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
      return { sizeBytes: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new ArtifactStoreError("download_failed", `HEAD ${objectKey} 失败：${messageOf(error)}`, {
        objectKey,
      });
    }
  }

  close(): void {
    this.#client.destroy();
  }
}

/** 从 env 建一个 store。没配置给 null（见 `artifactStoreConfigFromEnv`）。 */
export function artifactStoreFromEnv(env: NodeJS.ProcessEnv = process.env): S3ArtifactStore | null {
  const config = artifactStoreConfigFromEnv(env);
  if (config === null) return null;
  return new S3ArtifactStore(config);
}

// ---------------------------------------------------------------- 工具

/** S3 的"不存在"是 404（`NotFound` / `NoSuchKey`）——head 用它区分 null 与真错误。 */
function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate.$metadata?.httpStatusCode === 404) return true;
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
