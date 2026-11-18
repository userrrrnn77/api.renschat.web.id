// src/controllers/usageController.ts
import type { Request, Response } from "express";
import { getUserId } from "../middleware/auth.js";
import { buildUsageReport } from "../services/usage.service.js";

/** GET /api/me/usage (Phase 6). requireAuth sudah di route. */
export async function getUsage(_req: Request, res: Response): Promise<void> {
  const userId = getUserId(res);
  const report = await buildUsageReport(userId);
  res.json(report);
}
