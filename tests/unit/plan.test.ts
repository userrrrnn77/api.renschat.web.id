// tests/unit/plan.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mock } from "bun:test";

// Mock assertGlobalDailyCap BEFORE importing plan.js (static import order matters).
mock.module("../../src/services/generation/budget.service.js", () => ({
  assertGlobalDailyCap: async () => {
    // no-op by default; individual tests override via mutable state
    if (capExceeded) {
      const { AppError } = await import("../../src/middleware/error.js");
      throw new AppError(
        "MEDIA_DISABLED",
        503,
        "Fitur media sedang dinonaktifkan sementara.",
      );
    }
  },
}));

let capExceeded = false;

const { resolveVideoEngine } =
  await import("../../src/services/generation/plan.js");

const donorUser = {
  credits: { imageFlux3: 0, videoCosmos: 4 },
  donorSince: new Date(),
};
const nonDonor = {
  credits: { imageFlux3: 0, videoCosmos: 0 },
  donorSince: null,
};

describe("resolveVideoEngine", () => {
  beforeEach(() => {
    capExceeded = false;
  });

  test("explicit python → python", async () => {
    expect(await resolveVideoEngine(donorUser, "python")).toBe("python");
    expect(await resolveVideoEngine(nonDonor, "python")).toBe("python");
  });

  test("explicit cosmos + donor with credits → cosmos", async () => {
    expect(await resolveVideoEngine(donorUser, "cosmos")).toBe("cosmos");
  });

  test("explicit cosmos + non-donor → falls back to python", async () => {
    expect(await resolveVideoEngine(nonDonor, "cosmos")).toBe("python");
  });

  test("auto + donor with credits + cap OK → cosmos", async () => {
    expect(await resolveVideoEngine(donorUser, "auto")).toBe("cosmos");
  });

  test("auto + donor with credits + cap exceeded → python", async () => {
    capExceeded = true;
    expect(await resolveVideoEngine(donorUser, "auto")).toBe("python");
  });

  test("auto + non-donor → python", async () => {
    expect(await resolveVideoEngine(nonDonor, "auto")).toBe("python");
  });
});
