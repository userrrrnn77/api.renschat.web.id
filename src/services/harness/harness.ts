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

const OFFICE_SUBJECT =
  /\b(?:transaksi|saldo|mutasi|anggaran|biaya|omzet|laba|arus kas|penjualan|laporan|notul[ae]n|rapat|proyek|jadwal|risiko|tugas|email|surel|invoice|faktur|tagihan|kas|budget|expenses?|revenue|sales|transactions?|balances?|reports?|minutes|meetings?|projects?|tasks?|invoices?|cash flow)\b/i;

const OFFICE_ACTION =
  /\b(?:buat(?:kan|in)?|bikin(?:kan|in)?|susun(?:kan)?|tulis(?:kan)?|rangkum(?:kan)?|ringkas(?:kan)?|rekap(?:kan)?|revisi|rapikan|hitung(?:kan)?|draft|write|prepare|summari[sz]e|calculate|compile)\b/i;

const OFFICE_ANALYSIS =
  /\b(?:rekonsiliasi(?:kan)?|cocokkan|bandingkan|bandingin|proyeksikan|prioritaskan|reconcile|compare|forecast|prioriti[sz]e)\b|\b(?:cari|telusuri|jelaskan|find|explain)\s+(?:penyebab\s+)?(?:selisih|varians|variance|discrepanc(?:y|ies))\b/i;

const DEFINITION =
  /^(?:(?:bre|tolong|please)[,\s]+)*(?:apa (?:itu|arti(?:nya)?|definisi)|what is|what are|define|definition of)\b/i;

function officeComplexity(text: string): "standard" | "complex" | undefined {
  if (!OFFICE_SUBJECT.test(text)) return undefined;

  const definitionOnly =
    DEFINITION.test(text.trim()) &&
    !OFFICE_ACTION.test(text) &&
    !/[;\n]|\b(?:lalu|kemudian|then)\b/i.test(text);

  if (definitionOnly) return undefined;
  if (OFFICE_ANALYSIS.test(text)) return "complex";
  if (OFFICE_ACTION.test(text)) return "standard";

  return undefined;
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
  const office = officeComplexity(input.text);

  const isMediaRequest =
    (input.generation !== undefined && input.generation.mode !== "auto") ||
    (!office && MEDIA_KEYWORDS.test(input.text));

  if (isMediaRequest) {
    return {
      complexity: "standard",
      model: env.MODEL_MAIN,
      reasoning: env.REASONING_DEFAULT,
      maxTokens: maxTokensWithMediaBudget(env.MAX_OUTPUT_TOKENS, input),
    };
  }

  const isCodingRequest =
    /\b(?:coding|kode|code|fungsi|function|debug(?:ging)?|refactor|stack\s?trace|typescript|javascript|tsx|jsx|react|express|mongoose|mongodb|sql|api|endpoint|middleware|regex|dockerfile|typeerror|referenceerror|syntaxerror|ts\d{4})\b/i.test(
      input.text,
    );

  const isSimple =
    !office &&
    !isCodingRequest &&
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
    office === "complex" ||
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
