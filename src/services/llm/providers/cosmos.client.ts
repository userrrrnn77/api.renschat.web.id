// src/services/providers/cosmos.client.ts
import { env } from "@config/env.js";
import { AppError } from "../../../middleware/error.js";
import { logger } from "@config/logger.js";
import { postCosmosGeneration } from "./nvidia.http.js";

/**
 * Client `nvidia/cosmos3-nano` (§4.4). Donatur, 1 kredit video per generate.
 * v1 hanya mode `text2video`. Semua field wajib `model_mode`.
 */

const COSMOS_PATH = "/nvidia/cosmos3-nano";

export type CosmosAspect = "16:9" | "9:16";

export type CosmosTier = "256" | "480" | "720";

/** §12.1: 16:9 → "480_16_9"; 9:16 → "480_9_16". Default proyek tier 480. */
export function mapAspectToCosmosResolution(aspect: CosmosAspect): string {
  return aspect === "9:16" ? "480_9_16" : "480_16_9";
}

/** Dimensi aktual per resolusi (§4.4: `480_16_9` = 832×480). */
export function resolutionDimensions(resolution: string): {
  width: number;
  height: number;
} {
  if (resolution === "480_9_16") return { width: 480, height: 832 };
  return { width: 832, height: 480 };
}

const TIER_BOUNDS: Record<CosmosTier, { min: number; max: number }> = {
  "256": { min: 25, max: 397 },
  "480": { min: 25, max: 297 },
  "720": { min: 25, max: 197 },
};

/**
 * Validasi `num_frames` (§4.4): pola 4k+1 dan di dalam rentang tier.
 * Default proyek: 97, tier 480. Invalid → INVALID_PARAMS.
 */
export function validateNumFrames(
  numFrames: number,
  tier: CosmosTier = "480",
): number {
  const bounds = TIER_BOUNDS[tier];
  const inRange = numFrames >= bounds.min && numFrames <= bounds.max;
  const patternOk = (numFrames - 1) % 4 === 0;
  if (!inRange || !patternOk) {
    throw new AppError(
      "INVALID_PARAMS",
      400,
      `num_frames tidak valid (${numFrames}, tier ${tier}).`,
    );
  }
  return numFrames;
}

export interface CosmosRequest {
  prompt: string;
  aspect: CosmosAspect;
  /** 0 = acak (§4.4). Default 42 di service. */
  seed?: number;
}

export interface CosmosVideoOutput {
  b64_video: string;
  resolution: string;
  numFrames: number;
  fps: number;
  durationSec: number;
  width: number;
  height: number;
}

/**
 * Extractor defensif (§4.4: struktur response hosted belum pasti). Coba
 * `b64_video` lalu beberapa fallback. Kalau tidak ada → PROVIDER_ERROR;
 * hanya nama key response yang di-log (tanpa isi, §17).
 */
function extractB64Video(json: unknown): string {
  const root =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>)
      : null;
  const keys = root ? Object.keys(root) : [];

  const pick = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const candidates: Array<string | null> = [
    pick(root?.b64_video),
    pick(root?.video),
    pick(root?.output),
  ];

  for (const c of candidates) {
    if (c !== null) return c;
  }

  logger.warn(
    { keys, context: "cosmos-extract" },
    "cosmos provider response has no known base64 video field",
  );
  throw new AppError(
    "PROVIDER_ERROR",
    502,
    "Provider mengirim response yang tidak dikenali.",
  );
}

/**
 * Panggil `text2video` (§4.4). Body wajib `model_mode`, `num_frames` pola
 * 4k+1, `num_inference_steps=35`, `fps=24`, `resolution` dari aspect.
 */
export async function generateVideoCosmos(
  req: CosmosRequest,
  signal?: AbortSignal,
): Promise<CosmosVideoOutput> {
  const resolution = mapAspectToCosmosResolution(req.aspect);
  const numFrames = validateNumFrames(env.COSMOS_NUM_FRAMES, "480");
  const fps = 24;

  const body = {
    model_mode: "text2video",
    prompt: req.prompt,
    resolution,
    num_frames: numFrames,
    num_inference_steps: 35,
    fps,
    seed: req.seed ?? 42,
  };

  const result = await postCosmosGeneration(COSMOS_PATH, body, {
    timeoutMs: env.COSMOS_TIMEOUT_MS,
    signal,
    context: "cosmos",
  });

  const b64 = extractB64Video(result.json);
  const dims = resolutionDimensions(resolution);
  return {
    b64_video: b64,
    resolution,
    numFrames,
    fps,
    durationSec: Math.round((numFrames / fps) * 100) / 100,
    ...dims,
  };
}
