// src/server.ts

import mongoose from "mongoose";
import { env } from "./src/config/env.js";
import { logger } from "./src/config/logger.js";
import { connectToDatabase } from "./src/db/connect.js";
import { buildApp } from "./src/app.js";
import { closePdfEngine } from "./src/services/pdf/engine.js";
import { startCleanup, stopCleanup } from "./src/services/jobs/cleanup.js";
import {
  abortAllStreams,
  activeStreamCount,
} from "./src/services/chat/activeStreams.js";
import {
  drainIngestion,
  resumePendingEmbeddings,
  resumePendingIngestion,
} from "./src/services/ingest/index.js";
import {
  recoverStaleJobs,
  startJobRecoveryScheduler,
  stopJobRecoveryScheduler,
} from "./src/services/generation/job.runner.js";

async function bootstrap(): Promise<void> {
  await connectToDatabase();

  // §7.6: scheduler in-process (cleanup 15 menit + recovery periodic)
  // hanya berjalan bila ENABLE_IN_PROCESS_SCHEDULER=true. Bila false,
  // trigger lewat POST /internal/cron/flush-assets (CRON_SECRET) dari
  // cron eksternal.
  if (env.ENABLE_IN_PROCESS_SCHEDULER) {
    startCleanup();
    startJobRecoveryScheduler();
  }

  // Recover state from a previous crash — selalu dijalankan sekali saat
  // boot, terlepas dari flag scheduler.
  //   1. Files stuck at status="processing" (extraction mid-flight)
  //   2. Files with indexStatus="pending"/"indexing" (embedding mid-flight)
  //   3. GenerationJob queued/running yang lebih tua dari JOB_STALE_MS
  //      (§12.2) — mark failed + refund kredit.
  await resumePendingIngestion();
  await resumePendingEmbeddings();
  try {
    await recoverStaleJobs();
  } catch (err) {
    logger.warn({ err }, "recoverStaleJobs failed");
  }

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        inProcessScheduler: env.ENABLE_IN_PROCESS_SCHEDULER,
      },
      "server listening",
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { signal, activeStreams: activeStreamCount() },
      "shutdown initiated",
    );

    const forceTimer = setTimeout(() => {
      logger.fatal("forced exit after 15s");
      process.exit(1);
    }, 15_000);
    forceTimer.unref?.();

    server.close((closeErr) => {
      if (closeErr) logger.error({ err: closeErr }, "http server close error");
    });

    abortAllStreams();
    const drainDeadline = Date.now() + 10_000;
    while (activeStreamCount() > 0 && Date.now() < drainDeadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (activeStreamCount() > 0) {
      logger.warn(
        { remaining: activeStreamCount() },
        "streams still active after drain",
      );
    }

    try {
      await drainIngestion(10_000);
    } catch (err) {
      logger.error({ err }, "drainIngestion error");
    }

    try {
      await closePdfEngine();
    } catch (err) {
      logger.error({ err }, "closePdfEngine error");
    }

    stopCleanup();
    stopJobRecoveryScheduler();

    try {
      await mongoose.disconnect();
    } catch (err) {
      logger.error({ err }, "mongo disconnect error");
    }

    clearTimeout(forceTimer);
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, "bootstrap failed");
  process.exit(1);
});
