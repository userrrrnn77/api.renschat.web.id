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

const HUMOR_PATTERNS = [/wkwk/i, /haha/i, /hehe/i, /lol/i, /lmao/i, /😂/, /🤣/];
const SLANG_WORDS = [
  "gw",
  "lu",
  "gue",
  "lo",
  "bgt",
  "dong",
  "sih",
  "nih",
  "aja",
  "gak",
  "btw",
  "fr",
  "anjir",
  "jir",
  "cuy",
];
const FORMAL_WORDS = [
  "mohon",
  "bapak",
  "ibu",
  "saya",
  "anda",
  "dengan hormat",
  "silakan",
];
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

const SENSITIVE_TOPICS = [
  "kesehatan",
  "sakit",
  "penyakit",
  "medis",
  "dokter",
  "rumah sakit",
  "hukum",
  "pengacara",
  "polisi",
  "pidana",
  "perdata",
  "gugatan",
  "keuangan pribadi",
  "utang",
  "pinjol",
  "investasi",
  "saham",
  "crypto",
  "duka",
  "meninggal",
  "kematian",
  "berkabung",
  "error produksi",
  "server down",
  "kebocoran data",
  "hack",
];

export function analyzeStyle(userMessages: string[]): StyleProfile {
  if (userMessages.length === 0) {
    return {
      tone: "casual",
      formality: "neutral",
      pronouns: "none",
      usesSlang: false,
      usesEmoji: false,
      length: "medium",
      language: "id",
    };
  }

  let humorCount = 0;
  let slangCount = 0;
  let formalCount = 0;
  let emojiCount = 0;
  let totalLength = 0;
  let gwLuCount = 0;
  let akuKamuCount = 0;
  let sayaAndaCount = 0;

  const recentMessages = userMessages.slice(-6);
  const lastMessage = recentMessages[recentMessages.length - 1].toLowerCase();

  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const lower = msg.toLowerCase();
    const weight = i === recentMessages.length - 1 ? 2 : 1;
    totalLength += msg.length;

    if (HUMOR_PATTERNS.some((p) => p.test(lower))) humorCount += weight;
    if (EMOJI_REGEX.test(msg)) emojiCount += weight;

    let hasSlang = false;
    for (const s of SLANG_WORDS) {
      if (new RegExp(`\\b${s}\\b`, "i").test(lower)) hasSlang = true;
    }
    if (hasSlang) slangCount += weight;

    let hasFormal = false;
    for (const f of FORMAL_WORDS) {
      if (lower.includes(f)) hasFormal = true;
    }
    if (hasFormal) formalCount += weight;

    if (/\b(gw|gue|lu|lo)\b/i.test(lower)) gwLuCount += weight;
    if (/\b(aku|kamu)\b/i.test(lower)) akuKamuCount += weight;
    if (/\b(saya|anda)\b/i.test(lower)) sayaAndaCount += weight;
  }

  const avgLength = totalLength / recentMessages.length;
  const length = avgLength > 150 ? "long" : avgLength < 40 ? "short" : "medium";

  let formality: StyleProfile["formality"] = "neutral";
  if (formalCount > slangCount) formality = "formal";
  else if (slangCount > formalCount) formality = "informal";

  let pronouns: StyleProfile["pronouns"] = "none";
  if (gwLuCount > akuKamuCount && gwLuCount > sayaAndaCount) pronouns = "gw-lu";
  else if (akuKamuCount > gwLuCount && akuKamuCount > sayaAndaCount)
    pronouns = "aku-kamu";
  else if (sayaAndaCount > 0) pronouns = "saya-anda";

  let tone: StyleProfile["tone"] = "casual";
  if (
    humorCount >= 2 ||
    (humorCount >= 1 &&
      EMOJI_REGEX.test(recentMessages[recentMessages.length - 1]))
  ) {
    tone = "playful";
  } else if (
    formality === "formal" ||
    (length === "long" && formality !== "informal")
  ) {
    tone = "serious";
  }

  // Sensitive topic override
  if (SENSITIVE_TOPICS.some((t) => lastMessage.includes(t))) {
    tone = "serious";
  }

  const usesSlang = slangCount > 0;
  const usesEmoji = emojiCount > 0;

  let language: StyleProfile["language"] = "id";
  const idWords = [
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
  ];
  const enWords = [
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
  ];

  let idScore = 0;
  let enScore = 0;
  for (const w of idWords)
    if (new RegExp(`\\b${w}\\b`, "i").test(lastMessage)) idScore++;
  for (const w of enWords)
    if (new RegExp(`\\b${w}\\b`, "i").test(lastMessage)) enScore++;

  if (idScore > enScore) language = "id";
  else if (enScore > idScore) language = "en";
  else language = "mixed";

  return { tone, formality, pronouns, usesSlang, usesEmoji, length, language };
}
