// src/services/generation/sandbox/local.runner.ts
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { AppError } from "../../../middleware/error.js";
import type {
  SandboxRunner,
  SandboxRunResult,
  SandboxScriptInput,
} from "./sandbox.types.js";

const MAX_OUTPUT = 64 * 1024;
const FRAME_NAME_RE = /^frame_\d{5}\.png$/;
const MINIMAL_PATH = "/usr/local/bin:/usr/bin:/bin";

interface SpawnOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Bun.spawn return type untuk `stdout`/`stderr` adalah union
 * `number | ReadableStream<Uint8Array<ArrayBuffer>> | undefined`. Kita
 * selalu set `"pipe"` → runtime dijamin stream, tapi TS butuh narrowing.
 * Defensive: kalau bukan stream, kembalikan "" daripada crash.
 */
async function readStreamAsText(stream: unknown): Promise<string> {
  if (stream instanceof ReadableStream) {
    const buf = await new Response(stream).arrayBuffer();
    return Buffer.from(buf).toString("utf-8").slice(0, MAX_OUTPUT);
  }
  return "";
}

async function spawnBounded(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<SpawnOutcome> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }

  let timedOut = false;
  const kill = (): void => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  };
  const timer = setTimeout(kill, opts.timeoutMs);
  timer.unref?.();

  const onAbort = (): void => kill();
  if (opts.signal) {
    if (opts.signal.aborted) kill();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const exitCode = await proc.exited;
    const stdout = await readStreamAsText(proc.stdout);
    const stderr = await readStreamAsText(proc.stderr);
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode: timedOut ? -1 : exitCode,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function countFrames(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) if (FRAME_NAME_RE.test(e)) n += 1;
  return n;
}

/**
 * Local runner — DEV ONLY (§13.2). Menjalankan `python3` dan `ffmpeg`
 * langsung di host tanpa isolasi Docker. Menolak jalan di production;
 * defense-in-depth terhadap env yang salah konfigurasi.
 */
export class LocalSubprocessRunner implements SandboxRunner {
  async run(
    input: SandboxScriptInput,
    signal?: AbortSignal,
  ): Promise<SandboxRunResult> {
    if (env.NODE_ENV === "production") {
      throw new AppError(
        "MEDIA_DISABLED",
        503,
        "Local sandbox runner tidak diizinkan di production.",
      );
    }

    // ── Siapkan workdir ──
    await mkdir(input.workdir, { recursive: true });
    const framesDir = join(input.workdir, "frames");
    await mkdir(framesDir, { recursive: true });
    const scriptPath = join(input.workdir, "script.py");
    await writeFile(scriptPath, input.script, { encoding: "utf-8" });

    const baseEnv = {
      PATH: MINIMAL_PATH,
      WIDTH: String(input.width),
      HEIGHT: String(input.height),
      FPS: String(input.fps),
      DURATION: String(input.duration),
      TOTAL_FRAMES: String(input.totalFrames),
      FRAMES_DIR: framesDir,
    };

    // ── Python ──
    const py = await spawnBounded("python3", [scriptPath], {
      cwd: input.workdir,
      timeoutMs: env.SANDBOX_TIMEOUT_MS,
      env: baseEnv,
      ...(signal !== undefined ? { signal } : {}),
    });

    const framesProduced = await countFrames(framesDir);

    if (!py.ok) {
      logger.warn(
        { exitCode: py.exitCode, timedOut: py.timedOut },
        "local python sandbox failed",
      );
      return {
        ok: false,
        exitCode: py.exitCode,
        stdout: py.stdout,
        stderr: py.stderr,
        timeoutKilled: py.timedOut,
        framesProduced,
        mp4Path: null,
        workdir: input.workdir,
      };
    }

    // ── ffmpeg (fixed) ──
    const outPath = join(input.workdir, "out.mp4");
    const ff = await spawnBounded(
      "ffmpeg",
      [
        "-y",
        "-framerate",
        String(input.fps),
        "-i",
        join(framesDir, "frame_%05d.png"),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-crf",
        "23",
        "-preset",
        "veryfast",
        outPath,
      ],
      {
        cwd: input.workdir,
        timeoutMs: env.SANDBOX_TIMEOUT_MS,
        env: { PATH: MINIMAL_PATH },
        ...(signal !== undefined ? { signal } : {}),
      },
    );

    let mp4Path: string | null = null;
    try {
      const s = await stat(outPath);
      if (s.size > 0) mp4Path = outPath;
    } catch {
      mp4Path = null;
    }

    return {
      ok: ff.ok && mp4Path !== null,
      exitCode: ff.timedOut ? -1 : ff.exitCode,
      stdout: `${py.stdout}\n${ff.stdout}`,
      stderr: `${py.stderr}\n${ff.stderr}`,
      timeoutKilled: py.timedOut || ff.timedOut,
      framesProduced,
      mp4Path,
      workdir: input.workdir,
    };
  }
}
