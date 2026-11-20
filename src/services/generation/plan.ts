// src/services/generation/plan.ts

import { env } from "../../config/env.js";
import { z } from "zod";
import { AppError } from "../../middleware/error.js";

/** Body `generation` opsional di POST /api/sessions/:id/messages (§7.7). */
export const GenerationInputSchema = z.object({
  mode: z.enum(["auto", "image", "video"]).default("auto"),
  imageModel: z.enum(["flux2-klein", "flux3-klein"]).optional(),
  video: z
    .object({
      aspect: z.enum(["16:9", "9:16"]).optional(),
      engine: z.enum(["auto", "cosmos", "python"]).default("auto"),
    })
    .optional(),
});

export type GenerationInput = z.infer<typeof GenerationInputSchema>;

export type GenerationMode = "auto" | "image" | "video";
export type GenerationImageModel = "flux2-klein" | "flux3-klein";
export type GenerationVideoAspect = "16:9" | "9:16";
export type GenerationVideoEngine = "auto" | "cosmos" | "python";

/** Plan yang dihitung di server tiap request; model tidak bisa mengubahnya. */
export interface GenerationPlan {
  mode: GenerationMode;
  imageModel: GenerationImageModel;
  videoAspect: GenerationVideoAspect;
  videoEngine: GenerationVideoEngine;
  /** Nama tool media yang boleh dipanggil model pada turn ini (§8.5). */
  allowedMediaTools: ReadonlySet<string>;
  referenceImageIds: readonly string[];
}

export function resolveGenerationPlan(
  generation: GenerationInput | undefined,
  referenceImageIds: readonly string[],
): GenerationPlan {
  const mode = generation?.mode ?? "auto";

  if (mode === "video") {
    throw AppError.mediaDisabled(
      "Pembuatan dan pengeditan video sedang dijeda.",
    );
  }

  return {
    mode,
    imageModel: "flux2-klein",
    videoAspect: generation?.video?.aspect ?? "16:9",
    videoEngine: "auto",
    referenceImageIds,
    allowedMediaTools: env.MEDIA_ENABLED
      ? new Set(["generate_image"])
      : new Set<string>(),
  };
}
