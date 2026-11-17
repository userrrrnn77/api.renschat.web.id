// src/routes/me.ts

import { Router } from "express";
import { getEntitlements } from "../controllers/entitlementsController.js";
import { postClaimDonation } from "../controllers/donationsController.js";
import {
  getPreferences,
  updatePreferences,
} from "../controllers/preferencesController.js";
import { claimDonationLimiter } from "../middleware/rateLimit.js";

export const meRouter = Router();

meRouter.get("/entitlements", getEntitlements);
meRouter.post("/donations/claim", claimDonationLimiter, postClaimDonation);
meRouter.get("/preferences", getPreferences);
meRouter.put("/preferences", updatePreferences);
