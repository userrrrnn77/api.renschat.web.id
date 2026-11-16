// src/models/CreditLedger.ts
import mongoose, { Schema, Types, type Model } from "mongoose";

export type CreditLedgerReason =
  | "donation"
  | "claim"
  | "consume"
  | "refund"
  | "admin";

export type CreditLedgerRefType = "donation" | "job";

export interface ICreditLedgerDelta {
  imageFlux3: number;
  videoCosmos: number;
}

export interface ICreditLedger {
  userId: Types.ObjectId;
  delta: ICreditLedgerDelta;
  reason: CreditLedgerReason;
  refType: CreditLedgerRefType;
  /** Id dokumen rujukan (DonationEvent / GenerationJob) sebagai string. */
  refId: string;
  createdAt: Date;
  updatedAt: Date;
}

const deltaSchema = new Schema<ICreditLedgerDelta>(
  {
    imageFlux3: { type: Number, default: 0 },
    videoCosmos: { type: Number, default: 0 },
  },
  { _id: false },
);

const creditLedgerSchema = new Schema<ICreditLedger>(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    delta: { type: deltaSchema, required: true },
    reason: {
      type: String,
      enum: ["donation", "claim", "consume", "refund", "admin"],
      required: true,
    },
    refType: {
      type: String,
      enum: ["donation", "job"],
      required: true,
    },
    refId: { type: String, required: true },
  },
  { timestamps: true },
);

creditLedgerSchema.index({ userId: 1, createdAt: -1 });

export const CreditLedgerModel: Model<ICreditLedger> =
  (mongoose.models.CreditLedger as Model<ICreditLedger>) ??
  mongoose.model<ICreditLedger>("CreditLedger", creditLedgerSchema);
