// src/controllers/entitlementsController.ts
import type { Request, Response } from "express";
import { getUserId } from "../middleware/auth.js";
import { buildEntitlementsPayload } from "../services/entitlements.service.js";

/** GET /api/me/entitlements (§7.2). requireAuth sudah di route. */
export async function getEntitlements(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getUserId(res);
  const payload = await buildEntitlementsPayload(userId);
  res.json(payload);
}
