// src/controllers/donationsController.ts
import type { Request, Response } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { claimDonation } from "../services/kofi.service.js";

const ClaimBody = z.object({
  email: z.string().trim().toLowerCase().min(3).max(320),
  kofiTransactionId: z.string().trim().min(1).max(200),
});

/** POST /api/me/donations/claim (§7.3). requireAuth sudah di route. */
export async function postClaimDonation(
  req: Request,
  res: Response,
): Promise<void> {
  const body = ClaimBody.parse(req.body);
  const userId = getUserId(res);
  const result = await claimDonation(
    userId,
    body.email,
    body.kofiTransactionId,
  );
  res.json(result);
}
