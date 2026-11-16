// src/services/credits.service.ts
import { Types } from "mongoose";
import { UserModel } from "../models/User.js";
import { CreditLedgerModel } from "../models/CreditLedger.js";
import { GenerationJobModel } from "../models/GenerationJob.js";

/** Jenis kredit yang bisa dikonsumsi/refund (§6.1). */
export type CreditKey = "imageFlux3" | "videoCosmos";

const CREDIT_PATH: Record<CreditKey, string> = {
  imageFlux3: "credits.imageFlux3",
  videoCosmos: "credits.videoCosmos",
};

export interface CreditCost {
  imageFlux3: number;
  videoCosmos: number;
}

/**
 * Konsumsi tepat 1 kredit secara atomik (§11.2 langkah 5, §12.2).
 * Kondisi `credits.X > 0` di dalam filter membuat 20 request paralel saat
 * saldo 1 hanya menghasilkan 1 keberhasilan. `refJobId` = GenerationJob yang
 * menanggung biaya (untuk CreditLedger). Return false = saldo habis.
 */
export async function consumeCredit(
  userId: Types.ObjectId,
  key: CreditKey,
  refJobId: string,
): Promise<boolean> {
  const updated = await UserModel.findOneAndUpdate(
    { _id: userId, [CREDIT_PATH[key]]: { $gt: 0 } },
    { $inc: { [CREDIT_PATH[key]]: -1 } },
    { new: true },
  ).lean();
  if (!updated) return false;

  await CreditLedgerModel.create({
    userId,
    delta: {
      imageFlux3: key === "imageFlux3" ? -1 : 0,
      videoCosmos: key === "videoCosmos" ? -1 : 0,
    },
    reason: "consume",
    refType: "job",
    refId: refJobId,
  });
  return true;
}

/**
 * Refund kredit idempotent (§7.8: semua error generate mengembalikan
 * kredit). Idempotensi dijaga oleh flag `GenerationJob.refunded`: update
 * kondisional `refunded: false → true` hanya boleh menang satu kali; jika
 * race, pemanggil kedua mendapat modifiedCount 0 dan berhenti.
 */
export async function refundJobCredits(job: {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  creditCost: CreditCost;
}): Promise<void> {
  const claimed = await GenerationJobModel.updateOne(
    { _id: job._id, refunded: false },
    { $set: { refunded: true } },
  );
  if ((claimed.modifiedCount ?? 0) === 0) return;

  const delta = {
    imageFlux3: job.creditCost.imageFlux3,
    videoCosmos: job.creditCost.videoCosmos,
  };
  if (delta.imageFlux3 === 0 && delta.videoCosmos === 0) return;

  await UserModel.updateOne(
    { _id: job.userId },
    {
      $inc: {
        "credits.imageFlux3": delta.imageFlux3,
        "credits.videoCosmos": delta.videoCosmos,
      },
    },
  );
  await CreditLedgerModel.create({
    userId: job.userId,
    delta,
    reason: "refund",
    refType: "job",
    refId: job._id.toString(),
  });
}

/** Saldo kredit terkini untuk payload entitlements (§7.2). */
export async function getCreditBalance(
  userId: Types.ObjectId,
): Promise<CreditCost> {
  const user = await UserModel.findById(userId).select({ credits: 1 }).lean();
  return {
    imageFlux3: user?.credits?.imageFlux3 ?? 0,
    videoCosmos: user?.credits?.videoCosmos ?? 0,
  };
}
