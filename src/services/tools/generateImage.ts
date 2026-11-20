// src/services/tools/generateImage.ts
import { z } from "zod";
import { registerTool, okResult, errorResult } from "./registry.js";
import { runImageGeneration } from "@services/generation/image.service.js";
import { mediaUserMessage } from "@services/generation/mediaErrors.js";
import { AppError } from "../../middleware/error.js";

const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(2000),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16"]).optional(),
  use_references: z
    .boolean()
    .optional()
    .describe(
      "Gunakan gambar yang dilampirkan pada pesan ini untuk editing. " +
        "Set false bila user secara eksplisit meminta gambar baru yang independen.",
    ),
});

// ─── generate_image (§11.3, kind "media") ────────────────────────────────
// Argumen dari model HANYA prompt & aspect_ratio (§5.2): model, user, dan
// kredit ditentukan server lewat ctx.generation.
registerTool({
  name: "generate_image",
  kind: "media",
  description:
    "Generate satu gambar dari deskripsi teks dan tampilkan sebagai gambar di chat. Gunakan saat user meminta gambar, ilustrasi, foto, poster, atau visual.",
  schema: GenerateImageSchema,
  async run(args, ctx) {
    // Defense in depth: agentLoop sudah guard allowlist (§8.5), tool
    // memvalidasi ulang.
    if (!ctx.generation.allowedMediaTools.has("generate_image")) {
      return errorResult(
        "TOOL_NOT_ALLOWED",
        "Tool generate gambar tidak diizinkan pada giliran ini.",
      );
    }

    const a = GenerateImageSchema.parse(args);

    try {
      if (
        a.use_references === true &&
        ctx.generation.referenceImageIds.length === 0
      ) {
        return errorResult(
          "IMAGE_REFERENCE_REQUIRED",
          "Lampirkan gambar yang ingin diedit pada pesan ini.",
        );
      }

      const result = await runImageGeneration(
        {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          signal: ctx.abortSignal,
          generation: ctx.generation,
        },
        {
          prompt: a.prompt,
          aspect: a.aspect_ratio,
          referenceImageIds:
            a.use_references === false ? [] : ctx.generation.referenceImageIds,
        },
      );

      // Block hanya dikirim SETELAH media aman di R2 + FileDoc (§10.1).
      ctx.emitBlock({
        type: "image",
        fileId: result.fileId,
        alt: a.prompt.slice(0, 200),
        expiresAt: result.expiresAt,
        width: result.width,
        height: result.height,
      });

      // Ringkas, < 2 KB, tanpa base64 (§0.1).
      return okResult({
        fileId: result.fileId,
        kind: result.kind,
        model: result.model,
        aspect: result.aspect,
        width: result.width,
        height: result.height,
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return errorResult(err.code, mediaUserMessage(err.code, err.message));
      }
      return errorResult(
        "PROVIDER_ERROR",
        mediaUserMessage(
          "PROVIDER_ERROR",
          "Provider generate sedang bermasalah. Coba lagi nanti.",
        ),
      );
    }
  },
});
