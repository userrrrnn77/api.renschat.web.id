// src/services/generation/image.service.ts
import { Types } from "mongoose";
import { GenerationJobModel } from "../../models/GenerationJob.js";
import { UserModel } from "../../models/User.js";
import { AppError } from "../../middleware/error.js";
import { logger } from "../../config/logger.js";
import { generateImageFlux2 } from "@services/llm/providers/flux2.client.js";
import { FileDocModel } from "../../models/FileDoc.js";
import { getStorage } from "../../storage/index.js";
import { editFlux2Image } from "../llm/providers/flux2.edit.js";
import { saveGeneratedMedia, detectImageMime } from "../tools/saveGenerated.js";
import { consumeCredit, refundJobCredits } from "../credits.service.js";
import {
  assertMediaEnabled,
  assertGlobalDailyCap,
  assertNoActiveJob,
  assertUserDailyLimit,
  incrementGlobalDaily,
  incrementUserUsage,
  withImageSlot,
} from "./budget.service.js";
import {
  assertFlux3Allowed,
  type EntitlementUser,
} from "../entitlements.service.js";
import type { GenerationPlan } from "./plan.js";

export type ImageModelId = "flux2-klein" | "flux3-klein";
export type ImageAspect = "1:1" | "16:9" | "9:16";

const PROMPT_MIN = 1;
const PROMPT_MAX = 2000;
const IMAGE_ASPECTS: ReadonlySet<string> = new Set(["1:1", "16:9", "9:16"]);

/** Resolusi yang didukung provider (§4.2/§4.3), dipetakan per model (§11.1). */
export function resolveImageSize(
  aspect: ImageAspect,
  model: ImageModelId,
): { width: number; height: number } {
  if (model === "flux2-klein") {
    if (aspect === "16:9") return { width: 1392, height: 752 };
    if (aspect === "9:16") return { width: 752, height: 1392 };
    return { width: 1024, height: 1024 };
  }
  // flux3
  if (aspect === "16:9") return { width: 1344, height: 768 };
  if (aspect === "9:16") return { width: 768, height: 1344 };
  return { width: 1024, height: 1024 };
}

/**
 * Extractor defensif (§4.2 response struktur belum pasti, §11.1): coba
 * berurutan `artifacts[0].base64` → `artifacts[0].b64_json` → `image` →
 * `b64_json` → `data[0].b64_json`. Tidak ada → PROVIDER_ERROR; hanya nama
 * key response yang di-log (tanpa isi, §17).
 */
export function extractImageBase64(json: unknown): string {
  const presentKeys =
    typeof json === "object" && json !== null
      ? Object.keys(json as Record<string, unknown>)
      : [];

  const pickString = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const candidates: Array<string | null> = [];
  const root = json as Record<string, unknown> | null;

  const artifacts = root?.artifacts;
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    const a0 = artifacts[0] as Record<string, unknown>;
    candidates.push(pickString(a0?.base64), pickString(a0?.b64_json));
  }
  candidates.push(pickString(root?.image));
  candidates.push(pickString(root?.b64_json));
  const data = root?.data;
  if (Array.isArray(data) && data.length > 0) {
    const d0 = data[0] as Record<string, unknown>;
    candidates.push(pickString(d0?.b64_json));
  }

  for (const c of candidates) {
    if (c !== null) return c;
  }

  logger.warn(
    { keys: presentKeys, context: "image-extract" },
    "image provider response has no known base64 field",
  );
  throw new AppError(
    "PROVIDER_ERROR",
    502,
    "Provider sedang bermasalah. Coba lagi nanti.",
  );
}

export interface RunImageGenerationContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  signal: AbortSignal;
  /** Model diputus server via plan; bukan argumen tool (§5.2, §11.2). */
  generation: GenerationPlan;
}

export interface RunImageGenerationArgs {
  prompt: string;
  referenceImageIds?: readonly string[];
  /** Default "1:1" bila tool tidak mengirim (keputusan §21-style). */
  aspect?: ImageAspect;
}

export interface ImageGenerationResult {
  fileId: string;
  kind: "image";
  model: ImageModelId;
  aspect: ImageAspect;
  width: number;
  height: number;
  /** ISO timestamp kedaluwarsa media (ASSET_TTL_HOURS). */
  expiresAt: string;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export async function runImageGeneration(
  ctx: RunImageGenerationContext,
  args: RunImageGenerationArgs,
): Promise<ImageGenerationResult> {
  // ── 1. Validasi (§11.2 langkah 1) ──
  const prompt = args.prompt.trim();
  if (prompt.length < PROMPT_MIN || prompt.length > PROMPT_MAX) {
    throw new AppError("INVALID_PARAMS", 400, "Prompt harus 1-2000 karakter.");
  }
  const aspect: ImageAspect =
    args.aspect !== undefined && IMAGE_ASPECTS.has(args.aspect)
      ? args.aspect
      : "1:1";

  // ── 2. Kill switch (§8.4) ──
  assertMediaEnabled();

  const model = "flux2-klein" as const;
  const engine = "flux2" as const;
  const refIds = [...(args.referenceImageIds ?? [])];

  if (refIds.length > 4) {
    throw new AppError(
      "IMAGE_REFERENCE_LIMIT",
      400,
      "Maksimal 4 gambar referensi untuk satu permintaan edit.",
    );
  }

  const user = await UserModel.findById(ctx.userId)
    .select({ createdAt: 1 })
    .lean();

  if (!user) throw AppError.notFound();

  await assertGlobalDailyCap(engine);
  await assertUserDailyLimit(ctx.userId, "image_flux2", user.createdAt);
  await assertNoActiveJob(ctx.userId);

  const imageUrls: string[] = [];

  if (refIds.length > 0) {
    if (!process.env.FAL_KEY?.trim()) {
      throw new AppError(
        "IMAGE_EDIT_UNAVAILABLE",
        503,
        "Edit gambar upload belum aktif di server ini.",
      );
    }

    const docs = await FileDocModel.find({
      _id: { $in: refIds },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      status: "ready",
      expired: { $ne: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    })
      .select({ mime: 1, storage: 1 })
      .lean();

    const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
    const storage = getStorage();

    for (const id of refIds) {
      const doc = byId.get(id);
      if (
        !doc ||
        doc.storage.driver !== "r2" ||
        !["image/png", "image/jpeg", "image/webp"].includes(doc.mime)
      ) {
        throw new AppError(
          "IMAGE_REFERENCE_INVALID",
          400,
          "Referensi harus berupa PNG, JPEG, atau WebP yang tersedia di chat ini.",
        );
      }

      imageUrls.push(
        await storage.presignGet(doc.storage.key, { expiresInSec: 600 }),
      );
    }
  }

  // ── 4. Job + konsumsi kredit atomik (§11.2 langkah 5) ──
  const startMs = Date.now();
  const now = new Date();
  const job = await GenerationJobModel.create({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
    kind: "image",
    engine,
    status: "running",
    params: { aspect, modelId: model },
    creditCost: { imageFlux3: 0, videoCosmos: 0 },
    attempts: 1,
    queuedAt: now,
    startedAt: now,
  });
  const jobIdStr = job._id.toString();

  const finishFailed = async (code: string, message: string): Promise<void> => {
    await GenerationJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: ctx.signal.aborted ? "cancelled" : "failed",
          error: { code, message },
          finishedAt: new Date(),
        },
      },
    );
  };

  try {
    const size = resolveImageSize(aspect, model);
    const json = await withImageSlot(
      () =>
        imageUrls.length > 0
          ? editFlux2Image(prompt, imageUrls, size, ctx.signal)
          : generateImageFlux2(
              { prompt, width: size.width, height: size.height },
              ctx.signal,
            ),
      ctx.signal,
    );

    // ── 6. Decode → R2 → FileDoc (§10.1, sebelum Block ke FE) ──
    const base64 = extractImageBase64(json);
    const buf = Buffer.from(base64, "base64");
    const detected = detectImageMime(buf);
    if (!detected) {
      throw new AppError(
        "PROVIDER_ERROR",
        502,
        "Provider mengirim format gambar yang tidak dikenali.",
      );
    }
    const ext = MIME_EXT[detected] ?? "png";
    const name = `image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;

    const saved = await saveGeneratedMedia({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      name,
      kind: "image",
      width: size.width,
      height: size.height,
      aspect,
      engine,
      model: "flux.2-klein-4b",
      buf,
    });

    // ── 7. Sukses: job succeeded + counter (§11.2 langkah 7) ──
    await GenerationJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "succeeded",
          fileId: new Types.ObjectId(saved.fileId),
          finishedAt: new Date(),
        },
      },
    );
    if (model === "flux2-klein") {
      await incrementUserUsage(ctx.userId, "image_flux2");
    }
    await incrementGlobalDaily(engine);

    logger.info(
      {
        jobId: jobIdStr,
        userId: ctx.userId.toString(),
        engine,
        status: "succeeded",
        durationMs: Date.now() - startMs,
        refunded: false,
      },
      "image job finished",
    );

    return {
      fileId: saved.fileId,
      kind: "image",
      model,
      aspect,
      width: size.width,
      height: size.height,
      expiresAt: saved.expiresAt.toISOString(),
    };
  } catch (err) {
    const code = err instanceof AppError ? err.code : "PROVIDER_ERROR";
    const message =
      err instanceof Error ? err.message : "Image generation failed";
    await finishFailed(code, message).catch(() => {});
    logger.info(
      {
        jobId: jobIdStr,
        userId: ctx.userId.toString(),
        engine,
        status: ctx.signal.aborted ? "cancelled" : "failed",
        durationMs: Date.now() - startMs,
        errorCode: code,
        refunded: false,
      },
      "image job finished",
    );
    throw err;
  }
}
