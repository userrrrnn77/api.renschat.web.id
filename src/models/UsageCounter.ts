// src/models/UsageCounter.ts
import mongoose, { Schema, Types, type Model } from "mongoose";

/** Key limit harian per user (§6.6). Engine berbayar tidak memakai ini. */
export type UsageCounterKey = "image_flux2" | "video_python";

/** Engine untuk cap global harian (§6.7). */
export type GlobalUsageEngine = "flux2" | "flux3" | "cosmos" | "python";

export interface IUsageCounter {
  userId: Types.ObjectId;
  /** `YYYY-MM-DD` di UTC+7 (WIB). */
  day: string;
  key: UsageCounterKey;
  count: number;
  /** TTL: dokumen hilang 3 hari setelah `day` berakhir. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const usageCounterSchema = new Schema<IUsageCounter>(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    day: { type: String, required: true },
    key: {
      type: String,
      enum: ["image_flux2", "video_python"],
      required: true,
    },
    count: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

usageCounterSchema.index({ userId: 1, day: 1, key: 1 }, { unique: true });
// TTL: hapus counter yang sudah lewat 3 hari (expiresAt = akhir day + 3 hari).
usageCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UsageCounterModel: Model<IUsageCounter> =
  (mongoose.models.UsageCounter as Model<IUsageCounter>) ??
  mongoose.model<IUsageCounter>("UsageCounter", usageCounterSchema);

/**
 * Cap global per hari per engine (§6.7/§8.4). Keputusan struktur: koleksi
 * kecil terpisah (`GlobalUsageCounter`), bukan `UsageCounter` dengan userId
 * khusus — agar unique index per-user tidak tercampur counter global.
 */
export interface IGlobalUsageCounter {
  /** `YYYY-MM-DD` di UTC+7 (WIB). */
  day: string;
  engine: GlobalUsageEngine;
  count: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const globalUsageCounterSchema = new Schema<IGlobalUsageCounter>(
  {
    day: { type: String, required: true },
    engine: {
      type: String,
      enum: ["flux2", "flux3", "cosmos", "python"],
      required: true,
    },
    count: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

globalUsageCounterSchema.index({ day: 1, engine: 1 }, { unique: true });
globalUsageCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GlobalUsageCounterModel: Model<IGlobalUsageCounter> =
  (mongoose.models.GlobalUsageCounter as Model<IGlobalUsageCounter>) ??
  mongoose.model<IGlobalUsageCounter>(
    "GlobalUsageCounter",
    globalUsageCounterSchema,
  );
