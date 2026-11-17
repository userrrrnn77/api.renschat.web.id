// src/services/providers/flux3.client.ts
import { env } from "@config/env.js";
import { AppError } from "../../../middleware/error.js";
import { logger } from "@config/logger.js";
import { postMediaGeneration } from "./nvidia.http.js";

/**
 * Client `flux-3-image-klein` (§4.3) — donatur, 1 kredit per generate.
 * `samples` wajib 1; `mode` hanya "Image Generation" pada v1.
 */

const FLUX3_PATH = "/black-forest-labs/flux.3-image-klein";
const FALLBACK_SIZE = 1024;

export interface Flux3Request {
  prompt: string;
  width: number;
  height: number;
}

/** Body sesuai §4.3: mode + prompt + ukuran + cfg_scale + steps + samples. */
function buildBody(
  req: Flux3Request,
  width: number,
  height: number,
): Record<string, unknown> {
  return {
    mode: "Image Generation",
    prompt: req.prompt,
    width,
    height,
    cfg_scale: env.FLUX3_CFG_SCALE,
    steps: env.FLUX3_STEPS,
    samples: 1,
  };
}

/**
 * Dokumentasi menyebut hanya 1024 yang didukung → bila request 422 dan
 * ukurannya bukan 1024x1024, retry SEKALI dengan 1024x1024 (§4.3). Retry
 * kedua gagal 422 → PROVIDER_REFUSED (kemungkinan safety filter).
 */
export async function generateImageFlux3(
  req: Flux3Request,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const result = await postMediaGeneration(
      FLUX3_PATH,
      buildBody(req, req.width, req.height),
      { timeoutMs: env.IMAGE_TIMEOUT_MS, signal, context: "flux3" },
    );
    return result.json;
  } catch (err) {
    const sizeMismatch =
      err instanceof AppError &&
      err.code === "PROVIDER_REFUSED" &&
      (req.width !== FALLBACK_SIZE || req.height !== FALLBACK_SIZE);
    if (!sizeMismatch) throw err;

    logger.warn(
      { context: "flux3", width: req.width, height: req.height },
      "flux3 422; retrying once at 1024x1024",
    );
    const result = await postMediaGeneration(
      FLUX3_PATH,
      buildBody(req, FALLBACK_SIZE, FALLBACK_SIZE),
      { timeoutMs: env.IMAGE_TIMEOUT_MS, signal, context: "flux3-retry" },
    );
    return result.json;
  }
}
