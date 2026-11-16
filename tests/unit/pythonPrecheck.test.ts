// tests/unit/pythonPrecheck.test.ts
import { describe, test, expect } from "bun:test";
import { validatePythonScript } from "../../src/services/generation/video.python.service.js";

describe("validatePythonScript", () => {
  test("accepts allowlisted imports", () => {
    const script = [
      "import os",
      "import numpy as np",
      "from PIL import Image, ImageDraw",
      "from pathlib import Path",
      "print('ok')",
    ].join("\n");
    const r = validatePythonScript(script);
    expect(r.ok).toBe(true);
  });

  test("rejects non-allowlisted import", () => {
    const r = validatePythonScript("import requests\nprint(1)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("requests");
  });

  test("rejects from-import of non-allowlisted module", () => {
    const r = validatePythonScript("from socket import socket");
    expect(r.ok).toBe(false);
  });

  test("rejects empty script", () => {
    const r = validatePythonScript("");
    expect(r.ok).toBe(false);
  });

  test("rejects script larger than 20KB", () => {
    const big = "x = 1\n".repeat(4000); // ~ 24KB
    const r = validatePythonScript(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("20");
  });
});
