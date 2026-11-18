import { Redis } from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

if (!env.REDIS_URL) {
  logger.warn(
    "REDIS_URL tidak diset. Rate limit tidak akan berjalan multi-instance.",
  );
}

export const redisClient = new Redis(env.REDIS_URL!, {
  // Upstash TLS wajib diset true jika menggunakan rediss://
  tls: env.REDIS_URL?.startsWith("rediss://") ? {} : undefined,
  maxRetriesPerRequest: 3,
  // Upstash free tier akan memutus koneksi yang idle terlalu lama
  enableReadyCheck: true,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

let redisReady = false;

redisClient.on("error", (err) => {
  redisReady = false;
  logger.error({ err }, "Redis connection error");
});

redisClient.on("connect", () => {
  logger.info("Connected to Redis (Upstash)");
});

redisClient.on("ready", () => {
  redisReady = true;
  logger.info("Redis ready for commands");
});

redisClient.on("close", () => {
  redisReady = false;
  logger.warn("Redis connection closed");
});

redisClient.on("reconnecting", () => {
  redisReady = false;
});

redisClient.on("end", () => {
  redisReady = false;
  logger.warn("Redis connection ended");
});

/**
 * Phase 7: sumber kebenaran tunggal untuk status kesiapan Redis.
 * Rate limiter memakai ini untuk memutuskan Redis primary atau
 * in-memory fallback. Recovery terdeteksi otomatis lewat event ioredis
 * (`ready`) tanpa perlu restart proses.
 */
export function isRedisReady(): boolean {
  return Boolean(env.REDIS_URL) && redisReady && redisClient.status === "ready";
}
