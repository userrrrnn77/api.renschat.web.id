// src/services/providers/nvidia.http.ts
import { env } from "@config/env.js";
import { logger } from "@config/logger.js";
import { AppError } from "../../../middleware/error.js";

/**
 * HTTP client untuk endpoint genai media NVIDIA:
 *   - `https://ai.api.nvidia.com/v1/genai/...` (§4.2/§4.3)
 *   - `https://ai.api.nvidia.com/v1/cosmos/...` (§4.4)
 * Terpisah dari llm/nvidiaClient karena basis URL, bentuk error, dan aturan
 * retry media beda (media tidak auto-retry; kegagalan → refund kredit).
 */

const GENAI_BASE_URL = "https://ai.api.nvidia.com/v1/genai";
const COSMOS_BASE_URL = "https://ai.api.nvidia.com/v1/cosmos";

export interface MediaPostOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Nama pendek untuk logging (tanpa prompt/response body). */
  context: string;
}

export interface MediaPostResult {
  status: number;
  json: unknown;
}

/** Peta status HTTP provider → kode error standar (§7.8). */
export function mapMediaHttpError(status: number, context: string): AppError {
  if (status === 422) {
    // Safety filter / validasi provider (§4.4, §12.2).
    return new AppError(
      "PROVIDER_REFUSED",
      422,
      "Prompt ditolak oleh filter keamanan model. Coba ubah prompt-nya.",
    );
  }
  if (status === 429) {
    return new AppError(
      "RATE_LIMITED",
      429,
      "Provider sedang sibuk. Coba lagi beberapa saat.",
    );
  }
  logger.warn({ context, status }, "media provider error status");
  return new AppError(
    "PROVIDER_ERROR",
    502,
    "Provider sedang bermasalah. Coba lagi nanti.",
  );
}

async function postOnce(
  baseUrl: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    // SEMENTARA: Log error body untuk debugging
    const errorText = await res.text().catch(() => "");
    logger.error(
      { context: path, status: res.status, errorText },
      "NVIDIA media provider error",
    );
    throw mapMediaHttpError(res.status, path);
  }
  const json: unknown = await res.json();
  return { status: res.status, json };
}

async function postWithBaseUrl(
  baseUrl: string,
  path: string,
  body: unknown,
  opts: MediaPostOptions,
): Promise<MediaPostResult> {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error("media timeout")),
    opts.timeoutMs,
  );
  timer.unref?.();

  const onExternalAbort = (): void => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    return await postOnce(baseUrl, path, body, ac.signal);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (ac.signal.aborted) {
      throw new AppError("JOB_TIMEOUT", 504, "Waktu generate habis.");
    }
    logger.warn(
      { context: opts.context, err: String(err) },
      "media post failed",
    );
    throw new AppError(
      "PROVIDER_ERROR",
      502,
      "Provider sedang bermasalah. Coba lagi nanti.",
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * POST ke endpoint genai (gambar) dengan timeout keras dan dukungan abort
 * eksternal (§11.2 langkah 6). Timeout/abort → `JOB_TIMEOUT`.
 */
export async function postMediaGeneration(
  path: string,
  body: unknown,
  opts: MediaPostOptions,
): Promise<MediaPostResult> {
  return postWithBaseUrl(GENAI_BASE_URL, path, body, opts);
}

/**
 * POST ke endpoint cosmos (video) dengan timeout keras dan abort eksternal
 * (§12.1: `COSMOS_TIMEOUT_MS=600000`, menghormati `signal`).
 * Catatan: Cosmos juga ada di bawah /genai, bukan /cosmos (yang bikin 404).
 */
export async function postCosmosGeneration(
  path: string,
  body: unknown,
  opts: MediaPostOptions,
): Promise<MediaPostResult> {
  return postWithBaseUrl(COSMOS_BASE_URL, path, body, opts);
}
