// src/middleware/rateLimit.ts

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import {
  RedisStore,
  type SendCommandFn,
  type RedisReply,
} from "rate-limit-redis";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { redisClient, isRedisReady } from "../config/redis.js";

const isDev = env.NODE_ENV !== "production";

/* -------------------------------------------------------------------------- */
/*                                Timer utils                                 */
/* -------------------------------------------------------------------------- */

type Unrefable = { unref?: () => void };

function unrefTimer(timer: unknown): void {
  const t = timer as Unrefable | null;
  if (t && typeof t.unref === "function") t.unref();
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    unrefTimer(timer);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/*                              Redis command                                 */
/* -------------------------------------------------------------------------- */

const sendCommand: SendCommandFn = (...args: string[]) => {
  const [command, ...rest] = args;
  return withTimeout(
    redisClient.call(command, ...rest) as Promise<RedisReply>,
    env.RATE_LIMIT_REDIS_TIMEOUT_MS,
    "redis rate-limit command",
  );
};

/* -------------------------------------------------------------------------- */
/*                       In-memory fallback store (§7)                        */
/* -------------------------------------------------------------------------- */

interface MemoryBucket {
  totalHits: number;
  resetTime: number;
}

interface IncrementResult {
  totalHits: number;
  resetTime: Date | undefined;
}

const memoryStores = new Set<InMemoryRateLimitStore>();
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    for (const store of memoryStores) store.sweep();
  }, env.RATE_LIMIT_MEMORY_SWEEP_MS);
  unrefTimer(sweeperTimer);
}

function stopSweeperIfIdle(): void {
  if (memoryStores.size === 0 && sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}

class InMemoryRateLimitStore {
  localKeys = true;

  private windowMs = 60_000;
  private buckets = new Map<string, MemoryBucket>();

  constructor() {
    memoryStores.add(this);
    ensureSweeper();
  }

  init(options: unknown): void {
    const o = options as { windowMs?: number } | undefined;
    if (o && typeof o.windowMs === "number") {
      this.windowMs = o.windowMs;
    }
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetTime <= now) this.buckets.delete(key);
    }
  }

  private enforceMaxEntries(now: number): void {
    if (this.buckets.size <= env.RATE_LIMIT_MEMORY_MAX_ENTRIES) return;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetTime <= now) this.buckets.delete(key);
    }

    const overflow = this.buckets.size - env.RATE_LIMIT_MEMORY_MAX_ENTRIES;
    if (overflow <= 0) return;

    let removed = 0;
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  async increment(key: string): Promise<IncrementResult> {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || bucket.resetTime <= now) {
      bucket = { totalHits: 1, resetTime: now + this.windowMs };
      this.buckets.set(key, bucket);
    } else {
      bucket.totalHits += 1;
    }

    this.enforceMaxEntries(now);

    return {
      totalHits: bucket.totalHits,
      resetTime: new Date(bucket.resetTime),
    };
  }

  async decrement(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    bucket.totalHits = Math.max(0, bucket.totalHits - 1);
  }

  async resetKey(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  async shutdown(): Promise<void> {
    this.buckets.clear();
    memoryStores.delete(this);
    stopSweeperIfIdle();
  }
}

/* -------------------------------------------------------------------------- */
/*                    Hybrid store: Redis primary + fallback                  */
/* -------------------------------------------------------------------------- */

class HybridRateLimitStore {
  localKeys = false;

  private readonly label: string;
  private readonly redisStore: RedisStore;
  private readonly memoryStore: InMemoryRateLimitStore;
  private fallbackActive = false;
  private redisSkipUntil = 0;

  constructor(label: string) {
    this.label = label;
    this.redisStore = new RedisStore({
      sendCommand,
      prefix: `genui:ratelimit:${label}:`,
    });
    this.memoryStore = new InMemoryRateLimitStore();
  }

  init(options: unknown): void {
    const rs = this.redisStore as unknown as {
      init?: (o: unknown) => void;
    };
    if (typeof rs.init === "function") rs.init.call(this.redisStore, options);
    this.memoryStore.init(options);
  }

  private noteRedisFailure(reason: unknown): void {
    this.redisSkipUntil = Date.now() + env.RATE_LIMIT_REDIS_COOLDOWN_MS;
    if (!this.fallbackActive) {
      this.fallbackActive = true;
      logger.warn(
        {
          store: this.label,
          reason: reason instanceof Error ? reason.message : String(reason),
        },
        "Redis rate-limit store unavailable, using in-memory fallback (per-process only)",
      );
    }
  }

  private noteRedisSuccess(): void {
    this.redisSkipUntil = 0;
    if (this.fallbackActive) {
      this.fallbackActive = false;
      logger.info(
        { store: this.label },
        "Redis rate-limit store recovered, back to Redis primary",
      );
    }
  }

  private redisUsable(): boolean {
    if (!isRedisReady()) return false;
    if (Date.now() < this.redisSkipUntil) return false;
    return true;
  }

  async increment(key: string): Promise<IncrementResult> {
    if (this.redisUsable()) {
      try {
        const result = (await this.redisStore.increment(
          key,
        )) as IncrementResult;
        this.noteRedisSuccess();
        return result;
      } catch (err) {
        this.noteRedisFailure(err);
      }
    } else if (!this.fallbackActive) {
      this.noteRedisFailure(new Error("redis not ready"));
    }

    return this.memoryStore.increment(key);
  }

  async decrement(key: string): Promise<void> {
    if (this.redisUsable()) {
      try {
        await this.redisStore.decrement(key);
        return;
      } catch (err) {
        this.noteRedisFailure(err);
      }
    }
    await this.memoryStore.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    if (this.redisUsable()) {
      try {
        await this.redisStore.resetKey(key);
      } catch (err) {
        this.noteRedisFailure(err);
      }
    }
    await this.memoryStore.resetKey(key);
  }

  async shutdown(): Promise<void> {
    try {
      const rs = this.redisStore as unknown as {
        shutdown?: () => Promise<void> | void;
      };
      if (typeof rs.shutdown === "function") {
        await rs.shutdown.call(this.redisStore);
      }
    } catch {
      // best-effort
    }
    await this.memoryStore.shutdown();
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Limiters                                  */
/* -------------------------------------------------------------------------- */

// `as any` di sini bukan hack: express-rate-limit v8 punya tipe internal
// (ConfigStore/Store) yang sering berubah antar patch. Runtime-nya hanya
// memanggil init/increment/decrement/resetKey, semua sudah kita sediakan.
const createRateLimitOptions = (prefix: string) => ({
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  store: new HybridRateLimitStore(prefix) as any,
});

function userOrIpKey(req: Request): string {
  const locals = (req.res?.locals ?? {}) as Record<string, unknown>;
  const userId = locals.userId;
  if (userId !== undefined && userId !== null) {
    return `u:${String(userId)}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? "::1")}`;
}

export const globalLimiter = rateLimit({
  ...createRateLimitOptions("global"),
  windowMs: 60_000,
  limit: isDev ? 1000 : 300,
  message: { error: { code: "RATE_LIMIT", message: "Too many requests" } },
});

export const authLimiter = rateLimit({
  ...createRateLimitOptions("auth"),
  windowMs: 60_000,
  limit: isDev ? 50 : 10,
  message: { error: { code: "RATE_LIMIT", message: "Too many auth attempts" } },
});

export const messageLimiter = rateLimit({
  ...createRateLimitOptions("message"),
  windowMs: 60_000,
  limit: isDev ? 100 : 20,
  keyGenerator: userOrIpKey,
  message: { error: { code: "RATE_LIMIT", message: "Too many messages" } },
});

export const filesLimiter = rateLimit({
  ...createRateLimitOptions("files"),
  windowMs: 60_000,
  limit: isDev ? 100 : 30,
  keyGenerator: userOrIpKey,
  message: { error: { code: "RATE_LIMIT", message: "Too many file requests" } },
});

export const claimDonationLimiter = rateLimit({
  ...createRateLimitOptions("claim-donation"),
  windowMs: 60 * 60_000,
  limit: isDev ? 20 : 5,
  keyGenerator: userOrIpKey,
  message: {
    error: {
      code: "RATE_LIMIT",
      message: "Terlalu banyak percobaan klaim. Coba lagi nanti.",
    },
  },
});
