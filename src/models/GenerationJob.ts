// src/models/GenerationJob.ts
import mongoose, { Schema, Types, type Model } from "mongoose";

export type GenerationJobKind = "image" | "video";
export type GenerationEngine = "flux2" | "flux3" | "cosmos" | "python";
export type GenerationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface IGenerationJobError {
  code: string;
  message: string;
}

export interface IGenerationJobCreditCost {
  imageFlux3: number;
  videoCosmos: number;
}

export interface IGenerationJob {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  kind: GenerationJobKind;
  engine: GenerationEngine;
  status: GenerationJobStatus;
  /** Parameter teknis ringkas (tanpa prompt penuh, tanpa data sensitif). */
  params: Record<string, unknown>;
  fileId?: Types.ObjectId;
  error?: IGenerationJobError;
  creditCost: IGenerationJobCreditCost;
  /** Refund kredit idempotent: true = sudah dikembalikan. */
  refunded: boolean;
  attempts: number;
  queuedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const jobErrorSchema = new Schema<IGenerationJobError>(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const creditCostSchema = new Schema<IGenerationJobCreditCost>(
  {
    imageFlux3: { type: Number, default: 0, min: 0 },
    videoCosmos: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const generationJobSchema = new Schema<IGenerationJob>(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    sessionId: { type: Types.ObjectId, ref: "Session", required: true },
    messageId: { type: Types.ObjectId, ref: "Message", required: true },
    kind: {
      type: String,
      enum: ["image", "video"],
      required: true,
    },
    engine: {
      type: String,
      enum: ["flux2", "flux3", "cosmos", "python"],
      required: true,
    },
    status: {
      type: String,
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
      default: "queued",
    },
    params: { type: Schema.Types.Mixed, default: {} },
    fileId: { type: Types.ObjectId, ref: "FileDoc", default: undefined },
    error: { type: jobErrorSchema, default: undefined },
    creditCost: { type: creditCostSchema, required: true },
    refunded: { type: Boolean, default: false },
    attempts: { type: Number, default: 0, min: 0 },
    queuedAt: { type: Date, required: true },
    startedAt: { type: Date, default: undefined },
    finishedAt: { type: Date, default: undefined },
  },
  { timestamps: true },
);

generationJobSchema.index({ userId: 1, status: 1 });
generationJobSchema.index({ status: 1, queuedAt: 1 });

export const GenerationJobModel: Model<IGenerationJob> =
  (mongoose.models.GenerationJob as Model<IGenerationJob>) ??
  mongoose.model<IGenerationJob>("GenerationJob", generationJobSchema);
