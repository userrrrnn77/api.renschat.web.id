// src/services/tools/index.ts

import { z } from "zod";
import { listTools, listToolNames } from "./registry.js";
import type { ToolDefinition } from "../llm/nvidiaClient.js";
import { env } from "@config/env.js";

// Side-effect: register tools
import "./ui.js";
import "./files.js";
import "./pdf.js";
import "./attachments.js";
import "./terminal.js";
import "./generateImage.js";
import "./generateVideoCosmos.js";
import "./generateVideoPython.js";
import { registerWebScrapeTool } from "./webScrape.js";

// Tool web scrape didaftarkan secara kondisional
if (env.WEB_SCRAPE_ENABLED) {
  registerWebScrapeTool();
}

export { getTool, listTools, listToolNames } from "./registry.js";
export type { ToolContext, ToolResult, ToolDef } from "./registry.js";

/**
 * Bila `allowed` diberikan, hanya tool dalam set yang ikut (tool non-media
 * selalu lolos). Menyembunyikan tool dari daftar saja tidak cukup —
 * agentLoop tetap memvalidasi lewat allowlist (§8.5).
 */
export function buildToolDefinitions(
  allowed?: ReadonlySet<string>,
): ToolDefinition[] {
  return listTools()
    .filter(
      (t) => allowed === undefined || t.kind !== "media" || allowed.has(t.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.schema, {
          target: "draft-7",
          io: "input",
        }) as Record<string, unknown>,
      },
    }));
}
