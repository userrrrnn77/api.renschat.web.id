// tests/unit/systemPromptBranding.test.ts
import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/services/chat/systemPrompt.js";

describe("systemPrompt branding & identitas", () => {
  test("memuat RensChat dan Shaga-ultra-2.6, tidak memuat GenUI", () => {
    const prompt = buildSystemPrompt({ toolsAvailable: [] });
    expect(prompt).toContain("RensChat");
    expect(prompt).toContain("Shaga-ultra-2.6");
    expect(prompt.toLowerCase()).not.toContain("genui");
  });

  test("dengan tools tersedia tetap konsisten", () => {
    const prompt = buildSystemPrompt({
      toolsAvailable: ["render_table", "render_chart", "create_file"],
    });
    expect(prompt).toContain("RensChat");
    expect(prompt).toContain("Shaga-ultra-2.6");
    expect(prompt.toLowerCase()).not.toContain("genui");
  });
});
