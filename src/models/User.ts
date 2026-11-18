import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const creditsSchema = new Schema(
  {
    imageFlux3: { type: Number, default: 0, min: 0 },
    videoCosmos: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const personalitySchema = new Schema(
  {
    mode: {
      type: String,
      enum: ["auto", "serious", "casual", "playful"],
      default: "auto",
    },
    note: { type: String, maxlength: 300, default: "" },
  },
  { _id: false },
);

// Phase 8: profil gaya persisten yang dipelajari bertahap.
const styleProfileSchema = new Schema(
  {
    tone: {
      type: String,
      enum: ["serious", "casual", "playful"],
      default: "casual",
    },
    formality: {
      type: String,
      enum: ["formal", "neutral", "informal"],
      default: "neutral",
    },
    pronouns: {
      type: String,
      enum: ["gw-lu", "aku-kamu", "saya-anda", "none"],
      default: "none",
    },
    slangRate: { type: Number, default: 0, min: 0, max: 1 },
    emojiRate: { type: Number, default: 0, min: 0, max: 1 },
    length: {
      type: String,
      enum: ["short", "medium", "long"],
      default: "medium",
    },
    language: {
      type: String,
      enum: ["id", "en", "mixed"],
      default: "id",
    },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    sampleCount: { type: Number, default: 0, min: 0 },
    lastUpdated: { type: Date, default: undefined },
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
    passwordHash: { type: String, required: false },
    googleId: { type: String, unique: true, sparse: true },
    authProviders: {
      type: [String],
      enum: ["password", "google"],
      default: ["password"],
    },
    avatarUrl: { type: String, default: undefined },
    name: { type: String, required: true, trim: true },
    timezone: { type: String, default: "Asia/Jakarta" },
    donationCode: { type: String, default: undefined },
    credits: { type: creditsSchema, default: undefined },
    donorSince: { type: Date, default: undefined },
    personality: { type: personalitySchema, default: undefined },
    styleProfile: { type: styleProfileSchema, default: undefined },
  },
  { timestamps: true },
);

userSchema.index({ donationCode: 1 }, { unique: true, sparse: true });

export type IUser = InferSchemaType<typeof userSchema>;

export const UserModel: Model<IUser> =
  (mongoose.models.User as Model<IUser>) ??
  mongoose.model<IUser>("User", userSchema);
