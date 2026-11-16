// src/storage/r2.ts

import { S3Client } from "bun";
import { env } from "../config/env.js";
import type {
  StorageProvider,
  StorageRef,
  PutMeta,
  StoragePrefix,
  PresignPutOptions,
  PresignGetOptions,
  PresignedPut,
  StorageHeadResult,
} from "./index.js";

const client = new S3Client({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
});

function buildKey(prefix: StoragePrefix, name: string): string {
  const safe = name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const rand = crypto.randomUUID();
  return `${prefix}/${rand}-${safe}`;
}

export const r2Storage: StorageProvider = {
  async put(buf: Buffer, meta: PutMeta, prefix: StoragePrefix) {
    const key = buildKey(prefix, meta.name);
    await client.write(key, buf, { type: meta.mime });
    const ref: StorageRef = { driver: "r2", key };
    if (env.R2_PUBLIC_URL) ref.url = `${env.R2_PUBLIC_URL}/${key}`;
    return ref;
  },

  async presignPut(
    prefix: StoragePrefix,
    name: string,
    opts: PresignPutOptions,
  ): Promise<PresignedPut> {
    const key = buildKey(prefix, name);
    // `type` di sini masuk ke signed header Content-Type — R2 akan
    // menolak PUT jika client tidak mengirim header itu persis.
    const url = client.presign(key, {
      method: "PUT",
      expiresIn: opts.expiresInSec,
      type: opts.mime,
    });
    return {
      key,
      url,
      expiresAt: Math.floor(Date.now() / 1000) + opts.expiresInSec,
    };
  },

  async presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    return client.presign(key, {
      method: "GET",
      expiresIn: opts.expiresInSec,
    });
  },

  async head(key: string): Promise<StorageHeadResult | null> {
    try {
      const stat = await client.file(key).stat();
      if (!stat) return null;
      return {
        size: stat.size,
        ...(stat.type !== undefined ? { contentType: stat.type } : {}),
      };
    } catch {
      return null;
    }
  },

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    return client.file(key).stream();
  },

  async readBytes(key: string, maxBytes?: number): Promise<Uint8Array> {
    if (maxBytes !== undefined) {
      const url = client.presign(key, { method: "GET", expiresIn: 60 });
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${maxBytes - 1}` },
      });
      if (!res.ok) throw new Error(`R2 range read failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    const file = client.file(key);
    const ab = await file.arrayBuffer();
    return new Uint8Array(ab);
  },

  async delete(key: string): Promise<void> {
    await client.delete(key);
  },
};
