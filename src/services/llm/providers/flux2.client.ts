// src/services/providers/flux2.client.ts
import { env } from "@config/env.js"; 
import { postMediaGeneration } from "./nvidia.http.js";

/**
 * Client `flux.2-klein-4b` (§4.2). Jalur gratis — tanpa kredit.
 * Field `image` (editing) sengaja tidak pernah dikirim (§2 non-goals).
 */

const FLUX2_PATH = "/black-forest-labs/flux.2-klein-4b";

export interface Flux2Request {
  prompt: string;
  width: number;
  height: number;
  /** Tidak dipakai untuk determinisme v1; 0..2^31-1 acak per call. */
  seed?: number;
}

/** Body sesuai §4.2: { prompt, width, height, seed, steps }. */
export async function generateImageFlux2(
  req: Flux2Request,
  signal?: AbortSignal,
): Promise<unknown> {
  const body = {
    prompt: req.prompt,
    width: req.width,
    height: req.height,
    seed: req.seed ?? Math.floor(Math.random() * 2 ** 31),
    steps: env.FLUX2_STEPS,
  };
  const result = await postMediaGeneration(FLUX2_PATH, body, {
    timeoutMs: env.IMAGE_TIMEOUT_MS,
    signal,
    context: "flux2",
  });
  return result.json;
}
