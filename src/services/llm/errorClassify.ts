// src/services/llm/errorClassify.ts

import { UpstreamError } from "./nvidiaClient.js";

export type PublicErrorCode =
  | "PROVIDER_ERROR"
  | "PROVIDER_REFUSED"
  | "STREAM_ERROR"
  | "JOB_TIMEOUT"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR";

export interface ClassifiedError {
  code: PublicErrorCode;
  message: string;
}

/**
 * Klasifikasi tunggal untuk semua error dari agent loop / provider.
 * Tidak pernah menyalin status internal, URL provider, body, atau stack.
 * Detail lengkap tetap dicatat di log pemanggil.
 */
export function classifyProviderError(err: unknown): ClassifiedError {
  if (err instanceof UpstreamError) {
    if (err.status === 429) {
      return {
        code: "RATE_LIMITED",
        message: "Penyedia AI sedang sibuk. Coba lagi beberapa menit lagi.",
      };
    }
    if (err.status === 401 || err.status === 403) {
      return {
        code: "PROVIDER_ERROR",
        message: "Penyedia AI sedang tidak dapat diakses. Coba lagi nanti.",
      };
    }
    if (err.status === 422) {
      return {
        code: "PROVIDER_REFUSED",
        message: "Permintaanmu ditolak oleh penyedia AI. Coba ubah permintaan.",
      };
    }
    if (err.status >= 500) {
      return {
        code: "PROVIDER_ERROR",
        message: "Penyedia AI sedang bermasalah. Coba lagi beberapa saat lagi.",
      };
    }
    return {
      code: "PROVIDER_ERROR",
      message: "Terjadi kesalahan pada penyedia AI. Coba lagi.",
    };
  }

  const msg = err instanceof Error ? err.message : String(err);

  if (/timeout|timed out/i.test(msg)) {
    return {
      code: "JOB_TIMEOUT",
      message: "Proses membutuhkan waktu lebih lama dari biasanya. Coba lagi.",
    };
  }
  if (/abort/i.test(msg)) {
    return {
      code: "UNKNOWN_ERROR",
      message: "Permintaan dibatalkan.",
    };
  }
  if (
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(
      msg,
    )
  ) {
    return {
      code: "NETWORK_ERROR",
      message: "Koneksi ke penyedia AI terputus. Silakan coba kembali.",
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: "Terjadi kesalahan saat memproses permintaan.",
  };
}
