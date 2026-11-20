// src/services/generation/video.python.service.ts
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Types } from "mongoose";
import { GenerationJobModel } from "../../models/GenerationJob.js";
import { UserModel } from "../../models/User.js";
import { AppError } from "../../middleware/error.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { saveGeneratedMedia } from "../tools/saveGenerated.js";
import {
  assertMediaEnabled,
  assertGlobalDailyCap,
  assertNoActiveJob,
  assertUserDailyLimit,
  incrementGlobalDaily,
  incrementUserUsage,
  withVideoSlot,
} from "./budget.service.js";
import { getSandboxRunner } from "./sandbox/sandbox.types.js";
import type { GenerationPlan } from "./plan.js";

export type VideoAspect = "16:9" | "9:16";

export interface RunPythonVideoContext {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  signal: AbortSignal;
  /** Engine/plan diputus server (§5.2); bukan argumen tool. */
  generation: GenerationPlan;
}

export interface RunPythonVideoArgs {
  script: string;
  aspect?: VideoAspect;
  duration_seconds?: number;
  fps?: number;
  title?: string;
}

export interface PythonVideoSuccess {
  kind: "success";
  fileId: string;
  jobId: string;
  kindOut: "video";
  engine: "python";
  aspect: VideoAspect;
  durationSec: number;
  width: number;
  height: number;
  /** ISO timestamp kedaluwarsa media. */
  expiresAt: string;
  /** True bila hanya ≥90% frame yang berhasil, tapi tetap distitch. */
  partialFrames: boolean;
}

export interface PythonVideoRetry {
  kind: "retry";
  jobId: string;
  /** "frames" | "size" | "validate" — mengikuti §13.6. */
  stage: string;
  stderrTail: string;
}

export type RunPythonVideoResult = PythonVideoSuccess | PythonVideoRetry;

// Batas §13.4.
const SCRIPT_MIN_BYTES = 1;
const SCRIPT_MAX_BYTES = 20_000;
const FPS_MIN = 12;
const FPS_MAX = 30;
const FPS_DEFAULT = 24;
const DURATION_MIN = 2;
const DURATION_MAX = 10;
const DURATION_DEFAULT = 6;
const MAX_TOTAL_FRAMES = 240;
const MAX_MP4_BYTES = 25 * 1024 * 1024;
const MAX_ATTEMPTS_PER_MESSAGE = 3;
const STDERR_TAIL_MAX = 2000;

/** §13.3: allowlist per top-level module. */
const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  "numpy",
  "PIL",
  "scipy",
  "matplotlib",
  "math",
  "random",
  "colorsys",
  "itertools",
  "pathlib",
  "os",
  "sys",
]);

/** Deteksi cepat magic MP4: bytes 4..8 = "ftyp". */
function looksLikeMp4(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return buf.toString("ascii", 4, 8) === "ftyp";
}

/**
 * Pre-check script (§13.3): ukuran ≤20KB, import di allowlist. Ini lapisan
 * tambahan; isolasi container tetap pertahanan utama.
 */
export function validatePythonScript(
  script: string,
): { ok: true } | { ok: false; reason: string } {
  if (script.length < SCRIPT_MIN_BYTES) {
    return { ok: false, reason: "Script kosong." };
  }
  if (script.length > SCRIPT_MAX_BYTES) {
    return {
      ok: false,
      reason: `Script melebihi ${SCRIPT_MAX_BYTES} byte (${script.length}).`,
    };
  }
  const lines = script.split("\n");
  for (const raw of lines) {
    const line = raw.trimStart();
    const m = line.match(/^(?:from|import)\s+([\w.]+)/);
    if (!m) continue;
    const top = m[1].split(".")[0];
    if (!ALLOWED_IMPORTS.has(top)) {
      return { ok: false, reason: `Import tidak diizinkan: ${top}` };
    }
  }
  return { ok: true };
}

export function resolvePythonDimensions(aspect: VideoAspect): {
  width: number;
  height: number;
} {
  const low = env.PY_VIDEO_LOW_RES;
  if (aspect === "9:16") {
    return low ? { width: 480, height: 854 } : { width: 720, height: 1280 };
  }
  return low ? { width: 854, height: 480 } : { width: 1280, height: 720 };
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/**
 * Generate video via Python sandbox (§13). Tidak memotong kredit.
 *
 * Return discriminated union supaya tool bisa meneruskan stderrTail ke
 * model untuk loop perbaikan (§13.6) tanpa membuat error generic.
 * Error fatal (kill switch, entitlement, attempt limit) → throw AppError.
 */
export async function runPythonVideoJob(
  ctx: RunPythonVideoContext,
  args: RunPythonVideoArgs,
): Promise<RunPythonVideoResult> {
  // ── 1. Validasi parameter + script (§13.3/§13.4) ──
  const script = args.script;
  const check = validatePythonScript(script);
  if (!check.ok) {
    throw new AppError("INVALID_PARAMS", 400, check.reason);
  }

  const aspect: VideoAspect = args.aspect === "9:16" ? "9:16" : "16:9";
  const fps = clampInt(args.fps ?? FPS_DEFAULT, FPS_MIN, FPS_MAX);
  const duration = clampInt(
    args.duration_seconds ?? DURATION_DEFAULT,
    DURATION_MIN,
    DURATION_MAX,
  );
  const totalFrames = Math.min(MAX_TOTAL_FRAMES, fps * duration);
  const dims = resolvePythonDimensions(aspect);

  // ── 2. Attempt limit (§13.6): max 3 percobaan per messageId ──
  const attemptCount = await GenerationJobModel.countDocuments({
    messageId: ctx.messageId,
    engine: "python",
  });
  if (attemptCount >= MAX_ATTEMPTS_PER_MESSAGE) {
    throw new AppError(
      "PROVIDER_ERROR",
      502,
      "Generate video sudah dicoba beberapa kali tanpa hasil. Coba ubah permintaan atau kirim pesan baru.",
    );
  }

  // ── 3. Kill switch + budget + limit + job aktif (§8.3/§8.4) ──
  assertMediaEnabled();

  const user = (await UserModel.findById(ctx.userId)
    .select({ createdAt: 1 })
    .lean()) as { createdAt?: Date } | null;
  if (!user) throw AppError.notFound();

  await assertGlobalDailyCap("python");
  await assertUserDailyLimit(
    ctx.userId,
    "video_python",
    user.createdAt ?? undefined,
  );
  await assertNoActiveJob(ctx.userId);

  // ── 4. Job (§12.2 pola; tanpa kredit) ──
  const startMs = Date.now();
  const now = new Date();
  const job = await GenerationJobModel.create({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
    kind: "video",
    engine: "python",
    status: "running",
    params: {
      aspect,
      fps,
      duration,
      totalFrames,
      width: dims.width,
      height: dims.height,
      attempt: attemptCount + 1,
    },
    creditCost: { imageFlux3: 0, videoCosmos: 0 },
    attempts: 1,
    queuedAt: now,
    startedAt: now,
  });

  const jobId = job._id.toString();

  const markFailed = async (code: string, message: string): Promise<void> => {
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

  const workdir = join(tmpdir(), "renschat-py-video", crypto.randomUUID());

  const buildRetry = (stage: string, tail: string): PythonVideoRetry => ({
    kind: "retry",
    jobId,
    stage,
    stderrTail: tail.slice(-STDERR_TAIL_MAX),
  });

  try {
    // ── 5. Sandbox (Python + ffmpeg fixed) via semaphore global video ──
    await mkdir(workdir, { recursive: true });

    const runner = getSandboxRunner();
    const sandbox = await withVideoSlot(
      () =>
        runner.run(
          {
            script,
            width: dims.width,
            height: dims.height,
            fps,
            duration,
            totalFrames,
            workdir,
          },
          ctx.signal,
        ),
      ctx.signal,
    );

    if (ctx.signal.aborted) {
      await markFailed("CANCELLED", "Aborted by client");
      logger.info(
        {
          jobId,
          userId: ctx.userId.toString(),
          engine: "python",
          status: "cancelled",
          durationMs: Date.now() - startMs,
          errorCode: "CANCELLED",
          refunded: false,
        },
        "python job finished",
      );
      throw new AppError("JOB_TIMEOUT", 504, "Generate dibatalkan.");
    }

    // ── 6. Validasi frame count (§13.5) ──
    const minFrames = Math.ceil(totalFrames * 0.9);
    if (sandbox.framesProduced < minFrames) {
      const tail =
        `only ${sandbox.framesProduced}/${totalFrames} frames produced (min ${minFrames}).\n` +
        sandbox.stderr;
      logger.warn(
        {
          jobId,
          framesProduced: sandbox.framesProduced,
          expectedFrames: totalFrames,
          minFrames,
          timeoutKilled: sandbox.timeoutKilled,
          stderrTail: sandbox.stderr.slice(-1500),
        },
        "Python renderer produced too few frames",
      );

      await markFailed("FRAMES_INSUFFICIENT", "Not enough frames produced");
      logger.info(
        {
          jobId,
          userId: ctx.userId.toString(),
          engine: "python",
          status: "failed",
          durationMs: Date.now() - startMs,
          errorCode: "FRAMES_INSUFFICIENT",
          refunded: false,
        },
        "python job finished",
      );
      return buildRetry("frames", tail);
    }
    const partialFrames = sandbox.framesProduced < totalFrames;

    if (sandbox.timeoutKilled) {
      const tail = `sandbox timed out.\n${sandbox.stderr}`;
      await markFailed("JOB_TIMEOUT", "Sandbox killed by timeout");
      logger.info(
        {
          jobId,
          userId: ctx.userId.toString(),
          engine: "python",
          status: "failed",
          durationMs: Date.now() - startMs,
          errorCode: "JOB_TIMEOUT",
          refunded: false,
        },
        "python job finished",
      );
      return buildRetry("timeout", tail);
    }

    if (!sandbox.ok || sandbox.mp4Path === null) {
      const tail = `sandbox exited (code=${sandbox.exitCode}).\n${sandbox.stderr}`;
      await markFailed("SANDBOX_FAILED", "Sandbox command failed");
      logger.info(
        {
          jobId,
          userId: ctx.userId.toString(),
          engine: "python",
          status: "failed",
          durationMs: Date.now() - startMs,
          errorCode: "SANDBOX_FAILED",
          refunded: false,
        },
        "python job finished",
      );
      return buildRetry("sandbox", tail);
    }

    // ── 7. Validasi MP4 (size, magic) ──
    const mp4Stat = await stat(sandbox.mp4Path);
    if (mp4Stat.size === 0) {
      await markFailed("EMPTY_MP4", "Empty mp4 produced");
      logger.info(
        {
          jobId,
          userId: ctx.userId.toString(),
          engine: "python",
          status: "failed",
          durationMs: Date.now() - startMs,
          errorCode: "EMPTY_MP4",
          refunded: false,
        },
        "python job finished",
      );
      return buildRetry("size", "empty mp4");
    }
    if (mp4Stat.size > MAX_MP4_BYTES) {
      await markFailed("MP4_TOO_LARGE", `MP4 exceeds ${MAX_MP4_BYTES} bytes`);
      logger.info(
        {
          jobId,
          userId: ctx.userId.toString(),
          engine: "python",
          status: "failed",
          durationMs: Date.now() - startMs,
          errorCode: "MP4_TOO_LARGE",
          refunded: false,
        },
        "python job finished",
      );
      return buildRetry(
        "size",
        `mp4 size ${mp4Stat.size} exceeds ${MAX_MP4_BYTES}`,
      );
    }
    const mp4Buf = Buffer.from(await readFile(sandbox.mp4Path));
    if (!looksLikeMp4(mp4Buf)) {
      await markFailed("MP4_MAGIC_MISMATCH", "MP4 magic check failed");
      logger.info(
        {
          jobId,
          userId: ctx.userId.toString(),
          engine: "python",
          status: "failed",
          durationMs: Date.now() - startMs,
          errorCode: "MP4_MAGIC_MISMATCH",
          refunded: false,
        },
        "python job finished",
      );
      return buildRetry("validate", "mp4 magic mismatch");
    }

    // ── 8. Upload R2 → FileDoc (§10.1) ──
    const durationSec = Math.round((sandbox.framesProduced / fps) * 100) / 100;
    const name = `video-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`;
    const saved = await saveGeneratedMedia({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      name,
      kind: "video",
      aspect,
      engine: "python",
      model: "python+ffmpeg",
      width: dims.width,
      height: dims.height,
      durationSec,
      buf: mp4Buf,
    });

    // ── 9. Sukses: job succeeded + counter (§13.6) ──
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
    await incrementUserUsage(ctx.userId, "video_python");
    await incrementGlobalDaily("python");

    logger.info(
      {
        jobId,
        userId: ctx.userId.toString(),
        engine: "python",
        status: "succeeded",
        durationMs: Date.now() - startMs,
        refunded: false,
      },
      "python job finished",
    );

    return {
      kind: "success",
      fileId: saved.fileId,
      jobId,
      kindOut: "video",
      engine: "python",
      aspect,
      durationSec,
      width: dims.width,
      height: dims.height,
      expiresAt: saved.expiresAt.toISOString(),
      partialFrames,
    };
  } catch (err) {
    if (err instanceof AppError) {
      // JOB_TIMEOUT abort path already logged above; others flow here.
      if (err.code !== "JOB_TIMEOUT") {
        await markFailed(err.code, err.message).catch(() => {});
        logger.info(
          {
            jobId,
            userId: ctx.userId.toString(),
            engine: "python",
            status: "failed",
            durationMs: Date.now() - startMs,
            errorCode: err.code,
            refunded: false,
          },
          "python job finished",
        );
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId }, "python video job failed");
    await markFailed("INTERNAL", message).catch(() => {});
    logger.info(
      {
        jobId,
        userId: ctx.userId.toString(),
        engine: "python",
        status: "failed",
        durationMs: Date.now() - startMs,
        errorCode: "INTERNAL",
        refunded: false,
      },
      "python job finished",
    );
    throw new AppError(
      "PROVIDER_ERROR",
      502,
      "Provider generate video sedang bermasalah. Coba lagi nanti.",
    );
  } finally {
    // §13.2: workdir selalu dihapus.
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
