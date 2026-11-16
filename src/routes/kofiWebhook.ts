// src/routes/kofiWebhook.ts
import { Router, urlencoded } from "express";
import { handleKofiWebhook } from "../services/kofi.service.js";

export const kofiWebhookRouter = Router();

kofiWebhookRouter.post(
  "/kofi",
  urlencoded({ extended: false, limit: "1mb" }),
  handleKofiWebhook,
);
