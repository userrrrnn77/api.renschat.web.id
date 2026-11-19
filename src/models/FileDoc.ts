// src/models/FileDoc.ts
import mongoose, { Schema, Types, type Model } from "mongoose";
import type { FileAppearance } from "../services/blocks/fileAppearance.js";

export type FileOrigin = "upload" | "generated";
export type FileStatus = "pending" | "processing" | "ready" | "failed";
export type FileIndexStatus =
  | "disabled"
  | "pending"
  | "indexing"
  | "ready"
  | "failed";
export type StorageDriver = "r2" | "local" | "cloudinary";
/** Jenis media generated (§6.4). Undefined untuk file biasa. */
export type FileMediaKind = "image" | "video";

export interface IFileDocStorage {
  driver: StorageDriver;
  key: string;
  url?: string;
}

export interface IFileDocExtract {
  kind: string;
  chars?: number;
  pages?: number;
  sheets?: number;
  truncated?: boolean;
}

export interface IFileDocDigest {
  summary?: string;
  ocrText?: string;
  json?: unknown;
}

export interface IFileDocMediaMeta {
  model: string;
  width?: number;
  height?: number;
  durationSec?: number;
  /** "1:1" | "16:9" | "9:16" untuk gambar; "16:9" | "9:16" untuk video. */
  aspect: string;
  /** flux2 | flux3 | cosmos | python */
  engine: string;
}

export interface IFileDoc {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  origin: FileOrigin;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  appearance?: FileAppearance;
  version: number;
  parentFileId?: Types.ObjectId | null;
  storage: IFileDocStorage;
  status: FileStatus;
  indexStatus?: FileIndexStatus;
  error?: string;
  extract?: IFileDocExtract;
  digest?: IFileDocDigest;
  summaryLine?: string;
  /** Media generated saja: "image" | "video". */
  kind?: FileMediaKind;
  /** Media generated saja: metadata teknis (tanpa prompt). */
  mediaMeta?: IFileDocMediaMeta;
  /** Media generated saja: createdAt + ASSET_TTL_HOURS (§6.4). */
  expiresAt?: Date;
  /** Media generated saja: true setelah object R2 dihapus oleh flush. */
  expired?: boolean;
  /** Media generated saja: TTL metadata 7 hari setelah expired (§10.2). */
  purgeAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const storageSchema = new Schema<IFileDocStorage>(
  {
    driver: {
      type: String,
      enum: ["r2", "local", "cloudinary"],
      default: "r2",
      required: true,
    },
    key: { type: String, required: true },
    url: String,
  },
  { _id: false },
);

const extractSchema = new Schema<IFileDocExtract>(
  {
    kind: { type: String, required: true },
    chars: Number,
    pages: Number,
    sheets: Number,
    truncated: Boolean,
  },
  { _id: false },
);

const digestSchema = new Schema<IFileDocDigest>(
  {
    summary: String,
    ocrText: String,
    json: Schema.Types.Mixed,
  },
  { _id: false },
);

const mediaMetaSchema = new Schema<IFileDocMediaMeta>(
  {
    model: { type: String, required: true },
    width: { type: Number, default: undefined },
    height: { type: Number, default: undefined },
    durationSec: { type: Number, default: undefined },
    aspect: { type: String, required: true },
    engine: { type: String, required: true },
  },
  { _id: false },
);

const fileDocSchema = new Schema<IFileDoc>(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    sessionId: { type: Types.ObjectId, ref: "Session", required: true },
    origin: { type: String, enum: ["upload", "generated"], required: true },
    name: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, default: "" },
    appearance: {
      type: new Schema(
        {
          icon: String,
          accent: String,
        },
        { _id: false },
      ),
      default: undefined,
    },
    version: { type: Number, default: 1 },
    parentFileId: { type: Types.ObjectId, ref: "FileDoc", default: null },
    storage: { type: storageSchema, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "ready", "failed"],
      default: "pending",
    },
    indexStatus: {
      type: String,
      enum: ["disabled", "pending", "indexing", "ready", "failed"],
      default: undefined,
    },
    error: String,
    extract: { type: extractSchema, default: undefined },
    digest: { type: digestSchema, default: undefined },
    summaryLine: String,
    kind: {
      type: String,
      enum: ["image", "video"],
      default: undefined,
    },
    mediaMeta: { type: mediaMetaSchema, default: undefined },
    expiresAt: { type: Date, default: undefined },
    expired: { type: Boolean, default: undefined },
    purgeAt: { type: Date, default: undefined },
  },
  { timestamps: true },
);

fileDocSchema.index({ sessionId: 1, createdAt: 1 });
fileDocSchema.index({ status: 1, createdAt: 1 });
// Flush media expired (§7.6) — batch query utama.
fileDocSchema.index({ expiresAt: 1, status: 1 });
// TTL metadata media: hapus dokumen 7 hari setelah purgeAt (§10.2 lapis 3).
// Dokumen tanpa purgeAt (semua file non-media) tidak pernah dihapus TTL.
fileDocSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const FileDocModel: Model<IFileDoc> =
  (mongoose.models.FileDoc as Model<IFileDoc>) ??
  mongoose.model<IFileDoc>("FileDoc", fileDocSchema);
