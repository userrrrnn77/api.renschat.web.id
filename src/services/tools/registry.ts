// src/services/tools/registry.ts

import type { z } from "zod";
import type { Types } from "mongoose";
import type { Block } from "../blocks/schemas.js";
import type { ClarificationQuestion } from "../orchestrator/clarification.js";
import type { GenerationPlan } from "../generation/plan.js";

export interface ToolContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  abortSignal: AbortSignal;
  emit: (event: string, data: unknown) => void;
  /** Emit block atomik (start+end) sekaligus. */
  emitBlock: (block: Block) => void;
  /** Iterasi loop (0-based). */
  iteration: number;
  /** Plan generation turn ini (model/engine/kredit diputus server, §5.2). */
  generation: GenerationPlan;
  /**
   * Minta klarifikasi ke user (hold-and-resume). Bila tidak tersedia,
   * tool yang butuh klarifikasi harus fallback ke perilaku lama.
   */
  askClarification?: (q: ClarificationQuestion) => Promise<string[]>;
}

export interface ToolResult {
  ok: boolean;
  /** JSON text ≤2KB dikirim balik ke model. */
  content: string;
  /** Kalau true, giliran diakhiri setelah tool ini. */
  endTurn?: boolean;
}

export interface ToolDef {
  name: string;
  kind: "ui" | "file" | "attachment" | "command" | "media" | "web";
  description: string;
  schema: z.ZodTypeAny;
  maxResultChars?: number;
  run: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

const registry = new Map<string, ToolDef>();

export function registerTool(tool: ToolDef): void {
  if (registry.has(tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }
  registry.set(tool.name, tool);
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

export function listTools(): ToolDef[] {
  return [...registry.values()];
}

export function listToolNames(): string[] {
  return [...registry.keys()];
}

const MAX_TOOL_RESULT_LEN = 2048;

/**
 * Truncate tool result string, preserving JSON validity when possible.
 * Naive `.slice(0, maxLen)` on a JSON string produces malformed JSON
 * (`{"ok":true,"content":"...cut...`) which confuses the model on the
 * next tool iteration. We try two recovery strategies:
 *   1. Cut at the last complete `}` or `]` and validate with JSON.parse.
 *   2. Wrap the preview in a valid `{ok:false, error:"RESULT_TRUNCATED"}`
 *      envelope so the model still gets readable content.
 */
export function truncateResult(
  s: string,
  maxLen = MAX_TOOL_RESULT_LEN,
): string {
  if (s.length <= maxLen) return s;

  // Strategy 1: cut at last complete JSON boundary
  const sliced = s.slice(0, maxLen);
  const lastClose = Math.max(sliced.lastIndexOf("}"), sliced.lastIndexOf("]"));
  if (lastClose > maxLen * 0.5) {
    const candidate = sliced.slice(0, lastClose + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // not recoverable — fall through
    }
  }

  // Strategy 2: wrap preview in valid JSON envelope
  const envelope = {
    ok: false,
    error: "RESULT_TRUNCATED",
    message: `Original length ${s.length} exceeds limit ${maxLen}`,
    preview: sliced.slice(0, Math.max(0, maxLen - 140)),
  };
  const out = JSON.stringify(envelope);
  // Defensive: if envelope itself exceeds maxLen (very small maxLen),
  // do a hard slice as last resort.
  return out.length <= maxLen ? out : out.slice(0, maxLen);
}

export function errorResult(
  code: string,
  message: string,
  hint?: unknown,
  maxLen = MAX_TOOL_RESULT_LEN,
): ToolResult {
  const payload: Record<string, unknown> = {
    ok: false,
    error: code,
    message,
  };
  if (hint !== undefined) payload.hint = hint;
  return {
    ok: false,
    content: truncateResult(JSON.stringify(payload), maxLen),
  };
}

export function okResult(
  data: Record<string, unknown>,
  maxLen = MAX_TOOL_RESULT_LEN,
): ToolResult {
  return {
    ok: true,
    content: truncateResult(JSON.stringify({ ok: true, ...data }), maxLen),
  };
}
