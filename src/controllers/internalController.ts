// src/controllers/internalController.ts
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "../middleware/error.js";
import { env } from "../config/env.js";
import { flushExpiredMedia } from "../services/jobs/cleanup.js";

/**
 * POST /internal/cron/flush-assets (§7.6)
 * Trigger eksternal untuk flush media 24 jam. Auth: Authorization: Bearer
 * $CRON_SECRET (timing-safe). CRON_SECRET tidak diset → selalu 401.
 * Respons: `{ deleted, failed }`.
 */
export async function flushAssetsCron(
  req: Request,
  res: Response,
): Promise<void> {
  const secret = env.CRON_SECRET;
  const header = req.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (
    secret === undefined ||
    provided.length !== secret.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
  ) {
    throw new AppError("UNAUTHORIZED", 401, "Invalid cron secret");
  }

  const result = await flushExpiredMedia();
  res.json(result);
}
