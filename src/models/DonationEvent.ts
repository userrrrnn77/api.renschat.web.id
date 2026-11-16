// src/models/DonationEvent.ts
import mongoose, { Schema, Types, type Model } from "mongoose";

export type DonationStatus = "credited" | "unclaimed" | "ignored" | "review";

export interface IDonationCreditsGranted {
  imageFlux3: number;
  videoCosmos: number;
}

export interface IDonationEvent {
  messageId: string;
  kofiTransactionId: string;
  type: string;
  amount: number;
  currency: string;
  /** sha256(lowercase(trim(email))). Tidak pernah menyimpan email mentah. */
  emailHash?: string;
  /** Kode RC-XXXXXX yang ditemukan di pesan donasi (jika ada). */
  parsedCode?: string;
  userId?: Types.ObjectId;
  status: DonationStatus;
  creditsGranted: IDonationCreditsGranted;
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const creditsGrantedSchema = new Schema<IDonationCreditsGranted>(
  {
    imageFlux3: { type: Number, default: 0 },
    videoCosmos: { type: Number, default: 0 },
  },
  { _id: false },
);

const donationEventSchema = new Schema<IDonationEvent>(
  {
    messageId: { type: String, required: true, unique: true },
    kofiTransactionId: { type: String, default: "" },
    type: { type: String, required: true },
    amount: { type: Number, required: true, default: 0 },
    currency: { type: String, required: true, default: "" },
    emailHash: { type: String, default: undefined },
    parsedCode: { type: String, default: undefined },
    userId: { type: Types.ObjectId, ref: "User", default: undefined },
    status: {
      type: String,
      enum: ["credited", "unclaimed", "ignored", "review"],
      required: true,
    },
    creditsGranted: {
      type: creditsGrantedSchema,
      default: () => ({ imageFlux3: 0, videoCosmos: 0 }),
    },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

donationEventSchema.index({ kofiTransactionId: 1 });
donationEventSchema.index({ emailHash: 1 }, { sparse: true });

export const DonationEventModel: Model<IDonationEvent> =
  (mongoose.models.DonationEvent as Model<IDonationEvent>) ??
  mongoose.model<IDonationEvent>("DonationEvent", donationEventSchema);
