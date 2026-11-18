// src/services/chat/styleProfile.ts

export interface StyleProfile {
  tone: "serious" | "casual" | "playful";
  formality: "formal" | "neutral" | "informal";
  pronouns: "gw-lu" | "aku-kamu" | "saya-anda" | "none";
  usesSlang: boolean;
  usesEmoji: boolean;
  length: "short" | "medium" | "long";
  language: "id" | "en" | "mixed";
}

export interface StyleDetection {
  profile: StyleProfile;
  /** 0-1 seberapa kuat sinyal yang terdeteksi. */
  confidence: number;
  slangRate: number;
  emojiRate: number;
  sensitiveTopic: boolean;
}

export interface PersistedStyleProfile {
  tone: StyleProfile["tone"];
  formality: StyleProfile["formality"];
  pronouns: StyleProfile["pronouns"];
  slangRate: number;
  emojiRate: number;
  length: StyleProfile["length"];
  language: StyleProfile["language"];
  confidence: number;
  sampleCount: number;
  lastUpdated?: Date;
}

export interface ExplicitStyleHint {
  tone?: StyleProfile["tone"];
  formality?: StyleProfile["formality"];
  pronouns?: StyleProfile["pronouns"];
  length?: StyleProfile["length"];
  language?: StyleProfile["language"];
}

export interface StyleProfileUpdateInput {
  recentUserTexts: string[];
  persisted?: PersistedStyleProfile;
}

const DEFAULT_PROFILE: StyleProfile = {
  tone: "casual",
  formality: "neutral",
  pronouns: "none",
  usesSlang: false,
  usesEmoji: false,
  length: "medium",
  language: "id",
};

const MAX_SAMPLES = 20;
const MIN_STYLE_MSG_LEN = 8;
const MIN_CONFIDENCE_TO_SAMPLE = 0.15;

const HUMOR_PATTERNS = [
  /wkwk/i,
  /haha/i,
  /hehe/i,
  /lol/i,
  /lmao/i,
  /😂/,
  /🤣/,
  /😅/,
];

const SLANG_WORDS = [
  "gw",
  "gue",
  "lu",
  "lo",
  "bgt",
  "banget",
  "dong",
  "sih",
  "nih",
  "aja",
  "gak",
  "nggak",
  "btw",
  "fr",
  "cuy",
  "anjir",
  "jir",
  "gas",
  "yuk",
];

const FORMAL_WORDS = [
  "mohon",
  "bapak",
  "ibu",
  "saya",
  "anda",
  "dengan hormat",
  "silakan",
  "terima kasih",
  "mohon maaf",
  "apakah",
  "bagaimana",
];

const EMOJI_REGEX =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

const SENSITIVE_TOPIC_PATTERNS = [
  // Kesehatan
  /\b(kesehatan|sakit|penyakit|medis|dokter|rumah sakit|diagnosa|gejala|obat|resep)\b/i,
  // Hukum
  /\b(hukum|pengacara|polisi|pidana|perdata|gugatan|tuntutan|pasal)\b/i,
  // Keuangan
  /\b(keuangan pribadi|utang|pinjol|pinjaman online|investasi|saham|crypto|kripto|forex|trading|bangkrut|gagal bayar)\b/i,
  // Emosional
  /\b(duka|meninggal|kematian|berkabung|pemakaman|depresi|bunuh diri|self.?harm|panik attack|kecemasan berat)\b/i,
  // Produksi / keamanan
  /\b(error produksi|server down|outage|kebocoran data|data breach|di.?hack|ransomware|phishing|insiden keamanan|production (error|down|incident))\b/i,
  // Darurat
  /\b(darurat|urgent|emergency|kecelakaan|bencana|gempa|banjir|kebakaran)\b/i,
];

const ID_STOPWORDS = [
  "yang",
  "dan",
  "di",
  "ke",
  "dari",
  "untuk",
  "dengan",
  "ini",
  "itu",
  "adalah",
  "apa",
  "bagaimana",
  "tolong",
  "buat",
  "saya",
  "kamu",
  "aku",
  "tidak",
  "sudah",
  "belum",
  "bisa",
  "mau",
];

const EN_STOPWORDS = [
  "the",
  "and",
  "to",
  "of",
  "in",
  "for",
  "with",
  "this",
  "that",
  "is",
  "what",
  "how",
  "please",
  "make",
  "you",
  "we",
  "not",
  "yes",
  "can",
  "want",
  "need",
  "have",
  "will",
];

function isSensitiveTopic(text: string): boolean {
  return SENSITIVE_TOPIC_PATTERNS.some((p) => p.test(text));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRegex(word: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
}

function countMatches(lower: string, words: string[]): number {
  let count = 0;
  for (const w of words) {
    if (wordRegex(w).test(lower)) count++;
  }
  return count;
}

export function detectStyle(userMessages: string[]): StyleDetection {
  if (userMessages.length === 0) {
    return {
      profile: DEFAULT_PROFILE,
      confidence: 0,
      slangRate: 0,
      emojiRate: 0,
      sensitiveTopic: false,
    };
  }

  const recentMessages = userMessages.slice(-6);
  const lastMessage = recentMessages[recentMessages.length - 1];
  const sensitiveTopic = isSensitiveTopic(lastMessage);

  let totalWeight = 0;
  let slangWeight = 0;
  let formalWeight = 0;
  let humorWeight = 0;
  let emojiWeight = 0;
  let totalLength = 0;
  let lengthWeight = 0;
  let gwLuCount = 0;
  let akuKamuCount = 0;
  let sayaAndaCount = 0;
  let idScore = 0;
  let enScore = 0;

  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const lower = msg.toLowerCase();
    const isLast = i === recentMessages.length - 1;
    let weight = isLast ? 2 : 1;
    if (msg.trim().length < MIN_STYLE_MSG_LEN) weight *= 0.5;
    totalWeight += weight;

    totalLength += msg.length;
    lengthWeight += weight;

    if (HUMOR_PATTERNS.some((p) => p.test(lower))) humorWeight += weight;
    if (EMOJI_REGEX.test(msg)) emojiWeight += weight;

    const slangHits = countMatches(lower, SLANG_WORDS);
    if (slangHits > 0) slangWeight += weight * Math.min(1, slangHits / 2);

    const formalHits = countMatches(lower, FORMAL_WORDS);
    if (formalHits > 0) formalWeight += weight * Math.min(1, formalHits / 2);

    if (/\b(gw|gue|lu|lo)\b/i.test(lower)) gwLuCount += weight;
    if (/\b(aku|kamu)\b/i.test(lower)) akuKamuCount += weight;
    if (/\b(saya|anda)\b/i.test(lower)) sayaAndaCount += weight;

    for (const w of ID_STOPWORDS) {
      if (wordRegex(w).test(lower)) idScore++;
    }
    for (const w of EN_STOPWORDS) {
      if (wordRegex(w).test(lower)) enScore++;
    }
  }

  const safeWeight = totalWeight > 0 ? totalWeight : 1;
  const slangRate = Math.min(1, slangWeight / safeWeight);
  const emojiRate = Math.min(1, emojiWeight / safeWeight);
  const humorRate = Math.min(1, humorWeight / safeWeight);
  const formalRate = Math.min(1, formalWeight / safeWeight);

  const avgLength = lengthWeight > 0 ? totalLength / lengthWeight : 0;
  const length: StyleProfile["length"] =
    avgLength > 150 ? "long" : avgLength < 40 ? "short" : "medium";

  let formality: StyleProfile["formality"] = "neutral";
  if (formalRate > slangRate + 0.15) formality = "formal";
  else if (slangRate > formalRate + 0.15) formality = "informal";

  let pronouns: StyleProfile["pronouns"] = "none";
  if (gwLuCount > akuKamuCount && gwLuCount > sayaAndaCount) pronouns = "gw-lu";
  else if (akuKamuCount > gwLuCount && akuKamuCount > sayaAndaCount)
    pronouns = "aku-kamu";
  else if (sayaAndaCount > 0) pronouns = "saya-anda";

  let tone: StyleProfile["tone"] = "casual";
  if (humorRate >= 0.3 || (humorRate > 0 && emojiRate > 0.2)) {
    tone = "playful";
  } else if (
    formality === "formal" ||
    (length === "long" && formality !== "informal" && slangRate < 0.3)
  ) {
    tone = "serious";
  }

  if (sensitiveTopic) tone = "serious";

  let language: StyleProfile["language"] = "id";
  if (idScore > enScore * 1.2) language = "id";
  else if (enScore > idScore * 1.2) language = "en";
  else if (idScore === 0 && enScore === 0) language = "mixed";
  else language = "mixed";

  const signalScore =
    (slangRate > 0 ? 1 : 0) +
    (formalRate > 0 ? 1 : 0) +
    (humorRate > 0 ? 1 : 0) +
    (emojiRate > 0 ? 1 : 0) +
    (language !== "mixed" ? 1 : 0) +
    (length !== "medium" ? 1 : 0);
  const messageFactor = Math.min(1, recentMessages.length / 3);
  const confidence = Math.min(1, (signalScore / 6) * messageFactor);

  return {
    profile: {
      tone,
      formality,
      pronouns,
      usesSlang: slangRate >= 0.35,
      usesEmoji: emojiRate >= 0.3,
      length,
      language,
    },
    confidence,
    slangRate,
    emojiRate,
    sensitiveTopic,
  };
}

/** Backward compat wrapper. */
export function analyzeStyle(userMessages: string[]): StyleProfile {
  return detectStyle(userMessages).profile;
}

function mergeCategorical<T extends string>(
  persisted: T,
  incoming: T,
  samplesBefore: number,
  confidence: number,
): T {
  if (persisted === incoming) return persisted;
  if (samplesBefore < 5) return incoming;
  if (samplesBefore < 10) return confidence >= 0.5 ? incoming : persisted;
  return confidence >= 0.7 ? incoming : persisted;
}

function mergeRate(
  persisted: number,
  incoming: number,
  samplesBefore: number,
): number {
  const n = Math.min(samplesBefore, 10);
  return (persisted * n + incoming) / (n + 1);
}

export function mergeStyleProfile(
  persisted: PersistedStyleProfile | undefined,
  incoming: StyleDetection,
): PersistedStyleProfile {
  // Topik sensitif tidak boleh menggeser baseline gaya user (PRD §8.4).
  if (incoming.sensitiveTopic) {
    return (
      persisted ?? {
        ...DEFAULT_PROFILE,
        slangRate: 0,
        emojiRate: 0,
        confidence: 0,
        sampleCount: 0,
        lastUpdated: new Date(),
      }
    );
  }

  // Sinyal terlalu lemah untuk dijadikan sample.
  if (
    incoming.confidence < MIN_CONFIDENCE_TO_SAMPLE &&
    (persisted?.sampleCount ?? 0) >= 0
  ) {
    return (
      persisted ?? {
        ...DEFAULT_PROFILE,
        slangRate: 0,
        emojiRate: 0,
        confidence: 0,
        sampleCount: 0,
        lastUpdated: new Date(),
      }
    );
  }

  const samplesBefore = persisted?.sampleCount ?? 0;

  if (!persisted || samplesBefore === 0) {
    return {
      tone: incoming.profile.tone,
      formality: incoming.profile.formality,
      pronouns: incoming.profile.pronouns,
      slangRate: incoming.slangRate,
      emojiRate: incoming.emojiRate,
      length: incoming.profile.length,
      language: incoming.profile.language,
      confidence: incoming.confidence,
      sampleCount: 1,
      lastUpdated: new Date(),
    };
  }

  const nextSamples = Math.min(samplesBefore + 1, MAX_SAMPLES);

  return {
    tone: mergeCategorical(
      persisted.tone,
      incoming.profile.tone,
      samplesBefore,
      incoming.confidence,
    ),
    formality: mergeCategorical(
      persisted.formality,
      incoming.profile.formality,
      samplesBefore,
      incoming.confidence,
    ),
    pronouns: mergeCategorical(
      persisted.pronouns,
      incoming.profile.pronouns,
      samplesBefore,
      incoming.confidence,
    ),
    slangRate: mergeRate(
      persisted.slangRate,
      incoming.slangRate,
      samplesBefore,
    ),
    emojiRate: mergeRate(
      persisted.emojiRate,
      incoming.emojiRate,
      samplesBefore,
    ),
    length: mergeCategorical(
      persisted.length,
      incoming.profile.length,
      samplesBefore,
      incoming.confidence,
    ),
    language: mergeCategorical(
      persisted.language,
      incoming.profile.language,
      samplesBefore,
      incoming.confidence,
    ),
    confidence: Math.min(
      1,
      persisted.confidence * 0.75 + incoming.confidence * 0.25 + 0.02,
    ),
    sampleCount: nextSamples,
    lastUpdated: new Date(),
  };
}

export function profileToStyle(profile: PersistedStyleProfile): StyleProfile {
  return {
    tone: profile.tone,
    formality: profile.formality,
    pronouns: profile.pronouns,
    usesSlang: profile.slangRate >= 0.35,
    usesEmoji: profile.emojiRate >= 0.3,
    length: profile.length,
    language: profile.language,
  };
}

export function detectExplicitStyleHint(
  text: string,
): ExplicitStyleHint | null {
  const lower = text.toLowerCase();
  const hint: ExplicitStyleHint = {};

  if (
    /\b(jawab\s+singkat|singkat\s+aja|singkat\s+padat|keep\s+it\s+short|briefly|brief|to\s+the\s+point|ringkas(kan)?)\b/i.test(
      lower,
    )
  ) {
    hint.length = "short";
  } else if (
    /\b(jawab\s+panjang|detail(kan)?|elaborate|in\s+detail|komprehensif|lengkap(kan)?)\b/i.test(
      lower,
    )
  ) {
    hint.length = "long";
  }

  if (
    /\b(pakai|gunakan|use|switch\s+to|dalam|in)\s+bahasa\s+inggris\b/i.test(
      lower,
    ) ||
    /\b(in\s+english|reply\s+in\s+english|pakai\s+english)\b/i.test(lower)
  ) {
    hint.language = "en";
  } else if (
    /\b(pakai|gunakan|use|switch\s+to|dalam|in)\s+bahasa\s+indonesia\b/i.test(
      lower,
    ) ||
    /\b(in\s+indonesian|pakai\s+bahasa\s+indonesia)\b/i.test(lower)
  ) {
    hint.language = "id";
  }

  if (
    /\b(lebih\s+formal|be\s+more\s+formal|formal\s+saja|pakai\s+gaya\s+formal)\b/i.test(
      lower,
    )
  ) {
    hint.formality = "formal";
    hint.tone = "serious";
  } else if (
    /\b(santai\s+aja|be\s+casual|casual\s+saja|lebih\s+santai|gaya\s+santai)\b/i.test(
      lower,
    )
  ) {
    hint.formality = "informal";
    hint.tone = "casual";
  } else if (/\b(serius\s+dong|be\s+serious|serius\s+aja)\b/i.test(lower)) {
    hint.tone = "serious";
  }

  if (/\b(pakai|gunakan|use)\s+gw[\s\-/]lu\b/i.test(lower)) {
    hint.pronouns = "gw-lu";
  } else if (/\b(pakai|gunakan|use)\s+aku[\s\-/]kamu\b/i.test(lower)) {
    hint.pronouns = "aku-kamu";
  } else if (/\b(pakai|gunakan|use)\s+saya[\s\-/]anda\b/i.test(lower)) {
    hint.pronouns = "saya-anda";
  }

  return Object.keys(hint).length > 0 ? hint : null;
}

export function computeStyleProfileUpdate(
  input: StyleProfileUpdateInput,
): PersistedStyleProfile {
  const detection = detectStyle(input.recentUserTexts);
  return mergeStyleProfile(input.persisted, detection);
}
