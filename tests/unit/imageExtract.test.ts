// tests/unit/imageExtract.test.ts
import { describe, test, expect } from "bun:test";
import { extractImageBase64 } from "../../src/services/generation/image.service.js";
import { AppError } from "../../src/middleware/error.js";

describe("extractImageBase64", () => {
  test("artifacts[0].base64", () => {
    expect(extractImageBase64({ artifacts: [{ base64: "AAAA" }] })).toBe(
      "AAAA",
    );
  });

  test("artifacts[0].b64_json", () => {
    expect(extractImageBase64({ artifacts: [{ b64_json: "BBBB" }] })).toBe(
      "BBBB",
    );
  });

  test("root.image", () => {
    expect(extractImageBase64({ image: "CCCC" })).toBe("CCCC");
  });

  test("root.b64_json", () => {
    expect(extractImageBase64({ b64_json: "DDDD" })).toBe("DDDD");
  });

  test("data[0].b64_json", () => {
    expect(extractImageBase64({ data: [{ b64_json: "EEEE" }] })).toBe("EEEE");
  });

  test("unknown response shape → PROVIDER_ERROR", () => {
    try {
      extractImageBase64({ foo: "bar" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("PROVIDER_ERROR");
    }
  });

  test("empty string values are ignored", () => {
    try {
      extractImageBase64({
        artifacts: [{ base64: "" }],
        image: "",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AppError).code).toBe("PROVIDER_ERROR");
    }
  });
});
