// src/services/harness/harness.ts
import { env } from "../../config/env.js";
import type { GenerationPlan } from "../generation/plan.js";
import type { ReasoningEffort } from "../llm/provider.js";

export interface HarnessDecision {
  complexity: "simple" | "standard" | "complex";
  model: string;
  reasoning: ReasoningEffort;
  maxTokens: number;
}

export interface HarnessInput {
  text: string;
  attachmentCount: number;
  fileCount: number;
  historyLen: number;
  hasRetrieval: boolean;
  /** Plan generation turn ini; mode eksplisit selalu pakai MODEL_MAIN (§8.6). */
  generation?: GenerationPlan;
}

const HEAVY_VERBS =
  /analisis|bandingkan|debug|rancang|arsitektur|buktikan|optimasi|strategi|step by step|kenapa error/i;

// §8.6: pesan yang menuntut media tidak boleh jatuh ke MODEL_FAST
// (model fast lemah di tool calling).
const MEDIA_KEYWORDS =
  /\b(gambar|foto|ilustrasi|image|images|video|videos|animasi|animation|klip)\b/i;

const PY_VIDEO_EXTRA_TOKENS = 8_000;

function maxTokensWithMediaBudget(base: number, input: HarnessInput): number {
  if (input.generation?.allowedMediaTools.has("generate_video_python")) {
    return base + PY_VIDEO_EXTRA_TOKENS;
  }
  return base;
}

export function classifyTurn(input: HarnessInput): HarnessDecision {
  if (!env.HARNESS_ENABLED) {
    return {
      complexity: "standard",
      model: env.MODEL_MAIN,
      reasoning: env.REASONING_DEFAULT,
      maxTokens: maxTokensWithMediaBudget(env.MAX_OUTPUT_TOKENS, input),
    };
  }

  // §8.6: mode generation eksplisit ATAU kata kunci media → paksa MODEL_MAIN.
  const isMediaRequest =
    (input.generation !== undefined && input.generation.mode !== "auto") ||
    MEDIA_KEYWORDS.test(input.text);

  if (isMediaRequest) {
    return {
      complexity: "standard",
      model: env.MODEL_MAIN,
      reasoning: env.REASONING_DEFAULT,
      maxTokens: maxTokensWithMediaBudget(env.MAX_OUTPUT_TOKENS, input),
    };
  }

  const isSimple =
    input.text.length <= 80 &&
    !input.text.includes("```") &&
    !HEAVY_VERBS.test(input.text) &&
    input.attachmentCount === 0 &&
    !input.hasRetrieval;

  if (isSimple) {
    return {
      complexity: "simple",
      model: env.HARNESS_ROUTE_FAST ? env.MODEL_FAST : env.MODEL_MAIN,
      reasoning: "off",
      maxTokens: maxTokensWithMediaBudget(env.MAX_OUTPUT_TOKENS, input),
    };
  }

  const isComplex =
    HEAVY_VERBS.test(input.text) ||
    input.text.includes("```") ||
    input.text.length > 600 ||
    input.attachmentCount >= 2 ||
    /\b\d+[\+\-\*\/\^]\d+\b/.test(input.text);

  if (isComplex) {
    // reasoning="high" → 16384 thinking budget. maxTokens harus
    // mengalokasikan thinking budget yang SAMA + headroom output.
    // Sebelumnya budget diambil dari env.REASONING_DEFAULT (bisa "off"
    // atau "low") padahal reasoning-nya dipaksa "high" → mismatch.
    const HIGH_REASONING_BUDGET = 16384;
    const HIGH_MIN_OUTPUT = 8192; // headroom untuk tool call / file panjang
    return {
      complexity: "complex",
      model: env.MODEL_MAIN,
      reasoning: "high",
      maxTokens: maxTokensWithMediaBudget(
        Math.max(env.MAX_OUTPUT_TOKENS, HIGH_MIN_OUTPUT) +
          HIGH_REASONING_BUDGET,
        input,
      ),
    };
  }

  return {
    complexity: "standard",
    model: env.MODEL_MAIN,
    reasoning: env.REASONING_DEFAULT,
    maxTokens: maxTokensWithMediaBudget(env.MAX_OUTPUT_TOKENS, input),
  };
}
