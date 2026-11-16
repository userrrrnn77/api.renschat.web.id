// src/models/User.ts
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

// ── Media generation (§6.1) ───────────────────────────────────────────────
const creditsSchema = new Schema(
  {
    imageFlux3: { type: Number, default: 0, min: 0 },
    videoCosmos: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    timezone: { type: String, default: "Asia/Jakarta" },
    // ── Media generation (§6.1) ──
    /** Kode donasi `RC-XXXXXX`; dibuat lazy (getOrCreateDonationCode, §9.2). */
    donationCode: { type: String, default: undefined },
    /** Kredit generate berbayar; menumpuk, tidak kedaluwarsa (§3). */
    credits: { type: creditsSchema, default: undefined },
    /** Diisi saat kredit donasi pertama masuk. */
    donorSince: { type: Date, default: undefined },
  },
  { timestamps: true },
);

// Kode donasi unik; sparse karena dibuat lazy (banyak user tanpa kode).
userSchema.index({ donationCode: 1 }, { unique: true, sparse: true });

export type IUser = InferSchemaType<typeof userSchema>;

export const UserModel: Model<IUser> =
  (mongoose.models.User as Model<IUser>) ??
  mongoose.model<IUser>("User", userSchema);
