// src/storage/index.ts

import { r2Storage } from "./r2.js";

export type StoragePrefix = "images" | "files";

export interface StorageRef {
  driver: "r2";
  key: string;
  url?: string;
}

export interface PutMeta {
  mime: string;
  name: string;
}

export interface PresignPutOptions {
  mime: string;
  expiresInSec: number;
}

export interface PresignGetOptions {
  expiresInSec: number;
}

export interface PresignedPut {
  key: string;
  url: string;
  expiresAt: number;
}

export interface StorageHeadResult {
  size: number;
  contentType?: string;
}

export interface StorageProvider {
  put(buf: Buffer, meta: PutMeta, prefix: StoragePrefix): Promise<StorageRef>;
  presignPut(
    prefix: StoragePrefix,
    name: string,
    opts: PresignPutOptions,
  ): Promise<PresignedPut>;
  /** Presigned GET untuk <img>/<video> FE (§7.4). Key tidak pernah ke FE. */
  presignGet(key: string, opts: PresignGetOptions): Promise<string>;
  head(key: string): Promise<StorageHeadResult | null>;
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Kalau maxBytes undefined → baca seluruh objek. */
  readBytes(key: string, maxBytes?: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export function pickPrefix(mime: string): StoragePrefix {
  return mime.startsWith("image/") ? "images" : "files";
}

export function getStorage(): StorageProvider {
  return r2Storage;
}
