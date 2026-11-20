import { env } from "../../../config/env.js";
import { AppError } from "../../../middleware/error.js";

interface FalEditOutput {
  images?: Array<{ url?: string }>;
  has_nsfw_concepts?: boolean[];
}

export async function editFlux2Image(
  prompt: string,
  imageUrls: readonly string[],
  size: { width: number; height: number },
  signal: AbortSignal,
): Promise<{ b64_json: string }> {
  const key = process.env.FAL_KEY?.trim();

  if (!key) {
    throw new AppError(
      "IMAGE_EDIT_UNAVAILABLE",
      503,
      "Edit gambar upload belum aktif di server ini.",
    );
  }

  if (imageUrls.length < 1 || imageUrls.length > 4) {
    throw new AppError(
      "IMAGE_REFERENCE_LIMIT",
      400,
      "Edit gambar membutuhkan 1 sampai 4 gambar referensi.",
    );
  }

  const timeout = AbortSignal.timeout(env.IMAGE_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);

  try {
    const response = await fetch(
      "https://fal.run/fal-ai/flux-2/klein/4b/edit",
      {
        method: "POST",
        headers: {
          Authorization: `Key ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          image_urls: imageUrls,
          image_size: size,
          num_images: 1,
          output_format: "png",
          sync_mode: true,
          enable_safety_checker: true,
        }),
        signal: combined,
      },
    );

    if (!response.ok) {
      if (response.status === 422) {
        throw new AppError(
          "IMAGE_EDIT_REJECTED",
          422,
          "Provider tidak dapat memproses instruksi atau gambar referensi ini.",
        );
      }
      throw new AppError("PROVIDER_ERROR", 502, "Provider edit gambar gagal.");
    }

    const result = (await response.json()) as FalEditOutput;

    if (result.has_nsfw_concepts?.some(Boolean)) {
      throw new AppError(
        "PROVIDER_REFUSED",
        422,
        "Hasil ditolak oleh provider.",
      );
    }

    const url = result.images?.[0]?.url;
    const prefix = "data:image/png;base64,";
    if (!url?.startsWith(prefix) || url.length <= prefix.length) {
      throw new AppError(
        "PROVIDER_ERROR",
        502,
        "Hasil edit gambar tidak valid.",
      );
    }

    return { b64_json: url.slice(prefix.length) };
  } catch (err) {
    if (signal.aborted) throw err;
    if (timeout.aborted) {
      throw new AppError("JOB_TIMEOUT", 504, "Waktu edit gambar habis.");
    }
    throw err;
  }
}
