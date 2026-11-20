// src/controllers/filesController.ts
import type { Request, Response } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { fileTypeFromBuffer } from "file-type";
import { FileDocModel } from "../models/FileDoc.js";
import { SessionModel } from "../models/Session.js";
import { ChunkModel } from "../models/Chunk.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { parseObjectIdParam as parseFileId } from "../utils/params.js";
import { getStorage, pickPrefix } from "../storage/index.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { enqueueIngestion } from "../services/ingest/index.js";

const PRESIGN_TTL_SEC = 600;
const MAGIC_BYTES_LEN = 4100;
const MAX_CONTENT_PREVIEW_BYTES = 200 * 1024;

const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "yaml",
  "yml",
  "html",
  "htm",
  "xml",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "sh",
  "sql",
  "log",
  "ini",
  "env",
  "toml",
]);

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
]);

const VIDEO_EXTS = new Set([
  "mp4",
  "m4v",
  "mov",
  "qt",
  "mkv",
  "webm",
  "avi",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "mpe",
  "m2v",
  "mpv",
  "vob",
  "ogv",
  "3gp",
  "3g2",
  "mts",
  "m2ts",
  "mxf",
  "f4v",
  "asf",
  "y4m",
  "h264",
  "h265",
  "hevc",
]);

const ZIP_OFFICE_MIMES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const RASTER_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/tiff",
]);

function isTextish(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIMES.has(mime)) return true;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}

function ext(name: string): string {
  return /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
}

function videoError(): AppError {
  return new AppError(
    "UNSUPPORTED_MIME",
    415,
    "Video uploads are not supported",
  );
}

function basicMimeCheck(name: string, mime: string): void {
  const suffix = ext(name);
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";

  if (VIDEO_EXTS.has(suffix)) throw videoError();

  // .ts juga dipakai untuk MPEG transport stream. Putuskan saat complete.
  if (type.startsWith("video/") && suffix !== "ts") throw videoError();
}

function looksLikeText(bytes: Uint8Array, partial: boolean): boolean {
  // Izinkan tab, newline, carriage return, dan form feed.
  if (bytes.some((b) => b < 32 && ![9, 10, 12, 13].includes(b))) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: partial,
    });
    return true;
  } catch {
    return false;
  }
}

async function classifyUpload(bytes: Uint8Array, name: string, size: number) {
  const suffix = ext(name);
  const binary = { mime: "application/octet-stream", ingest: false };
  const text = looksLikeText(bytes, bytes.length < size);

  // Cek juga transport stream jika MIME browser kosong atau salah.
  for (const [offset, stride] of [
    [0, 188],
    [4, 192],
    [0, 204],
  ] as const) {
    if (
      bytes[offset] === 0x47 &&
      bytes[offset + stride] === 0x47 &&
      bytes[offset + 2 * stride] === 0x47 &&
      !text
    ) {
      throw videoError();
    }
  }

  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(bytes);
  } catch (err) {
    // Beberapa format butuh byte lebih banyak daripada sampel header.
    logger.debug({ err, name }, "upload signature could not be identified");
  }

  const mime = detected?.mime;
  if (mime?.startsWith("video/") || mime === "application/mxf") {
    throw videoError();
  }
  if (suffix === "ts" && !text) throw videoError();

  if (mime === "application/pdf" || (mime && RASTER_MIMES.has(mime))) {
    return { mime, ingest: true };
  }

  const zip =
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;

  const officeMime = Object.hasOwn(ZIP_OFFICE_MIMES, suffix)
    ? ZIP_OFFICE_MIMES[suffix]
    : undefined;

  if (zip && officeMime) return { mime: officeMime, ingest: true };

  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every(
    (value, index) => bytes[index] === value,
  );

  if (ole && suffix === "xls") {
    return { mime: "application/vnd.ms-excel", ingest: true };
  }
  if (ole && suffix === "ppt") {
    return { mime: "application/vnd.ms-powerpoint", ingest: true };
  }

  if (
    text &&
    (!mime ||
      mime.startsWith("text/") ||
      isTextish(mime, "") ||
      mime === "application/rtf" ||
      mime === "image/svg+xml")
  ) {
    if (suffix === "json") return { mime: "application/json", ingest: true };
    if (suffix === "csv") return { mime: "text/csv", ingest: true };
    if (suffix === "md" || suffix === "markdown") {
      return { mime: "text/markdown", ingest: true };
    }
    return { mime: "text/plain", ingest: true };
  }

  return binary;
}

/** Media generated yang sudah lewat expiresAt atau sudah di-flush (§6.4). */
function assertNotExpired(doc: { expired?: boolean; expiresAt?: Date }): void {
  if (doc.expired === true) {
    throw new AppError("ASSET_EXPIRED", 410, "Media sudah kedaluwarsa");
  }
  if (doc.expiresAt !== undefined && doc.expiresAt.getTime() <= Date.now()) {
    throw new AppError("ASSET_EXPIRED", 410, "Media sudah kedaluwarsa");
  }
}

const PresignBody = z.object({
  sessionId: z.string().refine((v) => Types.ObjectId.isValid(v), {
    message: "Invalid sessionId",
  }),
  name: z.string().min(1).max(200).trim(),
  mime: z.string().min(1).max(120).trim(),
  size: z.number().int().positive(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export async function presignUpload(
  req: Request,
  res: Response,
): Promise<void> {
  const body = PresignBody.parse(req.body);
  const userId = getUserId(res);

  const session = await SessionModel.findOne({
    _id: body.sessionId,
    userId,
  }).lean();
  if (!session) throw AppError.notFound("Session not found");

  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (body.size > maxBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      413,
      `Max ${env.MAX_UPLOAD_MB} MB per file`,
    );
  }

  basicMimeCheck(body.name, body.mime);

  const prefix = pickPrefix(body.mime);
  const storage = getStorage();
  const presigned = await storage.presignPut(prefix, body.name, {
    mime: body.mime,
    expiresInSec: PRESIGN_TTL_SEC,
  });

  const doc = await FileDocModel.create({
    userId,
    sessionId: session._id,
    origin: "upload",
    name: body.name,
    mime: body.mime,
    size: body.size,
    sha256: body.sha256 ?? "",
    version: 1,
    parentFileId: null,
    storage: { driver: "r2", key: presigned.key },
    status: "pending",
    indexStatus: env.EMBEDDING_ENABLED ? "pending" : "disabled",
  });

  res.status(201).json({
    fileId: doc._id.toString(),
    key: presigned.key,
    uploadUrl: presigned.url,
    expiresAt: presigned.expiresAt,
    requiredHeaders: { "Content-Type": body.mime },
  });
}

export async function completeUpload(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseFileId(req.params.id);
  const userId = getUserId(res);

  const doc = await FileDocModel.findOne({ _id: id, userId });
  if (!doc) throw AppError.notFound();
  if (doc.status !== "pending") {
    throw AppError.conflict(`File is not pending (status: ${doc.status})`);
  }

  const storage = getStorage();
  const markFailed = async (msg: string): Promise<void> => {
    doc.status = "failed";
    doc.error = msg;
    await doc.save();
  };

  const head = await storage.head(doc.storage.key);
  if (!head) {
    await markFailed("Object not found in storage");
    throw new AppError(
      "UPLOAD_MISSING",
      404,
      "Uploaded object not found in storage",
    );
  }

  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  let actualSize = head.size;

  if (actualSize === 0 && doc.size > 0) {
    // Periksa isi objek sebelum menolak upload berdasarkan stat() yang nol.
    const stream = await storage.getStream(doc.storage.key);
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        actualSize += value.byteLength;
        if (actualSize > maxBytes) {
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    logger.warn(
      {
        fileId: id,
        declaredSize: doc.size,
        statSize: head.size,
        bytesRead: actualSize,
      },
      "checked upload contents after storage reported zero bytes",
    );
  }

  if (actualSize > maxBytes) {
    await storage.delete(doc.storage.key).catch(() => {});
    await markFailed(`Actual size exceeds ${maxBytes} bytes`);
    throw new AppError("PAYLOAD_TOO_LARGE", 413, "Actual size exceeds limit");
  }

  if (actualSize !== doc.size) {
    const message = `Size mismatch: declared ${doc.size}, actual ${actualSize}`;
    await storage.delete(doc.storage.key).catch(() => {});
    await markFailed(message);
    throw new AppError("SIZE_MISMATCH", 415, message);
  }

  if (head.size !== doc.size) {
    await storage.delete(doc.storage.key).catch(() => {});
    await markFailed(
      `Size mismatch: declared ${doc.size}, actual ${head.size}`,
    );
    throw new AppError(
      "SIZE_MISMATCH",
      415,
      `Size mismatch: declared ${doc.size}, actual ${head.size}`,
    );
  }

  let classification: Awaited<ReturnType<typeof classifyUpload>>;

  try {
    basicMimeCheck(doc.name, doc.mime);
    const bytes = await storage.readBytes(doc.storage.key, MAGIC_BYTES_LEN);
    classification = await classifyUpload(bytes, doc.name, actualSize);
  } catch (err) {
    if (err instanceof AppError) {
      await markFailed(err.message);
      await storage.delete(doc.storage.key).catch(() => {});
      throw err;
    }

    logger.error({ err, fileId: id }, "upload verification failed");
    await markFailed("Verification error");
    throw new AppError("VERIFY_FAILED", 500, "File verification failed");
  }

  doc.mime = classification.mime;
  doc.status = classification.ingest ? "processing" : "ready";
  doc.error = undefined;
  doc.indexStatus =
    classification.ingest && env.EMBEDDING_ENABLED ? "pending" : "disabled";
  await doc.save();

  if (classification.ingest) {
    enqueueIngestion(doc._id.toString());
  }

  res.json({
    id: doc._id.toString(),
    name: doc.name,
    mime: doc.mime,
    size: doc.size,
    status: doc.status,
    indexStatus: doc.indexStatus ?? null,
  });
}

export async function getFileMeta(req: Request, res: Response): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();

  res.json({
    id: doc._id.toString(),
    name: doc.name,
    mime: doc.mime,
    size: doc.size,
    version: doc.version,
    origin: doc.origin,
    status: doc.status,
    indexStatus: doc.indexStatus ?? null,
    error: doc.error ?? null,
    extract: doc.extract ?? null,
    summaryLine: doc.summaryLine ?? null,
    createdAt: doc.createdAt.toISOString(),
  });
}

function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
}

export async function downloadFile(req: Request, res: Response): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();
  assertNotExpired(doc);
  if (doc.status === "pending") {
    throw new AppError("UPLOAD_INCOMPLETE", 425, "File not uploaded yet");
  }

  const storage = getStorage();
  const stream = await storage.getStream(doc.storage.key);

  const encoded = encodeURIComponent(doc.name);
  const ascii = asciiFallback(doc.name);

  res.setHeader("Content-Type", doc.mime);
  res.setHeader("Content-Length", doc.size.toString());
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  );

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((r) => res.once("drain", () => r()));
      }
    }
    res.end();
  } catch (err) {
    logger.error({ err, fileId: doc._id.toString() }, "download stream error");
    if (!res.writableEnded) res.end();
  }
}

/**
 * Presigned URL GET untuk <img>/<video> FE (§7.4). Alasan bukan /download:
 * cookie lintas origin bermasalah dan seek video butuh range request.
 * Kepemilikan dicek; key R2 tidak pernah dikirim ke FE.
 */
export async function getFileUrl(req: Request, res: Response): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();
  assertNotExpired(doc);
  if (doc.status === "pending") {
    throw new AppError("UPLOAD_INCOMPLETE", 425, "File not uploaded yet");
  }

  const storage = getStorage();

  if (
    doc.origin === "upload" &&
    (doc.status === "failed" || !RASTER_MIMES.has(doc.mime))
  ) {
    throw new AppError("UNSUPPORTED_MIME", 415, "Use the download endpoint");
  }

  const url = await storage.presignGet(doc.storage.key, {
    expiresInSec: env.ASSET_URL_TTL_SECONDS,
  });

  res.json({
    url,
    mime: doc.mime,
    expiresAt: doc.expiresAt !== undefined ? doc.expiresAt.toISOString() : null,
    width: doc.mediaMeta?.width ?? null,
    height: doc.mediaMeta?.height ?? null,
    durationSec: doc.mediaMeta?.durationSec ?? null,
  });
}

export async function getFileContent(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();
  if (doc.status === "pending") {
    throw new AppError("UPLOAD_INCOMPLETE", 425, "File not uploaded yet");
  }

  assertNotExpired(doc);

  if (!isTextish(doc.mime, doc.name)) {
    throw new AppError("NOT_TEXT", 415, "File is binary; use /download");
  }

  if (doc.size === 0) {
    res.json({ text: "", truncated: false, size: 0 });
    return;
  }

  const storage = getStorage();
  const bytes = await storage.readBytes(
    doc.storage.key,
    MAX_CONTENT_PREVIEW_BYTES,
  );
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const truncated = doc.size > MAX_CONTENT_PREVIEW_BYTES;

  res.json({ text, truncated, size: doc.size });
}

/**
 * Hapus file beserta seluruh chunk-nya. Urutan:
 *   1. Hapus FileDoc dulu → memicu existence check di ingestion abort.
 *   2. Hapus chunks → search_attachment tidak bisa menemukan kontennya.
 *   3. Best-effort hapus objek R2.
 * Idempotent: pemanggilan ulang mengembalikan 404 (safe).
 */
export async function deleteFile(req: Request, res: Response): Promise<void> {
  const id = parseFileId(req.params.id);
  const doc = await FileDocModel.findOne({
    _id: id,
    userId: getUserId(res),
  }).lean();
  if (!doc) throw AppError.notFound();

  await FileDocModel.deleteOne({ _id: doc._id });
  await ChunkModel.deleteMany({ fileId: doc._id });

  try {
    await getStorage().delete(doc.storage.key);
  } catch (err) {
    logger.warn(
      { err, key: doc.storage.key, fileId: doc._id.toString() },
      "r2 delete failed; file doc + chunks already removed",
    );
  }

  res.status(204).end();
}
