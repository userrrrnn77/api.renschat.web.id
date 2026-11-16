// src/routes/jobs.ts

import { Router } from "express";
import type { Request, Response } from "express";
import { GenerationJobModel } from "../models/GenerationJob.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { parseObjectIdParam } from "../utils/params.js";

export const jobsRouter = Router();

/**
 * GET /api/jobs/:id (§7.5). Auth + kepemilikan. Bentuk response mengikuti
 * kontrak: `{ id, status, engine, kind, fileId, error, queuedAt, startedAt,
 * finishedAt }`. Dipakai FE untuk polling job `running` saat render ulang
 * (§14.3: tiap 3 dtk).
 */
jobsRouter.get("/:id", async (req: Request, res: Response) => {
  const id = parseObjectIdParam(req.params.id);
  const userId = getUserId(res);

  const job = await GenerationJobModel.findOne({ _id: id, userId }).lean();
  if (!job) throw AppError.notFound();

  res.json({
    id: String(job._id),
    status: job.status,
    engine: job.engine,
    kind: job.kind,
    fileId: job.fileId ? String(job.fileId) : null,
    error: job.error ?? null,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  });
});
