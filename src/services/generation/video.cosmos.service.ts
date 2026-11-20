// src/services/generation/video.cosmos.service.ts
import { Types } from "mongoose";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GenerationJobModel } from "../../models/GenerationJob.js";
import { UserModel } from "../../models/User.js";
import { AppError } from "../../middleware/error.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import {
  generateVideoCosmos,
  mapAspectToCosmosResolution,
} from "@services/llm/providers/cosmos.client.js";
import { saveGeneratedMedia } from "../tools/saveGenerated.js";

import {
  assertMediaEnabled,
  assertGlobalDailyCap,
  assertNoActiveJob,
  incrementGlobalDaily,
  withVideoSlot,
} from "./budget.service.js";

import type { GenerationPlan } from "./plan.js";

export type VideoAspect = "16:9" | "9:16";

export interface RunCosmosVideoJobContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  signal: AbortSignal;
  /** Engine/plan diputus server (§5.2); bukan argumen tool. */
  generation: GenerationPlan;
}

export interface RunCosmosVideoJobArgs {
  prompt: string;
  /** Default "16:9" bila tool tidak mengirim. */
  aspect?: VideoAspect;
}

export interface VideoCosmosResult {
  fileId: string;
  jobId: string;
  kind: "video";
  engine: "cosmos";
  aspect: VideoAspect;
  durationSec: number;
  width: number;
  height: number;
  /** ISO timestamp kedaluwarsa media (ASSET_TTL_HOURS). */
  expiresAt: string;
}

export interface RunCosmosVideoJobHooks {
  /** Dipanggil setelah job dibuat (untuk emit `media.progress`). */
  onJobCreated?: (jobId: string) => void;
}

const PROMPT_MIN = 1;
const PROMPT_MAX = 1500;
const FFMPEG_TRANSCODE_TIMEOUT_MS = 120_000;
const FFMPEG_PROBE_TIMEOUT_MS = 3_000;

/** Deteksi cepat magic MP4: bytes 4..8 = "ftyp". */
function looksLikeMp4(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return buf.toString("ascii", 4, 8) === "ftyp";
}

async function ffmpegAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, FFMPEG_PROBE_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}

async function runFfmpeg(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string }> {
  try {
    const proc = Bun.spawn(["ffmpeg", ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const stderr =
      proc.stderr instanceof ReadableStream
        ? await new Response(proc.stderr).text()
        : "";
    return { ok: exitCode === 0, stderr };
  } catch (err) {
    return {
      ok: false,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Transcode MP4 (VP9) → H.264 (§4.4, §12.1). Flag `COSMOS_TRANSCODE_H264`
 * false atau ffmpeg tidak ada → pakai MP4 asli. Watermark SynthID tidak
 * dihapus (§4.4): re-encode bisa mempengaruhi deteksi, karena itu flag bisa
 * dimatikan.
 */
export async function maybeTranscodeToH264(
  inputPath: string,
  outputPath: string,
): Promise<string> {
  if (!env.COSMOS_TRANSCODE_H264) return inputPath;
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) {
    logger.warn(
      { context: "cosmos-transcode" },
      "ffmpeg not found; using original mp4",
    );
    return inputPath;
  }

  const res = await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-crf",
      "23",
      outputPath,
    ],
    FFMPEG_TRANSCODE_TIMEOUT_MS,
  );
  if (!res.ok) {
    logger.warn(
      { stderrTail: res.stderr.slice(-500), context: "cosmos-transcode" },
      "transcode failed; using original mp4",
    );
    return inputPath;
  }
  return outputPath;
}

export async function runCosmosVideoJob(
  ctx: RunCosmosVideoJobContext,
  args: RunCosmosVideoJobArgs,
  hooks: RunCosmosVideoJobHooks = {},
): Promise<VideoCosmosResult> {
  // ── 1. Validasi (§12.1) ──
  const prompt = args.prompt.trim();
  if (prompt.length < PROMPT_MIN || prompt.length > PROMPT_MAX) {
    throw new AppError(
      "INVALID_PARAMS",
      400,
      `Prompt harus 1-${PROMPT_MAX} karakter.`,
    );
  }
  const aspect: VideoAspect = args.aspect === "9:16" ? "9:16" : "16:9";

  // ── 2. Kill switch (§8.4) ──
  assertMediaEnabled();

  if (!(await UserModel.exists({ _id: ctx.userId }))) {
    throw AppError.notFound();
  }

  await assertGlobalDailyCap("cosmos");
  await assertNoActiveJob(ctx.userId);

  // ── 4. Job + konsumsi kredit atomik (§12.2) ──
  const startMs = Date.now();
  const now = new Date();
  const job = await GenerationJobModel.create({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
    kind: "video",
    engine: "cosmos",
    status: "running",
    params: {
      aspect,
      resolution: mapAspectToCosmosResolution(aspect),
      numFrames: env.COSMOS_NUM_FRAMES,
    },
    creditCost: { imageFlux3: 0, videoCosmos: 0 },
    attempts: 1,
    queuedAt: now,
    startedAt: now,
  });
  const jobIdStr = job._id.toString();

  hooks.onJobCreated?.(jobIdStr);

  const finishFailed = async (code: string, message: string): Promise<void> => {
    await GenerationJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: ctx.signal.aborted ? "cancelled" : "failed",
          error: { code, message },
          finishedAt: new Date(),
        },
      },
    );
  };

  try {
    // ── 5. Provider call dalam slot semaphore global video (§8.3) ──
    const output = await withVideoSlot(
      () => generateVideoCosmos({ prompt, aspect }, ctx.signal),
      ctx.signal,
    );

    const originalBuf = Buffer.from(output.b64_video, "base64");
    if (originalBuf.length === 0) {
      throw new AppError(
        "PROVIDER_ERROR",
        502,
        "Provider mengirim video kosong.",
      );
    }

    // ── 6. Transcode opsional (file temp; dibersihkan di finally) ──
    let finalBuf = originalBuf;
    let workDir: string | null = null;
    try {
      workDir = await mkdtemp(join(tmpdir(), "cosmos-"));
      const inputPath = join(workDir, "in.mp4");
      const outputPath = join(workDir, "out.mp4");
      await writeFile(inputPath, originalBuf);

      const selectedPath = await maybeTranscodeToH264(inputPath, outputPath);
      finalBuf = await readFile(selectedPath);
      if (finalBuf.length === 0) {
        throw new AppError(
          "PROVIDER_ERROR",
          502,
          "Video kosong setelah transcode.",
        );
      }
    } finally {
      if (workDir !== null) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (!looksLikeMp4(finalBuf)) {
      throw new AppError(
        "PROVIDER_ERROR",
        502,
        "Provider mengirim video dengan format tidak dikenali.",
      );
    }

    // ── 7. Upload R2 → FileDoc (§10.1, sebelum Block ke FE) ──
    const name = `video-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`;
    const saved = await saveGeneratedMedia({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      name,
      kind: "video",
      aspect,
      engine: "cosmos",
      model: "nvidia/cosmos3-nano",
      width: output.width,
      height: output.height,
      durationSec: output.durationSec,
      buf: finalBuf,
    });

    // ── 8. Sukses: job succeeded + counter global (§12.2) ──
    await GenerationJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "succeeded",
          fileId: new Types.ObjectId(saved.fileId),
          finishedAt: new Date(),
        },
      },
    );
    await incrementGlobalDaily("cosmos");

    logger.info(
      {
        jobId: jobIdStr,
        userId: ctx.userId.toString(),
        engine: "cosmos",
        status: "succeeded",
        durationMs: Date.now() - startMs,
        refunded: false,
      },
      "cosmos job finished",
    );

    return {
      fileId: saved.fileId,
      jobId: jobIdStr,
      kind: "video",
      engine: "cosmos",
      aspect,
      durationSec: output.durationSec,
      width: output.width,
      height: output.height,
      expiresAt: saved.expiresAt.toISOString(),
    };
  } catch (err) {
    const code = err instanceof AppError ? err.code : "PROVIDER_ERROR";
    const message =
      err instanceof Error ? err.message : "Cosmos video generation failed";

    await finishFailed(code, message).catch((statusErr) => {
      logger.error(
        { err: statusErr, jobId: jobIdStr },
        "Failed to update Cosmos job status",
      );
    });

    logger.info(
      {
        jobId: jobIdStr,
        userId: ctx.userId.toString(),
        engine: "cosmos",
        status: ctx.signal.aborted ? "cancelled" : "failed",
        durationMs: Date.now() - startMs,
        errorCode: code,
        refunded: false,
      },
      "cosmos job finished",
    );

    throw err;
  }
}
