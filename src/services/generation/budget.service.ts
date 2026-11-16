// src/services/generation/budget.service.ts
import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { AppError } from "../../middleware/error.js";
import { logger } from "../../config/logger.js";
import {
  GenerationJobModel,
  type GenerationEngine,
} from "../../models/GenerationJob.js";
import {
  GlobalUsageCounterModel,
  UsageCounterModel,
  type GlobalUsageEngine,
  type UsageCounterKey,
} from "../../models/UsageCounter.js";

export type UsageKey = UsageCounterKey;

const CAP_BY_ENGINE: Record<GlobalUsageEngine, number> = {
  flux2: env.GLOBAL_DAILY_CAP_FLUX2,
  flux3: env.GLOBAL_DAILY_CAP_FLUX3,
  cosmos: env.GLOBAL_DAILY_CAP_COSMOS,
  python: env.GLOBAL_DAILY_CAP_PYTHON,
};

const USER_DAILY_LIMIT: Record<UsageKey, number> = {
  image_flux2: env.IMAGE_FREE_DAILY_LIMIT,
  video_python: env.VIDEO_PYTHON_DAILY_LIMIT,
};

const NEW_ACCOUNT_WINDOW_MS = 24 * 3600_000;

/** `YYYY-MM-DD` di UTC+7 (WIB), sesuai §6.6. */
export function wibDayString(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** TTL counter: akhir hari WIB + 3 hari (§6.6). */
function counterExpiry(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  // UTC+7 midnight berikutnya = UTC jam 17:00 pada hari itu.
  return new Date(Date.UTC(y, m - 1, d) + 17 * 3600_000 + 3 * 24 * 3600_000);
}

export function assertMediaEnabled(): void {
  if (!env.MEDIA_ENABLED) {
    throw new AppError(
      "MEDIA_DISABLED",
      503,
      "Fitur media sedang dinonaktifkan sementara.",
    );
  }
}

/** Cap harian global per engine (§8.4). Terlampaui → MEDIA_DISABLED. */
export async function assertGlobalDailyCap(
  engine: GlobalUsageEngine,
): Promise<void> {
  const day = wibDayString();
  const doc = await GlobalUsageCounterModel.findOne({ day, engine })
    .select({ count: 1 })
    .lean();
  if ((doc?.count ?? 0) >= CAP_BY_ENGINE[engine]) {
    logger.warn({ engine, day, count: doc?.count }, "global daily cap hit");
    throw new AppError(
      "MEDIA_DISABLED",
      503,
      "Fitur media sedang dinonaktifkan sementara.",
    );
  }
}

/** Dipotong hanya saat generate sukses (keputusan §8.4: reservasi tidak dipakai). */
export async function incrementGlobalDaily(
  engine: GlobalUsageEngine,
): Promise<void> {
  const day = wibDayString();
  await GlobalUsageCounterModel.findOneAndUpdate(
    { day, engine },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: counterExpiry(day) },
    },
    { upsert: true },
  );
}

/** Limit harian efektif; akun < 24 jam × NEW_ACCOUNT_DAILY_FACTOR (§8.4). */
export function effectiveDailyLimit(
  key: UsageKey,
  accountCreatedAt?: Date,
): number {
  const base = USER_DAILY_LIMIT[key];
  if (
    accountCreatedAt !== undefined &&
    Date.now() - accountCreatedAt.getTime() < NEW_ACCOUNT_WINDOW_MS
  ) {
    return Math.max(0, Math.floor(base * env.NEW_ACCOUNT_DAILY_FACTOR));
  }
  return base;
}

export async function getDailyCount(
  userId: Types.ObjectId,
  key: UsageKey,
): Promise<number> {
  const doc = await UsageCounterModel.findOne({
    userId,
    day: wibDayString(),
    key,
  })
    .select({ count: 1 })
    .lean();
  return doc?.count ?? 0;
}

/** Limit harian per user (§8.3). Terlampaui → RATE_LIMITED. */
export async function assertUserDailyLimit(
  userId: Types.ObjectId,
  key: UsageKey,
  accountCreatedAt?: Date,
): Promise<void> {
  const limit = effectiveDailyLimit(key, accountCreatedAt);
  const count = await getDailyCount(userId, key);
  if (count >= limit) {
    throw new AppError(
      "RATE_LIMITED",
      429,
      "Kuota harian tercapai. Coba lagi besok.",
    );
  }
}

/** Hitung pemakaian hanya saat generate sukses (§11.2 langkah 7). */
export async function incrementUserUsage(
  userId: Types.ObjectId,
  key: UsageKey,
): Promise<void> {
  const day = wibDayString();
  await UsageCounterModel.findOneAndUpdate(
    { userId, day, key },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: counterExpiry(day) },
    },
    { upsert: true },
  );
}

/** 1 job generate aktif per user (§8.3). */
export async function assertNoActiveJob(userId: Types.ObjectId): Promise<void> {
  const active = await GenerationJobModel.findOne({
    userId,
    status: { $in: ["queued", "running"] },
  })
    .select({ _id: 1 })
    .lean();
  if (active) {
    throw new AppError(
      "GENERATION_BUSY",
      409,
      "Masih ada proses generate yang berjalan. Tunggu sampai selesai.",
    );
  }
}

// ── Semaphore global (§8.3) ───────────────────────────────────────────────

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Semaphore {
  private slots: number;
  private waiters: Waiter[] = [];

  constructor(slots: number) {
    this.slots = slots;
  }

  /**
   * Ambil slot; antre maks `maxWaitMs` → RATE_LIMITED (§8.3). Batal otomatis
   * bila `signal` aborted (client disconnect, §14.3).
   */
  async acquire(maxWaitMs: number, signal?: AbortSignal): Promise<() => void> {
    if (this.slots > 0) {
      this.slots -= 1;
      return () => this.release();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve(() => this.release());
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        timer: setTimeout(() => {
          reject(
            new AppError(
              "RATE_LIMITED",
              429,
              "Antrian generate penuh. Coba lagi sebentar.",
            ),
          );
        }, maxWaitMs),
      };

      const cleanup = (): void => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
      };
      const onAbort = (): void => {
        reject(new Error("aborted while waiting for slot"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.slots += 1;
  }
}

const imageSemaphore = new Semaphore(env.GEN_GLOBAL_CONCURRENCY);

/**
 * Jalankan `fn` dalam slot semaphore global gambar (§8.3: GEN_GLOBAL_CONCURRENCY).
 * Antre > QUEUE_MAX_WAIT_MS → RATE_LIMITED; slot tetap dilepas di finally.
 */
export async function withImageSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await imageSemaphore.acquire(env.QUEUE_MAX_WAIT_MS, signal);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Peta tool media → engine (dipakai pengecekan budget per tool). */
export function engineFromPlan(
  generation: { imageModel: string; videoEngine: string },
  toolName: string,
): GenerationEngine {
  if (toolName === "generate_image") {
    return generation.imageModel === "flux3-klein" ? "flux3" : "flux2";
  }
  return generation.videoEngine === "cosmos" ? "cosmos" : "python";
}

const videoSemaphore = new Semaphore(env.VIDEO_GLOBAL_CONCURRENCY);

/**
 * Jalankan `fn` dalam slot semaphore global video (§8.3: VIDEO_GLOBAL_CONCURRENCY).
 * Antre > QUEUE_MAX_WAIT_MS → RATE_LIMITED; slot tetap dilepas di finally.
 */
export async function withVideoSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await videoSemaphore.acquire(env.QUEUE_MAX_WAIT_MS, signal);
  try {
    return await fn();
  } finally {
    release();
  }
}
