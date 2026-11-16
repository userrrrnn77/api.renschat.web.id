// src/routes/internal.ts

import { Router } from "express";
import { flushAssetsCron } from "../controllers/internalController.js";

export const internalRouter = Router();

// Di-mount di app.ts di luar /api → tidak kena globalLimiter dan
// tidak pakai requireAuth; auth dilakukan lewat CRON_SECRET di controller.
internalRouter.post("/cron/flush-assets", flushAssetsCron);
