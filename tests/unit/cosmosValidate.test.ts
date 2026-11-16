// tests/unit/cosmosValidate.test.ts
import { describe, test, expect } from "bun:test";
import {
  validateNumFrames,
  mapAspectToCosmosResolution,
} from "../../src/services/llm/providers/cosmos.client.js";
import { AppError } from "../../src/middleware/error.js";

describe("validateNumFrames (4k+1 + tier bounds)", () => {
  test("valid tier 480: 25, 97, 297", () => {
    expect(validateNumFrames(25, "480")).toBe(25);
    expect(validateNumFrames(97, "480")).toBe(97);
    expect(validateNumFrames(297, "480")).toBe(297);
  });

  test("invalid pattern (not 4k+1)", () => {
    for (const v of [24, 96, 100, 298]) {
      try {
        validateNumFrames(v, "480");
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("INVALID_PARAMS");
      }
    }
  });

  test("out of tier bounds", () => {
    // tier 720 max = 197
    try {
      validateNumFrames(201, "720");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AppError).code).toBe("INVALID_PARAMS");
    }
  });
});

describe("mapAspectToCosmosResolution", () => {
  test("16:9 → 480_16_9", () => {
    expect(mapAspectToCosmosResolution("16:9")).toBe("480_16_9");
  });
  test("9:16 → 480_9_16", () => {
    expect(mapAspectToCosmosResolution("9:16")).toBe("480_9_16");
  });
});
