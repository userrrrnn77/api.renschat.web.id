// src/services/ingest/embedder.ts

import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { ChunkModel } from "../../models/Chunk.js";

const EMBEDDING_PATH = "/embeddings";
const MAX_INPUT_CHARS = 8_000;

export type EmbedInputType = "query" | "passage";

interface EmbedResponse {
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/**
 * Error terklasifikasi untuk embedding.
 * - `retriable`: boleh di-retry (429/5xx/timeout/network).
 * - `aborted`: user/signal abort — jangan retry, jangan dianggap kegagalan server.
 */
export class EmbeddingError extends Error {
  readonly retriable: boolean;
  readonly aborted: boolean;
  readonly status?: number;

  constructor(
    message: string,
    opts: {
      retriable?: boolean;
      aborted?: boolean;
      status?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "EmbeddingError";
    this.retriable = opts.retriable ?? false;
    this.aborted = opts.aborted ?? false;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

function abortError(): EmbeddingError {
  return new EmbeddingError("aborted", { retriable: false, aborted: true });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  const base = env.EMBEDDING_RETRY_BASE_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * env.EMBEDDING_RETRY_BASE_MS * 0.5;
  return Math.min(base + jitter, 10_000);
}

/**
 * Kombinasi dua AbortSignal tanpa mengandalkan `AbortSignal.any` (supaya
 * tidak bergantung pada lib target TS).
 */
function combineSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onA = (): void => ctrl.abort(a.reason);
  const onB = (): void => ctrl.abort(b.reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return ctrl.signal;
}

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(n: number) {
    this.permits = n;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiting.push(grant);
      const onAbort = (): void => {
        const idx = this.waiting.indexOf(grant);
        if (idx >= 0) this.waiting.splice(idx, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.permits++;
  }
}

const sem = new Semaphore(Math.max(1, env.EMBEDDING_CONCURRENCY));

function classifyHttpError(status: number): EmbeddingError {
  if (status === 429 || status >= 500) {
    return new EmbeddingError(`embedding HTTP ${status}`, {
      retriable: true,
      status,
    });
  }
  return new EmbeddingError(`embedding HTTP ${status}`, {
    retriable: false,
    status,
  });
}

function classifyFetchError(
  err: unknown,
  signal?: AbortSignal,
): EmbeddingError {
  if (signal?.aborted) return abortError();
  if (err instanceof EmbeddingError) return err;
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /timeout|timed out/i.test(msg)
  ) {
    return new EmbeddingError(`embedding timeout: ${msg}`, {
      retriable: true,
      cause: err,
    });
  }
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(
      msg,
    )
  ) {
    return new EmbeddingError(`embedding network error: ${msg}`, {
      retriable: true,
      cause: err,
    });
  }
  return new EmbeddingError(`embedding error: ${msg}`, {
    retriable: false,
    cause: err,
  });
}

function truncateInput(s: string): string {
  return s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s;
}

async function callOnce(
  inputs: string[],
  inputType: EmbedInputType,
  signal?: AbortSignal,
): Promise<number[][]> {
  const timeoutSignal = AbortSignal.timeout(env.EMBEDDING_TIMEOUT_MS);
  const combined = combineSignals(signal, timeoutSignal);

  let res: Response;
  try {
    res = await fetch(`${env.NVIDIA_BASE_URL}${EMBEDDING_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: env.EMBEDDING_MODEL,
        input: inputs,
        input_type: inputType,
        encoding_format: "float",
        truncate: "END",
      }),
      signal: combined,
    });
  } catch (err) {
    throw classifyFetchError(err, signal);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn(
      { status: res.status, body: text.slice(0, 200) },
      "embedding HTTP error",
    );
    throw classifyHttpError(res.status);
  }

  let json: EmbedResponse;
  try {
    json = (await res.json()) as EmbedResponse;
  } catch (err) {
    throw new EmbeddingError("embedding response not JSON", {
      retriable: false,
      cause: err,
    });
  }

  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  if (sorted.length !== inputs.length) {
    throw new EmbeddingError(
      `embedding count mismatch: expected ${inputs.length}, got ${sorted.length}`,
      { retriable: false },
    );
  }
  for (const item of sorted) {
    if (item.embedding.length !== env.EMBEDDING_DIM) {
      throw new EmbeddingError(
        `embedding dim mismatch: expected ${env.EMBEDDING_DIM}, got ${item.embedding.length}`,
        { retriable: false },
      );
    }
  }
  return sorted.map((d) => d.embedding);
}

/**
 * Embed array of texts via NVIDIA /embeddings. Order dijamin sama dengan
 * input. Retry terbatas + hanya untuk error retriable; user abort
 * langsung throw. Semaphore global membatasi request paralel ke provider.
 */
export async function embedTexts(
  inputs: string[],
  inputType: EmbedInputType,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (!env.EMBEDDING_ENABLED) {
    throw new EmbeddingError("embedding disabled", { retriable: false });
  }
  if (inputs.length === 0) return [];
  if (signal?.aborted) throw abortError();

  const safeInputs = inputs.map(truncateInput);
  const maxAttempts = Math.max(1, env.EMBEDDING_MAX_ATTEMPTS);

  await sem.acquire(signal);
  try {
    let lastErr: EmbeddingError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw abortError();
      try {
        return await callOnce(safeInputs, inputType, signal);
      } catch (err) {
        const e =
          err instanceof EmbeddingError ? err : classifyFetchError(err, signal);
        lastErr = e;
        if (e.aborted) throw e;
        if (!e.retriable || attempt >= maxAttempts) throw e;
        const delay = backoffMs(attempt);
        logger.warn(
          {
            attempt,
            maxAttempts,
            delayMs: Math.round(delay),
            status: e.status,
            reason: e.message,
          },
          "embedding attempt failed; retrying",
        );
        await sleep(delay, signal);
      }
    }
    throw lastErr ?? new EmbeddingError("embedding unknown failure");
  } finally {
    sem.release();
  }
}

/**
 * Embed chunks dan update dokumennya. Per batch:
 * - sukses → set embedding di Mongo.
 * - gagal non-abort → biarkan unembedded (RAG $text fallback tetap jalan).
 * - abort → return cepat dengan `aborted: true` dan embedded partial.
 */
export async function embedAndStoreChunks(
  chunks: Array<{ _id: Types.ObjectId; text: string }>,
): Promise<{ embedded: number; failed: number; aborted: boolean }> {
  if (!env.EMBEDDING_ENABLED || chunks.length === 0) {
    return { embedded: 0, failed: 0, aborted: false };
  }

  let embedded = 0;
  let failed = 0;
  const batchSize = env.EMBEDDING_BATCH_SIZE;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.text);
    try {
      const vecs = await embedTexts(texts, "passage");
      const now = new Date();
      await Promise.all(
        batch.map((c, j) =>
          ChunkModel.updateOne(
            { _id: c._id },
            {
              $set: {
                embedding: vecs[j],
                embeddingModel: env.EMBEDDING_MODEL,
                embeddedAt: now,
              },
            },
          ),
        ),
      );
      embedded += batch.length;
    } catch (err) {
      if (err instanceof EmbeddingError && err.aborted) {
        logger.info(
          { batchStart: i, batchSize: batch.length },
          "embedding aborted by signal",
        );
        return { embedded, failed, aborted: true };
      }
      failed += batch.length;
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          retriable: err instanceof EmbeddingError ? err.retriable : undefined,
          batchStart: i,
          batchSize: batch.length,
        },
        "embed batch failed; chunks remain unembedded (text fallback available)",
      );
    }
  }

  return { embedded, failed, aborted: false };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
