// src/services/entitlements.service.ts
import { Types } from "mongoose";
import { UserModel } from "../models/User.js";
import { AppError } from "../middleware/error.js";
import { env } from "../config/env.js";
import {
  effectiveDailyLimit,
  getDailyCount,
} from "./generation/budget.service.js";

/** Bentuk minimum user yang dibutuhkan pengecekan entitlement (§6.1). */

export interface EntitlementUser {
  credits?: {
    imageFlux3?: number | null;
    videoCosmos?: number | null;
  } | null;
  donorSince?: Date | null;
  donationCode?: string | null;
  createdAt?: Date | null;
}

/** Donatur = pernah mendapat kredit donasi (donorSince terisi). */
export function isDonor(user: EntitlementUser): boolean {
  if (user.donorSince != null) return true;
  return (
    (user.credits?.imageFlux3 ?? 0) > 0 || (user.credits?.videoCosmos ?? 0) > 0
  );
}

/**
 * Akses flux-3 (§8.1): non-donatur → ENTITLEMENT_REQUIRED; donatur dengan
 * kredit 0 → INSUFFICIENT_CREDITS. Dipanggil di resolveGenerationPlan dan
 * sekali lagi di runImageGeneration (defense in depth).
 */
export function assertFlux3Allowed(user: EntitlementUser): void {
  if (!isDonor(user)) {
    throw new AppError(
      "ENTITLEMENT_REQUIRED",
      403,
      "Model ini terbuka setelah traktir kopi di Ko-fi (opsional).",
    );
  }
  if ((user.credits?.imageFlux3 ?? 0) <= 0) {
    throw new AppError(
      "INSUFFICIENT_CREDITS",
      402,
      "Kredit gambar FLUX.3 habis. Donasi lagi untuk menambah kredit.",
    );
  }
}

/** Cosmos hanya untuk donatur dengan kredit video (§8.2). */
export function canUseCosmos(user: EntitlementUser): boolean {
  return isDonor(user) && (user.credits?.videoCosmos ?? 0) > 0;
}

export interface EntitlementsImageModel {
  id: "flux2-klein" | "flux3-klein";
  label: string;
  locked: boolean;
  badge: string;
  /** Hanya ada bila locked: "DONATION_REQUIRED" | "MEDIA_DISABLED" (§7.2). */
  reason?: string;
}

export interface EntitlementsVideoEngine {
  id: "auto" | "python" | "cosmos";
  label: string;
  locked: boolean;
}

export interface EntitlementsPayload {
  mediaEnabled: boolean;
  isDonor: boolean;
  credits: { imageFlux3: number; videoCosmos: number };
  donationCode: string | null;
  koFiUrl: string | null;
  image: { models: EntitlementsImageModel[] };
  video: {
    engine: "cosmos" | "python";
    engines: EntitlementsVideoEngine[];
    aspects: Array<"16:9" | "9:16">;
  };
  dailyRemaining: { imageFlux2: number; videoPython: number };
}

/**
 * Payload `GET /api/me/entitlements` (§7.2). donationCode dibaca apa adanya;
 * pembuatan lazy kode (getOrCreateDonationCode) masuk Fase 3 bersama Ko-fi.
 */
export async function buildEntitlementsPayload(
  userId: Types.ObjectId,
): Promise<EntitlementsPayload> {
  const user = await UserModel.findById(userId).select({ createdAt: 1 }).lean();

  if (!user) throw AppError.notFound();

  const [imageUsed, pythonUsed] = await Promise.all([
    getDailyCount(userId, "image_flux2"),
    getDailyCount(userId, "video_python"),
  ]);

  const mediaEnabled = env.MEDIA_ENABLED;

  return {
    mediaEnabled,
    isDonor: false,
    credits: { imageFlux3: 0, videoCosmos: 0 },
    donationCode: null,
    koFiUrl: null,
    image: {
      models: [
        {
          id: "flux2-klein",
          label: "FLUX.2 Klein 4B",
          locked: !mediaEnabled,
          badge: mediaEnabled ? "Tersedia" : "Nonaktif",
        },
      ],
    },
    video: {
      engine: "cosmos",
      engines: [{ id: "auto", label: "Otomatis", locked: !mediaEnabled }],
      aspects: ["16:9", "9:16"],
    },
    dailyRemaining: {
      imageFlux2: Math.max(
        0,
        effectiveDailyLimit("image_flux2", user.createdAt) - imageUsed,
      ),
      videoPython: Math.max(
        0,
        effectiveDailyLimit("video_python", user.createdAt) - pythonUsed,
      ),
    },
  };
}
