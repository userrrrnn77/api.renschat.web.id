// src/services/tools/generateVideoPython.ts
import { z } from "zod";
import { registerTool, okResult, truncateResult } from "./registry.js";
import { runPythonVideoJob } from "@services/generation/video.python.service.js";
import { mediaUserMessage } from "@services/generation/mediaErrors.js";
import { AppError } from "../../middleware/error.js";
import type { ToolResult } from "./registry.js";

const GenerateVideoPythonSchema = z.object({
  script: z.string().min(1).max(20_000),
  aspect_ratio: z.enum(["16:9", "9:16"]).optional(),
  duration_seconds: z.number().min(2).max(10).optional(),
  fps: z.number().int().min(12).max(30).optional(),
  title: z.string().max(200).optional(),
});

type ProgressStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// ─── generate_video_python (§13.7, kind "media") ─────────────────────────
// Hanya diekspos saat plan.videoEngine = "python" (§8.2). Model menulis
// script Python (≤20KB); backend menjahit frame via ffmpeg fixed (§13.5).
registerTool({
  name: "generate_video_python",
  kind: "media",
  description:
    "Buat satu video pendek (MP4) dengan menulis script Python yang menghasilkan frame PNG; backend menjahitnya via ffmpeg. Gratis. Gunakan saat user meminta animasi/klip tanpa kredit donatur.",
  schema: GenerateVideoPythonSchema,
  async run(args, ctx) {
    // Defense in depth: agentLoop sudah guard allowlist (§8.5).
    if (!ctx.generation.allowedMediaTools.has("generate_video_python")) {
      return errorResultStd(
        "TOOL_NOT_ALLOWED",
        "Tool generate video Python tidak diizinkan pada giliran ini.",
      );
    }

    const a = GenerateVideoPythonSchema.parse(args);

    let jobId: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const progress = (status: ProgressStatus, message?: string): void => {
      ctx.emit("media.progress", {
        jobId: jobId ?? "",
        engine: "python",
        kind: "video",
        status,
        ...(message !== undefined ? { message } : {}),
      });
    };

    try {
      progress("queued", "Menyiapkan video (script Python)...");

      const result = await runPythonVideoJob(
        {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          signal: ctx.abortSignal,
          generation: ctx.generation,
        },
        {
          script: a.script,
          ...(a.aspect_ratio !== undefined ? { aspect: a.aspect_ratio } : {}),
          ...(a.duration_seconds !== undefined
            ? { duration_seconds: a.duration_seconds }
            : {}),
          ...(a.fps !== undefined ? { fps: a.fps } : {}),
          ...(a.title !== undefined ? { title: a.title } : {}),
        },
      );

      if (result.kind === "retry") {
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        jobId = result.jobId;
        progress("failed", `Gagal di tahap ${result.stage}`);

        // §13.6: hasil tool { ok:false, stage, stderrTail ≤2KB } supaya
        // model bisa memperbaiki script. truncateResult membatasi total 2KB.
        const payload = {
          ok: false,
          stage: result.stage,
          stderrTail: result.stderrTail,
        };
        return {
          ok: false,
          content: truncateResult(JSON.stringify(payload)),
        };
      }

      jobId = result.jobId;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      progress("succeeded", "Video selesai.");

      // Block dikirim SETELAH media aman di R2 + FileDoc (§10.1).
      ctx.emitBlock({
        type: "video",
        fileId: result.fileId,
        engine: "python",
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
        kind: "video",
        engine: "python",
        aspect: result.aspect,
        durationSec: result.durationSec,
        expiresAt: result.expiresAt,
        ...(result.partialFrames
          ? {
              warning:
                "Hanya sebagian frame yang dihasilkan; video lebih pendek dari yang diminta.",
            }
          : {}),
      });
    } catch (err) {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      progress(ctx.abortSignal.aborted ? "cancelled" : "failed");

      if (err instanceof AppError) {
        return errorResultStd(
          err.code,
          mediaUserMessage(err.code, err.message),
        );
      }
      return errorResultStd(
        "PROVIDER_ERROR",
        mediaUserMessage(
          "PROVIDER_ERROR",
          "Provider generate video sedang bermasalah. Coba lagi nanti.",
        ),
      );
    }
  },
});

/** errorResult lokal yang sama bentuknya dengan registry.errorResult. */
function errorResultStd(code: string, message: string): ToolResult {
  const payload = { ok: false, error: code, message };
  return { ok: false, content: truncateResult(JSON.stringify(payload)) };
}
