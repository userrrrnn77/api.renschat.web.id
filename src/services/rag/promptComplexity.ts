// src/services/rag/promptComplexity.ts

export type PromptComplexity = "simple" | "medium" | "complex";

export interface ComplexityInput {
  text: string;
  attachmentIds: string[];
}

export interface ComplexityResult {
  category: PromptComplexity;
  reasons: string[];
}

export interface RetrievalDecisionInput {
  complexity: PromptComplexity;
  files: Array<{ _id: unknown; status: string }>;
  attachmentIds: string[];
  enabled: boolean;
}

export interface RetrievalDecision {
  needsRetrieval: boolean;
  needsEmbedding: boolean;
}

// Pure ack/greeting — tidak butuh retrieval apa pun.
const SIMPLE_ACK_PATTERNS = [
  /^\s*(hai|halo|hello|hi|hey|yo|oi|woy)\b[\s,.!?]*$/i,
  /^\s*(selamat\s+(pagi|siang|sore|malam))\b[\s,.!?]*$/i,
  /^\s*(terima kasih|makasih|thanks|thank you|tq|thx)\b[\s,.!?]*$/i,
  /^\s*(oke?|sip|siap|mantap|mantul|good|nice|great|alright|nice)\b[\s,.!?]*$/i,
  /^\s*(p|ping|test)\b[\s,.!?]*$/i,
];

// Simple arithmetic tanpa kata kunci dokumen.
const SIMPLE_CALC_PATTERN =
  /^\s*(berapa|hitung|kalkulasi|what is|what's|calculate|compute|how much is)\s+[\d\s+\-*/×÷x().,^%]+\s*\??\s*$/i;

// Explicit doc reference (ID + EN).
const DOC_REF_PATTERNS = [
  /\b(dokumen|file|berkas|lampiran|pdf|docx|xlsx|excel|csv)\b/i,
  /\b(document|attachment|uploaded file|the file|the document|the pdf|the spreadsheet)\b/i,
  /\b(dari|di dalam|isi|content of|inside)\s+(?:dokumen|file|berkas|pdf|lampiran)\b/i,
];

// Verb yang menandakan analisis/transformasi dokumen.
const ANALYSIS_VERB_PATTERNS = [
  /\b(baca|lihat|periksa|cek|telusuri|analisa|analisis|rangkum|ringkas|ringkasan|bandingkan|bandingin|ekstrak|gali|temukan|cari (?:di|dari|dalam))\b/i,
  /\b(read|analyze|analyse|summari[sz]e|compare|extract|find in|search in|look into)\b/i,
  /\b(jelaskan|explain|uraikan|describe)\b/i,
];

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function classifyPromptComplexity(
  input: ComplexityInput,
): ComplexityResult {
  const text = (input.text ?? "").trim();
  if (!text) {
    return { category: "simple", reasons: ["empty"] };
  }

  if (hasAny(text, SIMPLE_ACK_PATTERNS)) {
    return { category: "simple", reasons: ["ack_or_greeting"] };
  }

  if (SIMPLE_CALC_PATTERN.test(text)) {
    return { category: "simple", reasons: ["simple_calc"] };
  }

  const hasDocRef = hasAny(text, DOC_REF_PATTERNS);
  const hasAnalysisVerb = hasAny(text, ANALYSIS_VERB_PATTERNS);
  const isLong = text.length >= 300;
  const hasQuestionMark = text.includes("?");

  // Explicit doc ref + (verb analisis / long) → complex.
  if (hasDocRef && (hasAnalysisVerb || isLong)) {
    return {
      category: "complex",
      reasons: ["doc_ref", hasAnalysisVerb ? "analysis_verb" : "long_text"],
    };
  }

  // Explicit doc ref saja → medium.
  if (hasDocRef) {
    return { category: "medium", reasons: ["doc_ref"] };
  }

  // Analysis verb tanpa doc ref (mis. "rangkum percakapan kita") → complex.
  // Retrieval akan tetap gated oleh file availability di decideRetrieval().
  if (hasAnalysisVerb) {
    return { category: "complex", reasons: ["analysis_verb_no_doc_ref"] };
  }

  if (isLong) {
    return { category: "complex", reasons: ["long_text"] };
  }

  if (hasQuestionMark && text.length >= 20) {
    return { category: "medium", reasons: ["question"] };
  }

  return { category: "simple", reasons: ["conversational"] };
}

export function decideRetrieval(
  input: RetrievalDecisionInput,
): RetrievalDecision {
  if (!input.enabled) {
    return { needsRetrieval: false, needsEmbedding: false };
  }

  const inlined = new Set(input.attachmentIds);
  const available = input.files.some(
    (f) => f.status === "ready" && !inlined.has(String(f._id)),
  );
  if (!available) {
    return { needsRetrieval: false, needsEmbedding: false };
  }

  switch (input.complexity) {
    case "simple":
      return { needsRetrieval: false, needsEmbedding: false };
    case "medium":
      // Text-only: murah, tanpa embedding.
      return { needsRetrieval: true, needsEmbedding: false };
    case "complex":
      return { needsRetrieval: true, needsEmbedding: true };
  }
}
