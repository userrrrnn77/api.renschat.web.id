// src/services/usage.service.ts
import { Types } from "mongoose";
import { MessageModel } from "../models/Message.js";
import { GenerationJobModel } from "../models/GenerationJob.js";
import { UserModel } from "../models/User.js";
import { env } from "../config/env.js";

export interface DailyUsage {
  day: string; // YYYY-MM-DD di timezone user
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  images: number;
  videos: number;
  requests: number;
}

export interface UsageTotal {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  images: number;
  videos: number;
  requests: number;
}

export interface UsageReport {
  timezone: string;
  month: string; // YYYY-MM
  windowDays: number;
  total: UsageTotal;
  daily: DailyUsage[];
}

const WINDOW_DAYS = 30;

async function getUserTimezone(userId: Types.ObjectId): Promise<string> {
  const user = await UserModel.findById(userId).select({ timezone: 1 }).lean();
  return user?.timezone ?? env.DEFAULT_TIMEZONE;
}

function currentMonthInTz(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz }).slice(0, 7);
}

function lastNDaysInTz(tz: string, n: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    out.push(d.toLocaleDateString("en-CA", { timeZone: tz }));
  }
  return out;
}

/**
 * Bangun laporan penggunaan user (Phase 6). Sumber data:
 * - Token & request: `MessageModel` role=assistant, field `usage`.
 * - Media: `GenerationJobModel` status=succeeded, field `kind`.
 * Timezone grouping mengikuti `user.timezone`, fallback `env.DEFAULT_TIMEZONE`.
 */
export async function buildUsageReport(
  userId: Types.ObjectId,
): Promise<UsageReport> {
  const timezone = await getUserTimezone(userId);
  const month = currentMonthInTz(timezone);
  const days = lastNDaysInTz(timezone, WINDOW_DAYS);

  const usageAgg = await MessageModel.aggregate<{
    _id: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
  }>([
    {
      $match: {
        userId,
        role: "assistant",
      },
    },
    {
      $addFields: {
        day: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone,
          },
        },
      },
    },
    {
      $match: {
        day: { $regex: `^${month}-` },
      },
    },
    {
      $group: {
        _id: "$day",
        promptTokens: { $sum: { $ifNull: ["$usage.prompt_tokens", 0] } },
        completionTokens: {
          $sum: { $ifNull: ["$usage.completion_tokens", 0] },
        },
        totalTokens: { $sum: { $ifNull: ["$usage.total_tokens", 0] } },
        requests: { $sum: 1 },
      },
    },
  ]);

  const jobAgg = await GenerationJobModel.aggregate<{
    _id: { day: string; kind: "image" | "video" };
    count: number;
  }>([
    {
      $match: {
        userId,
        status: "succeeded",
      },
    },
    {
      $addFields: {
        day: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: { $ifNull: ["$finishedAt", "$queuedAt"] },
            timezone,
          },
        },
      },
    },
    {
      $match: {
        day: { $regex: `^${month}-` },
      },
    },
    {
      $group: {
        _id: { day: "$day", kind: "$kind" },
        count: { $sum: 1 },
      },
    },
  ]);

  const byDay = new Map<string, DailyUsage>();
  for (const d of days) {
    byDay.set(d, {
      day: d,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      images: 0,
      videos: 0,
      requests: 0,
    });
  }

  for (const row of usageAgg) {
    const cur = byDay.get(row._id);
    if (!cur) continue;
    cur.promptTokens = row.promptTokens;
    cur.completionTokens = row.completionTokens;
    cur.totalTokens = row.totalTokens;
    cur.requests = row.requests;
  }

  for (const row of jobAgg) {
    const cur = byDay.get(row._id.day);
    if (!cur) continue;
    if (row._id.kind === "image") cur.images = row.count;
    else cur.videos = row.count;
  }

  const daily = days.map((d) => byDay.get(d)!);

  const total: UsageTotal = daily.reduce(
    (acc, d) => {
      acc.promptTokens += d.promptTokens;
      acc.completionTokens += d.completionTokens;
      acc.totalTokens += d.totalTokens;
      acc.images += d.images;
      acc.videos += d.videos;
      acc.requests += d.requests;
      return acc;
    },
    {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      images: 0,
      videos: 0,
      requests: 0,
    },
  );

  return { timezone, month, windowDays: WINDOW_DAYS, total, daily };
}
