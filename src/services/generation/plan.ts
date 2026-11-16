// src/services/generation/plan.ts

import { env } from "../../config/env.js";
import { z } from "zod";
import {
  assertFlux3Allowed,
  canUseCosmos,
  type EntitlementUser,
} from "../entitlements.service.js"
import { assertGlobalDailyCap } from "./budget.service.js";

/** Body `generation` opsional di POST /api/sessions/:id/messages (§7.7). */
export const GenerationInputSchema = z.object({
  mode: z.enum(["auto", "image", "video"]).default("auto"),
  imageModel: z.enum(["flux2-klein", "flux3-klein"]).optional(),
  video: z
    .object({
      aspect: z.enum(["16:9", "9:16"]).default("16:9"),
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
}

const IMAGE_TOOL = "generate_image";
const VIDEO_COSMOS_TOOL = "generate_video_cosmos";
const VIDEO_PYTHON_TOOL = "generate_video_python";

/**
 * Server hanya mengizinkan SATU tool video (§8.2).
 * Panggil hanya setelah engine final ditentukan resolveVideoEngine.
 */
export function mediaToolsForPlan(input: {
  mode: GenerationMode;
  videoEngine: GenerationVideoEngine;
}): ReadonlySet<string> {
  if (input.mode === "image") {
    return new Set([IMAGE_TOOL]);
  }
  const videoTool =
    input.videoEngine === "cosmos" ? VIDEO_COSMOS_TOOL : VIDEO_PYTHON_TOOL;
  if (input.mode === "video") {
    return new Set([videoTool]);
  }
  return new Set([IMAGE_TOOL, videoTool]);
}

/**
 * resolveVideoEngine final (§8.2, Fase 2):
 *   - `python` eksplisit → python
 *   - donatur dengan credits.videoCosmos > 0 → cosmos
 *   - selain itu → python
 * Cap global cosmos habis + request eksplisit "cosmos" → MEDIA_DISABLED;
 * request "auto" jatuh ke python (jalur gratis tetap jalan — keputusan dicatat).
 */
export async function resolveVideoEngine(
  user: EntitlementUser,
  requestedEngine: GenerationVideoEngine,
): Promise<Exclude<GenerationVideoEngine, "auto">> {
  if (requestedEngine === "python") return "python";

  const cosmosPossible = canUseCosmos(user);
  if (requestedEngine === "cosmos") {
    if (!cosmosPossible) return "python";
    await assertGlobalDailyCap("cosmos");
    return "cosmos";
  }

  // auto
  if (cosmosPossible) {
    try {
      await assertGlobalDailyCap("cosmos");
      return "cosmos";
    } catch {
      return "python";
    }
  }
  return "python";
}

/**
 * Routing server per request (§8). Urutan keputusan:
 *   1. Kill switch MEDIA_ENABLED (§8.4) → tool media tidak diekspos.
 *   2. flux3 eksplisit → ENTITLEMENT_REQUIRED / INSUFFICIENT_CREDITS (§8.1).
 *   3. resolveVideoEngine (§8.2) → satu tool video saja.
 *   4. Cap global per engine: engine yang cap-nya habis tidak diekspos;
 *      bila mode eksplisit dan engine utama habis → MEDIA_DISABLED
 *      (keputusan dicatat: mode auto tetap bisa chat tanpa tool media).
 * Mode `auto` tidak pernah memakai flux-3 diam-diam (§8.1).
 */
export async function resolveGenerationPlan(
  user: EntitlementUser,
  generation?: GenerationInput,
): Promise<GenerationPlan> {
  const mode: GenerationMode = generation?.mode ?? "auto";
  const videoAspect: GenerationVideoAspect =
    generation?.video?.aspect ?? "16:9";
  const requestedEngine: GenerationVideoEngine =
    generation?.video?.engine ?? "auto";

  // 1. Kill switch: media dimatikan → tidak ada tool media sama sekali.
  if (!env.MEDIA_ENABLED) {
    return {
      mode,
      imageModel: "flux2-klein",
      videoAspect,
      videoEngine: "python",
      allowedMediaTools: new Set<string>(),
    };
  }

  // 2. flux3 hanya via pilihan eksplisit (§8.1); non-donatur/kredit 0 → tolak.
  const requestedFlux3 = generation?.imageModel === "flux3-klein";
  if (requestedFlux3) assertFlux3Allowed(user);

  const imageModel: GenerationImageModel = requestedFlux3
    ? "flux3-klein"
    : "flux2-klein";

  // 3. Engine video final (server, bukan model).
  const videoEngine = await resolveVideoEngine(user, requestedEngine);

  // 4. Cap global per engine (§8.4).
  let imageToolAllowed = true;
  try {
    await assertGlobalDailyCap(
      imageModel === "flux3-klein" ? "flux3" : "flux2",
    );
  } catch (err) {
    if (mode === "image") throw err;
    imageToolAllowed = false;
  }

  let videoToolAllowed = true;
  try {
    await assertGlobalDailyCap(videoEngine === "cosmos" ? "cosmos" : "python");
  } catch (err) {
    if (mode === "video") throw err;
    videoToolAllowed = false;
  }

  let allowedMediaTools: ReadonlySet<string>;
  if (!imageToolAllowed && !videoToolAllowed) {
    allowedMediaTools = new Set<string>();
  } else if (!videoToolAllowed) {
    allowedMediaTools = new Set<string>([IMAGE_TOOL]);
  } else if (!imageToolAllowed) {
    allowedMediaTools = new Set<string>([
      videoEngine === "cosmos" ? VIDEO_COSMOS_TOOL : VIDEO_PYTHON_TOOL,
    ]);
  } else {
    allowedMediaTools = mediaToolsForPlan({ mode, videoEngine });
  }

  return {
    mode,
    imageModel,
    videoAspect,
    videoEngine,
    allowedMediaTools,
  };
}
