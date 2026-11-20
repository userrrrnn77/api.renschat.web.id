// src/services/tools/generateVideoCosmos.ts
import { z } from "zod";
import { registerTool, okResult, errorResult } from "./registry.js";
import { runCosmosVideoJob } from "@services/generation/video.cosmos.service.js";
import { mediaUserMessage } from "@services/generation/mediaErrors.js";
import { AppError } from "../../middleware/error.js";
import { renderPythonFallback } from "./cosmosFallback.js";

const GenerateVideoCosmosSchema = z.object({
  prompt: z.string().min(1).max(1500),
  aspect_ratio: z.enum(["16:9", "9:16"]).optional(),
});

type ProgressStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// ─── generate_video_cosmos (§12.3, kind "media") ─────────────────────────
// Hanya diekspos saat plan.videoEngine = "cosmos" (§8.2). Argumen dari
// model HANYA prompt & aspect_ratio (§5.2); engine/kredit/user ditentukan
// server lewat ctx.generation.
registerTool({
  name: "generate_video_cosmos",
  kind: "media",
  description:
    "Buat satu video MP4 pendek saat user meminta video, klip, atau animasi. Backend menangani pemilihan engine dan fallback otomatis.",
  schema: GenerateVideoCosmosSchema,
  async run(args, ctx) {
    // Defense in depth: agentLoop sudah guard allowlist (§8.5).
    if (!ctx.generation.allowedMediaTools.has("generate_video_cosmos")) {
      return errorResult(
        "TOOL_NOT_ALLOWED",
        "Tool generate video Cosmos tidak diizinkan pada giliran ini.",
      );
    }

    const a = GenerateVideoCosmosSchema.parse(args);

    let jobId: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const progress = (status: ProgressStatus, message?: string): void => {
      ctx.emit("media.progress", {
        jobId: jobId ?? "",
        engine: "cosmos",
        kind: "video",
        status,
        ...(message !== undefined ? { message } : {}),
      });
    };

    try {
      progress("queued", "Menyiapkan video...");

      const result = await runCosmosVideoJob(
        {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          signal: ctx.abortSignal,
          generation: ctx.generation,
        },
        { prompt: a.prompt, aspect: a.aspect_ratio },
        {
          onJobCreated: (id) => {
            jobId = id;
            progress("running", "Membuat video...");
            // §14.3: heartbeat media.progress ≤15 dtk selama menunggu.
            heartbeat = setInterval(() => {
              progress("running", "Masih membuat video...");
            }, 10_000);
            heartbeat.unref?.();
          },
        },
      );

      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      progress("succeeded", "Video selesai.");

      // Block dikirim SETELAH media aman di R2 + FileDoc (§10.1).
      ctx.emitBlock({
        type: "video",
        fileId: result.fileId,
        engine: "cosmos",
        aspect: result.aspect,
        durationSec: result.durationSec,
        expiresAt: result.expiresAt,
        width: result.width,
        height: result.height,
      });

      // Ringkas, < 2 KB, tanpa base64 (§0.1).
      return okResult({
        fileId: result.fileId,
        jobId: result.jobId,
        kind: result.kind,
        engine: result.engine,
        aspect: result.aspect,
        durationSec: result.durationSec,
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (ctx.abortSignal.aborted) {
        progress("cancelled");
        throw err;
      }

      progress("failed");

      const canFallback =
        err instanceof AppError &&
        ["PROVIDER_ERROR", "RATE_LIMITED", "JOB_TIMEOUT"].includes(err.code);

      if (canFallback) {
        try {
          return await renderPythonFallback(
            a.prompt,
            a.aspect_ratio ?? ctx.generation.videoAspect,
            ctx,
          );
        } catch (fallbackError) {
          if (ctx.abortSignal.aborted) throw fallbackError;

          const code =
            fallbackError instanceof AppError
              ? fallbackError.code
              : "PROVIDER_ERROR";
          const message =
            fallbackError instanceof AppError
              ? fallbackError.message
              : "Video dan versi animasinya belum berhasil dibuat.";

          return errorResult(code, mediaUserMessage(code, message));
        }
      }

      if (err instanceof AppError) {
        return errorResult(err.code, mediaUserMessage(err.code, err.message));
      }
      return errorResult(
        "PROVIDER_ERROR",
        mediaUserMessage(
          "PROVIDER_ERROR",
          "Provider generate video sedang bermasalah. Coba lagi nanti.",
        ),
      );
    }
  },
});
