// tests/unit/webScrape.test.ts
import { describe, test, expect } from "bun:test";
import {
  checkDomain,
  checkUrlPath,
  checkTitle,
  checkContentScore,
} from "../../src/services/tools/webScrapeBlocklist.js";

describe("web_scrape blocklist", () => {
  test("blokir domain judi/pinjol", () => {
    expect(checkDomain("situs-judol.com")).toBe(true);
    expect(checkDomain("pinjol-cepat.co.id")).toBe(true);
    expect(checkDomain("example.com")).toBe(false);
  });

  test("blokir URL path judi", () => {
    expect(checkUrlPath("http://example.com/deposit-slot")).toBe(true);
    expect(checkUrlPath("http://example.com/about")).toBe(false);
  });

  test("blokir judul", () => {
    expect(checkTitle("Link Alternatif Slot Gacor Maxwin")).toBe(true);
    expect(checkTitle("Tutorial React JS")).toBe(false);
  });

  test("skor konten", () => {
    const safeText = "Ini adalah artikel tentang teknologi.";
    const badText =
      "Dapatkan bonus new member dengan minimal deposit pulsa. Maxwin hari ini!";
    expect(checkContentScore(safeText)).toBe(0);
    expect(checkContentScore(badText)).toBeGreaterThan(0);
  });
});
