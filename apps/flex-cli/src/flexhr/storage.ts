import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import { promisify } from "node:util";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config/index.js";

const pipelineP = promisify(pipeline);

export interface HeadResult {
  exists: boolean;
  size?: number;
  contentType?: string;
}

export type PutBody = Buffer | Uint8Array | string | Readable;

export interface PutOptions {
  contentType?: string;
  contentLength?: number;
}

export interface FlexHrStorage {
  backend: "local" | "r2";
  put(key: string, body: PutBody, opts?: PutOptions): Promise<void>;
  head(key: string): Promise<HeadResult>;
  delete(key: string): Promise<void>;
}

function createR2Storage(config: Config): FlexHrStorage {
  if (
    !config.r2Endpoint ||
    !config.r2AccessKeyId ||
    !config.r2SecretAccessKey ||
    !config.r2Bucket
  ) {
    throw new Error(
      "R2 backend requires R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET",
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    forcePathStyle: true,
  });

  return {
    backend: "r2",
    async put(key, body, opts) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.r2Bucket,
          Key: key,
          Body: body,
          ContentType: opts?.contentType,
          ContentLength: opts?.contentLength,
        }),
      );
    },
    async head(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.r2Bucket, Key: key }),
        );
        return {
          exists: true,
          size: result.ContentLength,
          contentType: result.ContentType,
        };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) {
          return { exists: false };
        }
        throw error;
      }
    },
    async delete(key) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: key }),
      );
    },
  };
}

function createLocalStorage(root: string): FlexHrStorage {
  const resolvedRoot = path.resolve(root);

  function resolveKey(key: string): string {
    const full = path.resolve(resolvedRoot, key);
    const relative = path.relative(resolvedRoot, full);
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative.split(path.sep)[0] === ".."
    ) {
      throw new Error(`key escapes storage root: ${key}`);
    }
    return full;
  }

  return {
    backend: "local",
    async put(key, body) {
      const full = resolveKey(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      if (body instanceof Readable) {
        await pipelineP(body, createWriteStream(full));
      } else {
        await fs.writeFile(full, body);
      }
    },
    async head(key) {
      try {
        const stat = await fs.stat(resolveKey(key));
        return { exists: true, size: stat.size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return { exists: false };
        }
        throw error;
      }
    },
    async delete(key) {
      try {
        await fs.unlink(resolveKey(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return;
        }
        throw error;
      }
    },
  };
}

export function createFlexHrStorage(config: Config): FlexHrStorage {
  if (config.storageBackend === "r2") {
    return createR2Storage(config);
  }
  return createLocalStorage(config.localUploadDir);
}
