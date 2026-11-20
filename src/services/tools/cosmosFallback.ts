import { env } from "../../config/env.js";
import { AppError } from "../../middleware/error.js";
import { PYTHON_VIDEO_SYSTEM_BLOCK } from "../chat/systemPrompt.js";
import { getProvider } from "../llm/provider.js";
import { getTool, errorResult, type ToolContext } from "./registry.js";

export async function renderPythonFallback(
  prompt: string,
  aspect: "16:9" | "9:16",
  ctx: ToolContext,
) {
  const python = getTool("generate_video_python");
  if (!python) {
    return errorResult(
      "MEDIA_DISABLED",
      "Renderer video Python belum tersedia.",
    );
  }

  ctx.abortSignal.throwIfAborted();

  ctx.emit("media.progress", {
    jobId: "",
    engine: "python",
    kind: "video",
    status: "queued",
    message: "Generator video sedang bermasalah. Menyiapkan versi animasi...",
  });

  let script = "";
  let finishReason: string | null = null;

  const stream = getProvider().streamCompletion({
    model: env.MODEL_MAIN,
    reasoning: "off",
    maxTokens: 6000,
    signal: ctx.abortSignal,
    messages: [
      {
        role: "system",
        content:
          PYTHON_VIDEO_SYSTEM_BLOCK +
          "\nTugasmu menulis script untuk renderer internal. " +
          "Keluarkan source Python saja tanpa Markdown atau penjelasan. " +
          "Buat versi animasi grafis yang mengikuti subjek dan gerakan user.",
      },
      {
        role: "user",
        content: JSON.stringify({ description: prompt, aspect }),
      },
    ],
  });

  for await (const chunk of stream) {
    ctx.abortSignal.throwIfAborted();
    if (chunk.content) script += chunk.content;
    if (chunk.finishReason) finishReason = chunk.finishReason;

    if (Buffer.byteLength(script, "utf8") > 20_000) {
      throw new AppError(
        "PROVIDER_ERROR",
        502,
        "Script animasi terlalu panjang.",
      );
    }
  }

  script = script.trim();
  const fenced = /^```(?:python|py)?\s*\n([\s\S]*?)\n```\s*$/i.exec(script);
  if (fenced) script = fenced[1].trim();

  if (!script || finishReason === "length") {
    return errorResult(
      "PROVIDER_ERROR",
      "Script animasi belum selesai dibuat.",
    );
  }

  ctx.abortSignal.throwIfAborted();

  return python.run(
    { script, aspect_ratio: aspect, duration_seconds: 4, fps: 24 },
    {
      ...ctx,
      generation: {
        ...ctx.generation,
        videoEngine: "python",
        allowedMediaTools: new Set(["generate_video_python"]),
      },
    },
  );
}
