// src/services/kofi.service.ts
import crypto from "node:crypto";
import type { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { UserModel } from "../models/User.js";
import { DonationEventModel } from "../models/DonationEvent.js";
import { CreditLedgerModel } from "../models/CreditLedger.js";
import { AppError } from "../middleware/error.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const DONATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DONATION_CODE_REGEX = /RC-[A-HJ-NP-Z2-9]{6}/i;

export interface KofiPayload {
  verification_token?: unknown;
  message_id?: unknown;
  timestamp?: unknown;
  type?: unknown;
  message?: unknown;
  amount?: unknown;
  currency?: unknown;
  email?: unknown;
  kofi_transaction_id?: unknown;
}

export interface KofiDonationInput {
  messageId: string;
  type: string;
  amount: string;
  currency: string;
  email?: string;
  messageText?: string;
  kofiTransactionId: string;
  receivedAt: Date;
}

export interface KofiProcessResult {
  status: "credited" | "unclaimed" | "ignored" | "review" | "duplicate";
  userId?: string;
}

function hashEmail(email: string): string {
  return crypto
    .createHash("sha256")
    .update(email.toLowerCase().trim())
    .digest("hex");
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateDonationCode(): string {
  let code = "RC-";
  for (let i = 0; i < 6; i += 1) {
    const idx = crypto.randomInt(0, DONATION_CODE_ALPHABET.length);
    code += DONATION_CODE_ALPHABET[idx];
  }
  return code;
}

/**
 * Get or lazily create a donation code for the user (§9.2).
 * Uses unique sparse index on User.donationCode; retries on collision.
 */
export async function getOrCreateDonationCode(
  userId: Types.ObjectId,
): Promise<string> {
  const initial = await UserModel.findById(userId)
    .select({ donationCode: 1 })
    .lean();
  if (!initial) throw AppError.notFound();
  if (initial.donationCode) return initial.donationCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateDonationCode();
    try {
      const updated = await UserModel.findOneAndUpdate(
        { _id: userId, donationCode: null },
        { $set: { donationCode: code } },
        { new: true },
      ).lean();
      if (updated?.donationCode) return updated.donationCode;

      // No update happened: user already has a code (concurrent writer).
      const recheck = await UserModel.findById(userId)
        .select({ donationCode: 1 })
        .lean();
      if (!recheck) throw AppError.notFound();
      if (recheck.donationCode) return recheck.donationCode;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // Either duplicate code collision or concurrent user update.
        const recheck = await UserModel.findById(userId)
          .select({ donationCode: 1 })
          .lean();
        if (recheck?.donationCode) return recheck.donationCode;
        continue;
      }
      throw err;
    }
  }
  throw new AppError("INTERNAL", 500, "Gagal membuat kode donasi");
}

/**
 * Core processing of a Ko-fi donation event (§9.1 langkah 3-9).
 * Expected non-error outcomes (ignored/unclaimed/review/duplicate) are
 * returned, not thrown. Real errors bubble up.
 */
async function processKofiDonation(
  input: KofiDonationInput,
): Promise<KofiProcessResult> {
  // Only Donation and Subscription (§9.1 langkah 3). Shop Order/Commission
  // tidak di-credit; dicatat sebagai ignored bila user ingin audit.
  if (input.type !== "Donation" && input.type !== "Subscription") {
    return { status: "ignored" };
  }

  const amount = Number.parseFloat(input.amount);
  const currency = input.currency.toUpperCase();
  const emailHash = input.email ? hashEmail(input.email) : "";
  const parsedCodeMatch = input.messageText
    ? input.messageText.match(DONATION_CODE_REGEX)
    : null;
  const parsedCode = parsedCodeMatch
    ? parsedCodeMatch[0].toUpperCase()
    : undefined;

  // Determine status and credits (§3, §9.1 langkah 7).
  let status: "credited" | "unclaimed" | "ignored" | "review" = "unclaimed";
  let delta = { imageFlux3: 0, videoCosmos: 0 };
  let matchedUserId: Types.ObjectId | undefined;

  if (!Number.isFinite(amount) || amount <= 0) {
    status = "ignored";
  } else {
    const min = env.DONATION_MIN_BY_CURRENCY[currency];
    if (min === undefined) {
      status = "review";
    } else if (amount < min) {
      status = "ignored";
    } else {
      let units = 1;
      if (env.DONATION_STACK_BY_AMOUNT) {
        const computed = Math.floor(amount / min);
        units = computed >= 1 ? computed : 1;
      }
      delta = {
        imageFlux3: env.CREDITS_IMAGE_PER_DONATION * units,
        videoCosmos: env.CREDITS_VIDEO_PER_DONATION * units,
      };

      // Match user (§9.1 langkah 8): code in message → email hash.
      if (parsedCode) {
        const byCode = await UserModel.findOne({ donationCode: parsedCode })
          .select({ _id: 1 })
          .lean();
        if (byCode) matchedUserId = byCode._id;
      }
      if (!matchedUserId && input.email) {
        const emailNormalized = input.email.toLowerCase().trim();
        const byEmail = await UserModel.findOne({ email: emailNormalized })
          .select({ _id: 1 })
          .lean();
        if (byEmail) matchedUserId = byEmail._id;
      }

      status = matchedUserId ? "credited" : "unclaimed";
    }
  }

  // Insert event + grant credits in one transaction (§9.1 langkah 9).
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const [eventDoc] = await DonationEventModel.create(
        [
          {
            messageId: input.messageId,
            kofiTransactionId: input.kofiTransactionId,
            type: input.type,
            amount: Number.isFinite(amount) ? amount : 0,
            currency,
            status,
            creditsGranted: matchedUserId
              ? delta
              : { imageFlux3: 0, videoCosmos: 0 },
            receivedAt: input.receivedAt,
            ...(emailHash ? { emailHash } : {}),
            ...(parsedCode ? { parsedCode } : {}),
            ...(matchedUserId ? { userId: matchedUserId } : {}),
          },
        ],
        { session },
      );

      if (!matchedUserId || !eventDoc) return;

      await UserModel.updateOne(
        { _id: matchedUserId },
        {
          $inc: {
            "credits.imageFlux3": delta.imageFlux3,
            "credits.videoCosmos": delta.videoCosmos,
          },
        },
        { session },
      );
      // Set donorSince hanya bila belum ada (§6.1).
      await UserModel.updateOne(
        { _id: matchedUserId, donorSince: { $exists: false } },
        { $set: { donorSince: new Date() } },
        { session },
      );
      await CreditLedgerModel.create(
        [
          {
            userId: matchedUserId,
            delta,
            reason: "donation",
            refType: "donation",
            refId: eventDoc._id.toString(),
          },
        ],
        { session },
      );
    });
    return {
      status,
      ...(matchedUserId ? { userId: matchedUserId.toString() } : {}),
    };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return { status: "duplicate" };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Claim an existing unclaimed donation (§7.3). Both emailHash and
 * kofiTransactionId must match. Transaction: grant credits + flip status.
 */
export async function claimDonation(
  userId: Types.ObjectId,
  email: string,
  kofiTransactionId: string,
): Promise<{
  status: "credited";
  creditsGranted: { imageFlux3: number; videoCosmos: number };
}> {
  const emailHash = hashEmail(email);
  const eventDoc = await DonationEventModel.findOne({
    emailHash,
    kofiTransactionId,
    status: "unclaimed",
  }).lean();
  if (!eventDoc) throw AppError.claimNotFound();

  const min = env.DONATION_MIN_BY_CURRENCY[eventDoc.currency];
  if (min === undefined) throw AppError.claimNotFound();

  let units = 1;
  if (env.DONATION_STACK_BY_AMOUNT) {
    const computed = Math.floor(eventDoc.amount / min);
    units = computed >= 1 ? computed : 1;
  }
  const delta = {
    imageFlux3: env.CREDITS_IMAGE_PER_DONATION * units,
    videoCosmos: env.CREDITS_VIDEO_PER_DONATION * units,
  };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const claimed = await DonationEventModel.findOneAndUpdate(
        { _id: eventDoc._id, status: "unclaimed" },
        { $set: { status: "credited", userId, creditsGranted: delta } },
        { session, new: true },
      );
      if (!claimed) throw AppError.claimNotFound();

      await UserModel.updateOne(
        { _id: userId },
        {
          $inc: {
            "credits.imageFlux3": delta.imageFlux3,
            "credits.videoCosmos": delta.videoCosmos,
          },
        },
        { session },
      );
      await UserModel.updateOne(
        { _id: userId, donorSince: { $exists: false } },
        { $set: { donorSince: new Date() } },
        { session },
      );
      await CreditLedgerModel.create(
        [
          {
            userId,
            delta,
            reason: "claim",
            refType: "donation",
            refId: eventDoc._id.toString(),
          },
        ],
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  return { status: "credited", creditsGranted: delta };
}

/**
 * Express handler for POST /api/webhooks/kofi (§7.1). Mounted BEFORE /api
 * (no globalLimiter, no requireAuth). Only this route parses urlencoded.
 */
export async function handleKofiWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const raw = (req.body as { data?: unknown } | undefined)?.data;
  if (typeof raw !== "string" || raw.length === 0) {
    res.status(400).json({ ok: false, error: "Invalid body" });
    return;
  }

  let payload: KofiPayload;
  try {
    payload = JSON.parse(raw) as KofiPayload;
  } catch {
    res.status(400).json({ ok: false, error: "Invalid JSON in data" });
    return;
  }

  const expectedToken = env.KOFI_VERIFICATION_TOKEN;
  if (!expectedToken) {
    res.status(401).json({ ok: false, error: "Webhook not configured" });
    return;
  }
  if (
    typeof payload.verification_token !== "string" ||
    !safeCompare(payload.verification_token, expectedToken)
  ) {
    res.status(401).json({ ok: false, error: "Invalid token" });
    return;
  }

  if (typeof payload.message_id !== "string" || payload.message_id === "") {
    res.status(400).json({ ok: false, error: "Missing message_id" });
    return;
  }
  if (typeof payload.type !== "string" || payload.type === "") {
    res.status(400).json({ ok: false, error: "Missing type" });
    return;
  }

  const timestampStr = String(payload.timestamp ?? "");
  const parsedTs = new Date(timestampStr);
  const receivedAt = Number.isNaN(parsedTs.getTime()) ? new Date() : parsedTs;

  const input: KofiDonationInput = {
    messageId: payload.message_id,
    type: payload.type,
    amount: String(payload.amount ?? ""),
    currency: String(payload.currency ?? ""),
    ...(typeof payload.email === "string" && payload.email !== ""
      ? { email: payload.email }
      : {}),
    ...(typeof payload.message === "string" && payload.message !== ""
      ? { messageText: payload.message }
      : {}),
    kofiTransactionId: String(payload.kofi_transaction_id ?? ""),
    receivedAt,
  };

  try {
    const result = await processKofiDonation(input);
    logger.info(
      {
        status: result.status,
        messageId: input.messageId,
        type: input.type,
        currency: input.currency.toUpperCase(),
        amount: Number.parseFloat(input.amount) || 0,
        ...(result.userId !== undefined
          ? { matchedUserId: result.userId }
          : {}),
      },
      "kofi webhook processed",
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, messageId: input.messageId }, "kofi webhook failed");
    res.status(500).json({ ok: false, error: "Internal error" });
  }
}
