// src/services/generation/mediaErrors.ts

/**
 * Pesan ramah per kode error media (§14.4): tool mengembalikan
 * `{ code, userMessage }` dan model diinstruksikan menyampaikan
 * `userMessage` apa adanya — tidak menebak penyebab, tidak menawarkan
 * cara menembus gembok.
 */
const USER_MESSAGES: Record<string, string> = {
  MEDIA_DISABLED: "Fitur media sedang dinonaktifkan sementara.",
  ENTITLEMENT_REQUIRED:
    "Model ini terbuka setelah traktir kopi di Ko-fi (opsional).",
  INSUFFICIENT_CREDITS:
    "Kredit generate-mu habis. Donasi lagi untuk menambah kredit.",
  RATE_LIMITED: "Kuota generate tercapai. Coba lagi nanti.",
  GENERATION_BUSY:
    "Masih ada proses generate yang berjalan. Tunggu sampai selesai.",
  PROVIDER_REFUSED:
    "Prompt ditolak oleh filter keamanan model. Coba ubah prompt-nya.",
  PROVIDER_ERROR:
    "Provider generate sedang bermasalah. Coba lagi sebentar lagi.",
  JOB_TIMEOUT: "Waktu generate habis sebelum selesai. Coba lagi ya.",
  INVALID_PARAMS: "Parameter generate tidak valid.",
};

export function mediaUserMessage(code: string, fallback: string): string {
  return USER_MESSAGES[code] ?? fallback;
}
