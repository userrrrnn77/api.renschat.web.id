// src/services/jobs/cleanup.ts
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Types } from "mongoose";
import { FileDocModel } from "../../models/FileDoc.js";
import { ChunkModel } from "../../models/Chunk.js";
import { MessageModel } from "../../models/Message.js";
import { SessionModel } from "../../models/Session.js";
import { getStorage } from "../../storage/index.js";
import { logger } from "../../config/logger.js";

const INTERVAL_MS = 15 * 60_000;
const TMP_MAX_AGE_MS = 60 * 60_000;
const STALE_FILE_MS = 60 * 60_000;
const ORPHAN_UPLOAD_BATCH = 500;
// ── Media flush (§7.6) ──
const MEDIA_FLUSH_BATCH = 200;
/** Metadata media dibersihkan 7 hari setelah expired (§10.2 lapis 3). */
const MEDIA_PURGE_AFTER_MS = 7 * 24 * 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

interface StorageRef {
  _id: Types.ObjectId;
  storage: { key: string };
}

async function cleanTmp(): Promise<void> {
  const base = join(tmpdir(), "genui");
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  const now = Date.now();
  let deleted = 0;
  for (const entry of entries) {
    try {
      const path = join(base, entry);
      const s = await stat(path);
      if (now - s.mtimeMs > TMP_MAX_AGE_MS) {
        await rm(path, { recursive: true, force: true });
        deleted++;
      }
    } catch (err) {
      logger.warn({ err, path: entry }, "cleanup tmp item failed");
    }
  }
  if (deleted > 0) logger.info({ deleted }, "cleanup: tmp dirs removed");
}

async function cleanStaleFiles(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_FILE_MS);
  const stale = (await FileDocModel.find({
    status: { $in: ["pending", "processing"] },
    createdAt: { $lt: cutoff },
  })
    .select({ _id: 1, storage: 1 })
    .lean()) as unknown as StorageRef[];

  const storage = getStorage();
  let deleted = 0;
  for (const doc of stale) {
    try {
      await FileDocModel.deleteOne({ _id: doc._id });
      await ChunkModel.deleteMany({ fileId: doc._id });
      await storage.delete(doc.storage.key).catch(() => {});
      deleted++;
    } catch (err) {
      logger.warn(
        { err, fileId: doc._id.toString() },
        "cleanup stale file failed",
      );
    }
  }
  if (deleted > 0) logger.info({ deleted }, "cleanup: stale files removed");
}

/**
 * Sapu file upload yang:
 *   - origin="upload"
 *   - status="ready" (sukses ingest, jadi tidak di-handle cleanStaleFiles)
 *   - lebih tua dari STALE_FILE_MS
 *   - TIDAK direferensi oleh Message.attachmentIds manapun
 *
 * Ini meng-cover kasus: user upload file → sukses → hapus attachment dari
 * composer → frontend gagal cleanup (mis. tab crash, network error, bug
 * regresi). File tetap ada di storage tanpa referensi logis.
 */
async function cleanOrphanUploads(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_FILE_MS);
  const candidates = (await FileDocModel.find({
    origin: "upload",
    status: "ready",
    createdAt: { $lt: cutoff },
  })
    .select({ _id: 1, storage: 1 })
    .limit(ORPHAN_UPLOAD_BATCH)
    .lean()) as unknown as StorageRef[];

  if (candidates.length === 0) return;

  const candidateIds = candidates.map((c) => c._id);
  const referencingMessages = await MessageModel.find({
    attachmentIds: { $in: candidateIds },
  })
    .select({ attachmentIds: 1 })
    .lean();

  const referenced = new Set<string>();
  for (const m of referencingMessages) {
    for (const aid of m.attachmentIds ?? []) {
      referenced.add(String(aid));
    }
  }

  const orphans = candidates.filter((c) => !referenced.has(String(c._id)));
  if (orphans.length === 0) return;

  const storage = getStorage();
  let deleted = 0;
  for (const doc of orphans) {
    try {
      await FileDocModel.deleteOne({ _id: doc._id });
      await ChunkModel.deleteMany({ fileId: doc._id });
      await storage.delete(doc.storage.key).catch(() => {});
      deleted++;
    } catch (err) {
      logger.warn(
        { err, fileId: String(doc._id) },
        "cleanup orphan upload failed",
      );
    }
  }
  if (deleted > 0) {
    logger.info({ deleted }, "cleanup: orphan uploads removed");
  }
}

async function cleanOrphans(): Promise<void> {
  const sessionIds = (await SessionModel.distinct("_id")) as Types.ObjectId[];

  const orphanFiles = (await FileDocModel.find({
    sessionId: { $nin: sessionIds },
  })
    .select({ _id: 1, storage: 1 })
    .lean()) as unknown as StorageRef[];

  const storage = getStorage();
  let deletedFiles = 0;
  for (const f of orphanFiles) {
    try {
      await storage.delete(f.storage.key).catch(() => {});
      await FileDocModel.deleteOne({ _id: f._id });
      deletedFiles++;
    } catch (err) {
      logger.warn({ err, fileId: String(f._id) }, "cleanup orphan file failed");
    }
  }

  const chunkDel = await ChunkModel.deleteMany({
    sessionId: { $nin: sessionIds },
  });
  const deletedChunks = chunkDel.deletedCount ?? 0;

  if (deletedFiles > 0 || deletedChunks > 0) {
    logger.info({ deletedFiles, deletedChunks }, "cleanup: orphans removed");
  }
}

// ── Media flush 24 jam (§7.6 / §10.2) ───────────────────────────────────

export interface FlushResult {
  deleted: number;
  failed: number;
}

/**
 * Hapus object R2 untuk FileDoc media generated yang `expiresAt <= now`
 * (batch 200), lalu tandai `expired: true` + `purgeAt = now + 7 hari`.
 * Dokumen tidak boleh hilang sebelum object R2 terhapus: kalau delete R2
 * gagal, dokumen dibiarkan `expired` false supaya dicoba lagi di run
 * berikutnya.
 *
 * Publik untuk POST /internal/cron/flush-assets (§7.6).
 */
export async function flushExpiredMedia(): Promise<FlushResult> {
  const now = new Date();
  const storage = getStorage();
  let deleted = 0;
  let failed = 0;

  const expired = (await FileDocModel.find({
    origin: "generated",
    expired: { $ne: true },
    expiresAt: { $ne: null, $lte: now },
  })
    .select({ _id: 1, storage: 1 })
    .limit(MEDIA_FLUSH_BATCH)
    .lean()) as unknown as StorageRef[];

  for (const doc of expired) {
    try {
      await storage.delete(doc.storage.key);
      await FileDocModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            expired: true,
            purgeAt: new Date(Date.now() + MEDIA_PURGE_AFTER_MS),
          },
        },
      );
      deleted++;
    } catch (err) {
      failed++;
      logger.warn(
        { err, fileId: String(doc._id) },
        "flush expired media failed",
      );
    }
  }

  // Lapis 3 (§10.2): metadata media boleh dibersihkan 7 hari setelah
  // expired. TTL index pada purgeAt juga menghapus; deleteMany eksplisit
  // memberi jumlah yang teramati. File non-media tidak punya purgeAt →
  // tidak pernah terkena.
  const purgeDel = await FileDocModel.deleteMany({
    origin: "generated",
    purgeAt: { $ne: null, $lte: now },
  });

  if (deleted > 0 || failed > 0 || (purgeDel.deletedCount ?? 0) > 0) {
    logger.info(
      {
        deleted,
        failed,
        purged: purgeDel.deletedCount ?? 0,
      },
      "cleanup: media flush done",
    );
  }

  return { deleted, failed };
}

async function runOnce(): Promise<void> {
  try {
    await cleanTmp();
  } catch (err) {
    logger.warn({ err }, "cleanTmp failed");
  }
  try {
    await cleanStaleFiles();
  } catch (err) {
    logger.warn({ err }, "cleanStaleFiles failed");
  }
  try {
    await cleanOrphanUploads();
  } catch (err) {
    logger.warn({ err }, "cleanOrphanUploads failed");
  }
  try {
    await cleanOrphans();
  } catch (err) {
    logger.warn({ err }, "cleanOrphans failed");
  }
  try {
    await flushExpiredMedia();
  } catch (err) {
    logger.warn({ err }, "flushExpiredMedia failed");
  }
}

export function startCleanup(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runOnce();
  }, INTERVAL_MS);
  timer.unref();
  logger.info({ intervalMs: INTERVAL_MS }, "cleanup job started");
}

export function stopCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("cleanup job stopped");
  }
}
