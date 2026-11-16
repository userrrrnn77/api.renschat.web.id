// src/services/generation/job.runner.ts
import { GenerationJobModel } from "../../models/GenerationJob.js";
import { refundJobCredits } from "../credits.service.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";

const RECOVERY_INTERVAL_MS = 5 * 60_000;

/**
 * Recover stale jobs saat boot (§12.2). Job `queued`/`running` yang lebih
 * tua dari `JOB_STALE_MS` dianggap mati (proses sebelumnya crash/abort
 * tanpa cleanup) → status `failed`, kredit dikembalikan idempotent.
 * Idempotent: reclaim via update kondisional `status ∈ {queued,running}`,
 * sehingga runner yang balapan (dua instance) hanya satu yang menang.
 */
export async function recoverStaleJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - env.JOB_STALE_MS);
  const stale = await GenerationJobModel.find({
    status: { $in: ["queued", "running"] },
    queuedAt: { $lt: cutoff },
  }).lean();

  if (stale.length === 0) return;

  let recovered = 0;
  for (const job of stale) {
    const claimed = await GenerationJobModel.updateOne(
      { _id: job._id, status: { $in: ["queued", "running"] } },
      {
        $set: {
          status: "failed",
          error: {
            code: "JOB_TIMEOUT",
            message: "Job melewati batas waktu (stale saat boot).",
          },
          finishedAt: new Date(),
        },
      },
    );
    if ((claimed.modifiedCount ?? 0) === 0) continue;
    recovered += 1;

    const needsRefund =
      job.creditCost.imageFlux3 > 0 || job.creditCost.videoCosmos > 0;

    if (needsRefund) {
      try {
        await refundJobCredits(job);
      } catch (err) {
        logger.error(
          { err, jobId: job._id.toString() },
          "recoverStaleJobs refund failed",
        );
      }
    }

    logger.info(
      {
        jobId: job._id.toString(),
        userId: job.userId.toString(),
        engine: job.engine,
        status: "failed",
        errorCode: "JOB_TIMEOUT",
        refunded: needsRefund,
      },
      "stale job recovered",
    );
  }

  logger.info({ recovered, total: stale.length }, "recoverStaleJobs done");
}

// ── Periodic scheduler (§7.6 / §8.4) ─────────────────────────────────────

let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Scheduler periodic `recoverStaleJobs` (§7.6). Hanya berjalan bila
 * `ENABLE_IN_PROCESS_SCHEDULER=true` (dipanggil dari server.ts). Boot
 * selalu menjalankan `recoverStaleJobs()` sekali untuk recovery crash
 * terakhir — scheduler ini menangkap kasus job yang macet di tengah
 * proses tanpa restart.
 */
export function startJobRecoveryScheduler(): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    void recoverStaleJobs().catch((err: unknown) => {
      logger.warn({ err }, "recoverStaleJobs periodic failed");
    });
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
  logger.info(
    { intervalMs: RECOVERY_INTERVAL_MS },
    "job recovery scheduler started",
  );
}

export function stopJobRecoveryScheduler(): void {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
    logger.info("job recovery scheduler stopped");
  }
}
