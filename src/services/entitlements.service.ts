// src/services/entitlements.service.ts
import { Types } from "mongoose";
import { UserModel } from "../models/User.js";
import { AppError } from "../middleware/error.js";
import { env } from "../config/env.js";
import {
  effectiveDailyLimit,
  getDailyCount,
} from "./generation/budget.service.js";
import { getOrCreateDonationCode } from "./kofi.service.js";

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
  const user = await UserModel.findById(userId)
    .select({
      credits: 1,
      donorSince: 1,
      donationCode: 1,
      createdAt: 1,
    })
    .lean();
  if (!user) throw AppError.notFound();

  const donor = isDonor(user);

  const imageFlux3 = user.credits?.imageFlux3 ?? 0;
  const videoCosmos = user.credits?.videoCosmos ?? 0;
  const mediaEnabled = env.MEDIA_ENABLED;

  // Donation code lazily created (§9.2). Non-blocking failure: fall back to
  // whatever is stored so entitlements tetap berguna kalau pembuatan gagal.
  let donationCode: string | null = user.donationCode ?? null;
  if (!donationCode) {
    try {
      donationCode = await getOrCreateDonationCode(userId);
    } catch {
      donationCode = user.donationCode ?? null;
    }
  }

  const imgLimit = effectiveDailyLimit("image_flux2", user.createdAt);
  const vidLimit = effectiveDailyLimit("video_python", user.createdAt);
  const [imgUsed, vidUsed] = await Promise.all([
    getDailyCount(userId, "image_flux2"),
    getDailyCount(userId, "video_python"),
  ]);

  const flux3Locked = !mediaEnabled || !donor || imageFlux3 <= 0;
  const imageModels: EntitlementsImageModel[] = [
    {
      id: "flux2-klein",
      label: "FLUX.2 Klein 4B",
      locked: !mediaEnabled,
      badge: mediaEnabled ? "Gratis" : "Nonaktif",
      ...(!mediaEnabled ? { reason: "MEDIA_DISABLED" } : {}),
    },
    {
      id: "flux3-klein",
      label: "FLUX.3 Image Klein",
      locked: flux3Locked,
      badge: donor && mediaEnabled ? `${imageFlux3} kredit` : "10 kredit",
      ...(flux3Locked
        ? { reason: mediaEnabled ? "DONATION_REQUIRED" : "MEDIA_DISABLED" }
        : {}),
    },
  ];

  const engines: EntitlementsVideoEngine[] = [
    { id: "auto", label: "Otomatis", locked: false },
    { id: "python", label: "Python (gratis)", locked: false },
  ];

  return {
    mediaEnabled,
    isDonor: donor,
    credits: { imageFlux3, videoCosmos },
    donationCode,
    koFiUrl: env.KOFI_PAGE_URL ?? null,
    image: { models: imageModels },
    video: {
      engine: canUseCosmos(user) ? "cosmos" : "python",
      engines,
      aspects: ["16:9", "9:16"],
    },
    dailyRemaining: {
      imageFlux2: Math.max(0, imgLimit - imgUsed),
      videoPython: Math.max(0, vidLimit - vidUsed),
    },
  };
}
