// src/middleware/error.ts

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(msg = "Bad request", details?: unknown): AppError {
    return new AppError("BAD_REQUEST", 400, msg, details);
  }

  static invalidParams(
    msg = "Parameter tidak valid",
    details?: unknown,
  ): AppError {
    return new AppError("INVALID_PARAMS", 400, msg, details);
  }

  static unauthorized(msg = "Unauthorized"): AppError {
    return new AppError("UNAUTHORIZED", 401, msg);
  }

  static forbidden(msg = "Forbidden"): AppError {
    return new AppError("FORBIDDEN", 403, msg);
  }

  static entitlementRequired(
    msg = "Model ini terbuka setelah donasi (opsional)",
  ): AppError {
    return new AppError("ENTITLEMENT_REQUIRED", 403, msg);
  }

  static insufficientCredits(msg = "Kredit tidak cukup"): AppError {
    return new AppError("INSUFFICIENT_CREDITS", 402, msg);
  }

  static notFound(msg = "Not found"): AppError {
    return new AppError("NOT_FOUND", 404, msg);
  }

  static claimNotFound(
    msg = "Klaim donasi tidak ditemukan. Periksa email dan ID transaksi.",
  ): AppError {
    return new AppError("CLAIM_NOT_FOUND", 404, msg);
  }

  static conflict(msg = "Conflict"): AppError {
    return new AppError("CONFLICT", 409, msg);
  }

  static generationBusy(
    msg = "Masih ada proses generate yang berjalan. Tunggu sampai selesai.",
  ): AppError {
    return new AppError("GENERATION_BUSY", 409, msg);
  }

  static assetExpired(msg = "Media sudah kedaluwarsa"): AppError {
    return new AppError("ASSET_EXPIRED", 410, msg);
  }

  static providerRefused(
    msg = "Permintaan ditolak filter keamanan provider",
  ): AppError {
    return new AppError("PROVIDER_REFUSED", 422, msg);
  }

  static providerError(msg = "Provider error"): AppError {
    return new AppError("PROVIDER_ERROR", 502, msg);
  }

  static mediaDisabled(
    msg = "Fitur media sedang dinonaktifkan sementara",
  ): AppError {
    return new AppError("MEDIA_DISABLED", 503, msg);
  }

  static rateLimited(
    msg = "Terlalu banyak permintaan, coba lagi nanti",
  ): AppError {
    return new AppError("RATE_LIMITED", 429, msg);
  }

  static jobTimeout(msg = "Proses generate melewati batas waktu"): AppError {
    return new AppError("JOB_TIMEOUT", 504, msg);
  }
}
