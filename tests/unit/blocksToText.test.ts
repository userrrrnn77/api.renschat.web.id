// tests/unit/blocksToText.test.ts
import { describe, test, expect } from "bun:test";
import { blocksToText } from "../../src/services/chat/contextBuilder.js";
import type { Block } from "../../src/services/blocks/schemas.js";

describe("blocksToText", () => {
  test("video block → safe short text (no fileId leak)", () => {
    const block: Block = {
      type: "video",
      fileId: "deadbeefdeadbeefdeadbeef",
      engine: "cosmos",
      aspect: "16:9",
      durationSec: 6,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const out = blocksToText([block]);
    expect(out).toContain("[video dibuat: 16:9, 6 dtk]");
    expect(out).not.toContain("deadbeef");
  });

  test("video without duration", () => {
    const block: Block = {
      type: "video",
      fileId: "abc",
      engine: "python",
      aspect: "9:16",
    };
    const out = blocksToText([block]);
    expect(out).toContain("[video dibuat: 9:16]");
  });

  test("image block with alt does not throw", () => {
    const block: Block = {
      type: "image",
      fileId: "abc",
      alt: "kucing astronot",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      width: 1024,
      height: 1024,
    };
    const out = blocksToText([block]);
    expect(out).toContain("[image:");
    expect(out).toContain("kucing astronot");
  });
});
