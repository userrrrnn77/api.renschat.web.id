// tests/unit/budget.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { env } from "../../src/config/env.js";
import {
  assertMediaEnabled,
  effectiveDailyLimit,
  assertGlobalDailyCap,
} from "../../src/services/generation/budget.service.js";
import { AppError } from "../../src/middleware/error.js";
import { GlobalUsageCounterModel } from "../../src/models/UsageCounter.js";

describe("kill switch (MEDIA_ENABLED)", () => {
  const original = env.MEDIA_ENABLED;

  afterEach(() => {
    (env as unknown as { MEDIA_ENABLED: boolean }).MEDIA_ENABLED = original;
  });

  test("throws MEDIA_DISABLED when false", () => {
    (env as unknown as { MEDIA_ENABLED: boolean }).MEDIA_ENABLED = false;
    try {
      assertMediaEnabled();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("MEDIA_DISABLED");
    }
  });

  test("passes when true", () => {
    (env as unknown as { MEDIA_ENABLED: boolean }).MEDIA_ENABLED = true;
    expect(() => assertMediaEnabled()).not.toThrow();
  });
});

describe("effectiveDailyLimit (NEW_ACCOUNT_DAILY_FACTOR)", () => {
  test("new account (< 24h) gets half the base limit", () => {
    const justNow = new Date();
    const limit = effectiveDailyLimit("image_flux2", justNow);
    const base = env.IMAGE_FREE_DAILY_LIMIT;
    expect(limit).toBe(Math.floor(base * env.NEW_ACCOUNT_DAILY_FACTOR));
  });

  test("old account gets full base limit", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    expect(effectiveDailyLimit("image_flux2", twoDaysAgo)).toBe(
      env.IMAGE_FREE_DAILY_LIMIT,
    );
  });
});

describe("assertGlobalDailyCap", () => {
  const originalFindOne = GlobalUsageCounterModel.findOne;

  afterEach(() => {
    (GlobalUsageCounterModel as unknown as { findOne: unknown }).findOne =
      originalFindOne;
  });

  test("throws MEDIA_DISABLED when count >= cap", async () => {
    (GlobalUsageCounterModel as unknown as { findOne: unknown }).findOne =
      (() => ({
        select: () => ({
          lean: async () => ({ count: 999_999_999 }),
        }),
      })) as unknown as typeof GlobalUsageCounterModel.findOne;

    try {
      await assertGlobalDailyCap("flux2");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AppError).code).toBe("MEDIA_DISABLED");
    }
  });

  test("passes when count < cap", async () => {
    (GlobalUsageCounterModel as unknown as { findOne: unknown }).findOne =
      (() => ({
        select: () => ({
          lean: async () => ({ count: 0 }),
        }),
      })) as unknown as typeof GlobalUsageCounterModel.findOne;

    await expect(assertGlobalDailyCap("flux2")).resolves.toBeUndefined();
  });
});
