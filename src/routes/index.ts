// src/routes/index.ts

import { Router } from "express";
import { healthRouter } from "./health.js";
import { authRouter } from "./auth.js";
import { sessionsRouter } from "./sessions.js";
import { filesRouter } from "./files.js";
import { meRouter } from "./me.js";
import { jobsRouter } from "./jobs.js";
import { requireAuth } from "../middleware/auth.js";
import { globalLimiter } from "../middleware/rateLimit.js";

const router = Router();

router.use(globalLimiter);
router.use("/health", healthRouter);
router.use("/auth", authRouter);
router.use("/sessions", requireAuth, sessionsRouter);
router.use("/files", requireAuth, filesRouter);
router.use("/me", requireAuth, meRouter);
router.use("/jobs", requireAuth, jobsRouter);

export default router;
