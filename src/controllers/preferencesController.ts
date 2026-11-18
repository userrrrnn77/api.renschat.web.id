import type { Request, Response } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { UserModel } from "../models/User.js";
import { AppError } from "../middleware/error.js";

const PersonalitySchema = z.object({
  mode: z.enum(["auto", "serious", "casual", "playful"]),
  note: z.string().max(300).optional(),
});

const UpdatePreferencesSchema = z.object({
  personality: PersonalitySchema.optional(),
});

export async function getPreferences(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getUserId(res);
  const user = await UserModel.findById(userId)
    .select("personality styleProfile")
    .lean();
  if (!user) throw AppError.unauthorized();

  const personality = user.personality || { mode: "auto" };
  const styleProfile = user.styleProfile ?? null;

  res.json({
    personality,
    styleProfile,
  });
}

export async function updatePreferences(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getUserId(res);
  const body = UpdatePreferencesSchema.parse(req.body);

  const update: Record<string, unknown> = {};

  if (body.personality) {
    const cleanNote = body.personality.note
      ? body.personality.note
          .replace(/[<>]/g, "")
          .replace(/[\x00-\x1F\x7F]/g, "")
      : undefined;

    update.personality = {
      mode: body.personality.mode,
      ...(cleanNote !== undefined ? { note: cleanNote } : {}),
    };
  }

  const user = await UserModel.findByIdAndUpdate(
    userId,
    { $set: update },
    { new: true, select: "personality styleProfile" },
  ).lean();

  if (!user) throw AppError.unauthorized();

  const personality = user.personality || { mode: "auto" };
  const styleProfile = user.styleProfile ?? null;

  res.json({
    personality,
    styleProfile,
  });
}
