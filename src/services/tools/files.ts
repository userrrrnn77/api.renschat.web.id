// src/services/tools/files.ts

import { z } from "zod";
import { FileDocModel } from "../../models/FileDoc.js";
import { registerTool, okResult, errorResult } from "./registry.js";
import { saveGenerated, previewForMime, guessMime } from "./saveGenerated.js";
import {
  FILE_ICONS,
  normalizeFileAppearance,
} from "../blocks/fileAppearance.js";

const MAX_GENERATED_FILE_BYTES = 10 * 1024 * 1024;

// ─── create_file ──────────────────────────────────────────────────────────

const CreateFileSchema = z.object({
  name: z.string().min(1).max(200),
  content: z.string(),
  mime: z.string().optional(),
  present: z.boolean().optional(),
  appearance: z
    .unknown()
    .optional()
    .describe(
      `Optional object for the file card: {icon, accent}. ` +
        `Choose icon from: ${FILE_ICONS.join(", ")}. ` +
        `Choose a related six-digit hex color such as #3178C6. ` +
        `Examples: package.json → package, turbo.json → gauge, schema.prisma → pyramid. ` +
        `Do not mention this object in your reply.`,
    ),
});

registerTool({
  name: "create_file",
  kind: "file",
  description:
    "Buat atau perbarui file di sesi ini. Jika nama file sudah ada, otomatis jadi versi baru. Set present=false jika tidak perlu tampilkan kartu.",
  schema: CreateFileSchema,
  async run(args, ctx) {
    const a = CreateFileSchema.parse(args);

    // Tolak kalau model ngasal masukin ObjectId (24 char hex) sebagai nama file
    if (/^[a-f0-9]{24}$/i.test(a.name)) {
      return errorResult(
        "INVALID_NAME",
        "File name cannot be a hex ID. Provide a descriptive name with an extension.",
      );
    }

    const mime = a.mime ?? guessMime(a.name);
    const buf = Buffer.from(a.content, "utf-8");

    if (buf.length > MAX_GENERATED_FILE_BYTES) {
      return errorResult("FILE_TOO_LARGE", "File exceeds 10MB");
    }

    const appearance = normalizeFileAppearance(a.appearance);

    const saved = await saveGenerated({
      ...(appearance ? { appearance } : {}),
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      name: a.name,
      mime,
      buf,
    });

    const present = a.present !== false;
    if (present) {
      ctx.emitBlock({
        type: "file",
        fileId: saved._id.toString(),
        name: saved.name,
        mime: saved.mime,
        size: saved.size,
        version: saved.version,
        preview: previewForMime(saved.mime, saved.name),
        ...(appearance ? { appearance } : {}),
      });
    }

    return okResult({
      fileId: saved._id.toString(),
      name: saved.name,
      version: saved.version,
      size: saved.size,
      presented: present,
    });
  },
});

// ─── present_files ─────────────────────────────────────────────────────────

const PresentFilesSchema = z.object({
  fileIds: z.array(z.string().min(1).max(128)).min(1).max(10),
  note: z.string().optional(),
});

registerTool({
  name: "present_files",
  kind: "file",
  description:
    "Tampilkan file yang sudah ada di sesi ini sesuai urutan fileIds. " +
    "create_file sudah menampilkan kartu secara default. Untuk menyajikan beberapa " +
    "file sekaligus, buat masing-masing dengan present=false lalu panggil tool ini sekali.",
  schema: PresentFilesSchema,

  async run(args, ctx) {
    const { fileIds, note } = PresentFilesSchema.parse(args);

    const requestedIds = [
      ...new Set(fileIds.map((id) => id.trim().toLowerCase())),
    ];
    const validIds = requestedIds.filter((id) => /^[a-f0-9]{24}$/.test(id));

    if (validIds.length === 0) {
      return errorResult("INVALID_IDS", "No valid file IDs provided", {
        unavailableIds: requestedIds,
      });
    }

    const docs = await FileDocModel.find({
      _id: { $in: validIds },
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      status: "ready",
      expired: { $ne: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    })
      .select("_id name mime size version appearance")
      .lean();

    const byId = new Map(docs.map((doc) => [doc._id.toString(), doc] as const));
    const presentedIds: string[] = [];
    const unavailableIds: string[] = [];

    for (const id of requestedIds) {
      const doc = byId.get(id);

      if (!doc) {
        unavailableIds.push(id);
        continue;
      }

      const appearance = normalizeFileAppearance(doc.appearance);

      ctx.emitBlock({
        type: "file",
        fileId: id,
        name: doc.name,
        mime: doc.mime,
        size: doc.size,
        version: doc.version,
        preview: previewForMime(doc.mime, doc.name),
        ...(appearance ? { appearance } : {}),
        ...(note !== undefined ? { note } : {}),
      });

      presentedIds.push(id);
    }

    if (presentedIds.length === 0) {
      return errorResult("NOT_FOUND", "No requested files are available", {
        unavailableIds,
      });
    }

    return okResult({
      presented: presentedIds.length,
      presentedIds,
      unavailableIds,
    });
  },
});
