// src/routes/sessions.ts

import { Router } from "express";
import {
  listSessions,
  createSession,
  getSession,
  patchSession,
  deleteSession,
} from "../controllers/sessionsController.js";
import {
  postMessage,
  regenerateMessage,
  respondClarification,
} from "../controllers/messagesController.js";
import { messageLimiter } from "../middleware/rateLimit.js"; // Module '"../middleware/rateLimit.js"' has no exported member 'messageLimiter'.

export const sessionsRouter = Router();

sessionsRouter.get("/", listSessions);
sessionsRouter.post("/", createSession);
sessionsRouter.get("/:id", getSession);
sessionsRouter.patch("/:id", patchSession);
sessionsRouter.delete("/:id", deleteSession);
sessionsRouter.post("/:id/messages", messageLimiter, postMessage);
sessionsRouter.post(
  "/:id/messages/:msgId/regenerate",
  messageLimiter,
  regenerateMessage,
);
sessionsRouter.post("/:id/respond", messageLimiter, respondClarification);
