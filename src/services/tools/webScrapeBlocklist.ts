// src/services/tools/webScrapeBlocklist.ts

/**
 * Konfigurasi blokir konten untuk web_scrape.
 * Edit daftar di bawah ini jika ada domain/kata kunci baru yang perlu diblokir.
 */

// Domain yang langsung diblokir (judol, togel, pinjol, dll)
export const BLOCKED_DOMAINS = [
  "judol",
  "togel",
  "slot",
  "gacor",
  "maxwin",
  "rtp",
  "bandar",
  "casino",
  "poker",
  "taruhan",
  "sportsbook",
  "betting",
  "bet",
  "pinjol",
  "pinjaman-online",
  "trading",
  "forex",
  "binary",
  "crypto-exchange",
  "mlm",
  "money-game",
  "paid-to-click",
  "ptc",
];

// Kata kunci di URL (path atau query) yang langsung diblokir
export const BLOCKED_URL_KEYWORDS = [
  "deposit",
  "withdraw",
  "login-slot",
  "daftar-slot",
  "link-alternatif",
  "judi-online",
  "bandar-togel",
  "agen-judi",
  "situs-judi",
  "bonus-new-member",
  "pinjaman-cepat",
  "pinjol-resmi",
  "investasi-bodong",
  "robot-trading",
  "sinyal-forex",
  "binary-option",
];

// Kata kunci di <title> atau meta description
export const BLOCKED_TITLE_KEYWORDS = [
  "judi",
  "togel",
  "slot gacor",
  "maxwin",
  "rtp slot",
  "situs judi",
  "bandar togel",
  "agen slot",
  "pinjol",
  "pinjaman online",
  "trading forex",
  "binary option",
  "investasi cepat",
  "skema piramida",
  "money game",
];

// Frasa di dalam konten. Skor akan bertambah jika ketemu frasa ini.
export const BLOCKED_CONTENT_PHRASES = [
  "link alternatif",
  "situs resmi",
  "bonus new member",
  "deposit pulsa",
  "minimal deposit",
  "maxwin hari ini",
  "rtp live",
  "pola gacor",
  "pinjaman cair",
  "bunga rendah",
  "tanpa jaminan",
  "robot trading",
  "profit konsisten",
  "sinyal forex",
  "binary option",
  "skema ponzi",
  "money game",
  "komisi referral",
  "passive income",
];

export function checkDomain(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return BLOCKED_DOMAINS.some((d) => h.includes(d));
}

export function checkUrlPath(urlStr: string): boolean {
  const u = urlStr.toLowerCase();
  return BLOCKED_URL_KEYWORDS.some((k) => u.includes(k));
}

export function checkTitle(title: string): boolean {
  const t = title.toLowerCase();
  return BLOCKED_TITLE_KEYWORDS.some((k) => t.includes(k));
}

export function checkContentScore(text: string): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const phrase of BLOCKED_CONTENT_PHRASES) {
    if (t.includes(phrase)) score += 1;
  }
  return score;
}
