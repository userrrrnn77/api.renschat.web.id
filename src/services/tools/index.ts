// src/services/tools/index.ts

import { z } from "zod";
import { listTools, listToolNames } from "./registry.js";
import type { ToolDefinition } from "../llm/nvidiaClient.js";
import { env } from "@config/env.js";
import { FILE_ICONS } from "../blocks/fileAppearance.js";

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

function buildModelParameters(
  tool: ReturnType<typeof listTools>[number],
): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.schema, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;

  if (tool.name !== "create_file") return schema;

  const properties = schema.properties as Record<string, unknown> | undefined;

  if (!properties) return schema;

  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];

  return {
    ...schema,
    properties: {
      ...properties,
      appearance: {
        type: "object",
        description:
          "Choose the file card icon and accent based on the file's purpose. " +
          "For React TSX components use code with #61DAFB; " +
          "for TypeScript source use code with #3178C6; " +
          "for Prisma schemas use pyramid; for package manifests use package. " +
          "Use file only when no specific icon fits.",
        properties: {
          icon: {
            type: "string",
            enum: [...FILE_ICONS],
          },
          accent: {
            type: "string",
            description: "Six-digit CSS hex color, for example #61DAFB.",
            pattern: "^#[0-9A-Fa-f]{6}$",
          },
        },
        required: ["icon", "accent"],
        additionalProperties: false,
      },
    },
    required: [...new Set([...required, "appearance"])],
  };
}

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
        parameters: buildModelParameters(t),
      },
    }));
}
