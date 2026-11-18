// src/services/cache/promptCache.ts

import crypto from "node:crypto";
import type { Block } from "../blocks/schemas.js";
import type { Usage } from "../llm/nvidiaClient.js";
import type { SourcePayload } from "../rag/types.js";
import { redisClient } from "../../config/redis.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * Phase 2 — Intelligent Prompt Cache (24h).
 * Bump CACHE_VERSION ketika format payload atau komposisi cache key berubah.
 */
export const CACHE_VERSION = 1;
const KEY_PREFIX = "prompt_cache";

export interface CacheKeyInput {
  userId: string;
  normalizedPrompt: string;
  /** YYYY-MM-DD di timezone user; mencegah cache "tanggal hari ini" basi. */
  dateFingerprint: string;
  provider: string;
  model: string;
  reasoning: string;
  maxTokens: number;
  personalityMode: string;
  personalityNote: string;
  attachmentFingerprint: string;
  historyFingerprint: string;
  filesFingerprint: string;
  ragFingerprint: string;
  generationMode: string;
  toolsFingerprint: string;
}

export interface CachedTurn {
  blocks: Block[];
  usage?: Usage;
  sources?: SourcePayload[];
  toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
  createdAt: number;
}

export function fingerprintString(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function normalizePrompt(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function buildCacheKey(input: CacheKeyInput): string {
  const payload = [
    `v=${CACHE_VERSION}`,
    `provider=${input.provider}`,
    `model=${input.model}`,
    `reasoning=${input.reasoning}`,
    `maxTokens=${input.maxTokens}`,
    `personality=${input.personalityMode}:${input.personalityNote}`,
    `date=${input.dateFingerprint}`,
    `prompt=${normalizePrompt(input.normalizedPrompt)}`,
    `attach=${input.attachmentFingerprint}`,
    `history=${input.historyFingerprint}`,
    `files=${input.filesFingerprint}`,
    `rag=${input.ragFingerprint}`,
    `gen=${input.generationMode}`,
    `tools=${input.toolsFingerprint}`,
  ].join("|");

  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  return `${KEY_PREFIX}:${CACHE_VERSION}:${input.userId}:${hash}`;
}

export async function getCachedTurn(key: string): Promise<CachedTurn | null> {
  if (!env.PROMPT_CACHE_ENABLED) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) {
      logger.debug({ key }, "prompt cache miss");
      return null;
    }
    const parsed = JSON.parse(raw) as CachedTurn;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.blocks)
    ) {
      logger.warn({ key }, "prompt cache entry invalid; ignoring");
      return null;
    }
    logger.info({ key }, "prompt cache hit");
    return parsed;
  } catch (err) {
    logger.warn({ err, key }, "prompt cache get failed");
    return null;
  }
}

export async function setCachedTurn(
  key: string,
  turn: CachedTurn,
): Promise<void> {
  if (!env.PROMPT_CACHE_ENABLED) return;
  try {
    const raw = JSON.stringify(turn);
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > env.PROMPT_CACHE_MAX_BYTES) {
      logger.info({ key, bytes }, "prompt cache skip: payload too large");
      return;
    }
    await redisClient.set(key, raw, "EX", env.PROMPT_CACHE_TTL_SECONDS);
    logger.info(
      { key, bytes, ttl: env.PROMPT_CACHE_TTL_SECONDS },
      "prompt cache stored",
    );
  } catch (err) {
    logger.warn({ err, key }, "prompt cache set failed");
  }
}
