// src/services/generation/sandbox/docker.runner.ts
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
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

/**
 * Shell command dijalankan di dalam container (§13.5). Perintah ffmpeg
 * FIXED — model tidak bisa mengubahnya. Frame count di-echo untuk di-parse
 * backend; kalau python gagal, `set -e` menghentikan shell sebelum ffmpeg.
 */
const CONTAINER_SCRIPT = [
  "set -e",
  "python /work/script.py",
  "COUNT=$(ls /work/frames/frame_*.png 2>/dev/null | wc -l)",
  'echo "FRAMES_PRODUCED=$COUNT"',
  'ffmpeg -y -framerate "$FPS" -i /work/frames/frame_%05d.png ' +
    "-c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 23 -preset veryfast " +
    "/work/out.mp4",
].join("\n");

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
 * Jalankan script Python di container terisolasi (§13.2). Flag isolasi
 * WAJIB dipertahankan; workdir di-mount /work rw, script hanya bisa
 * menulis /work/frames dan /work/out.mp4 lewat perintah ffmpeg.
 *
 * Note soal UID: `-u 65534:65534` (nobody). Host workdir di-chmod 0777
 * supaya nobody bisa menulis. Script read-only 0644 tetap terbaca.
 */
export class DockerSandboxRunner implements SandboxRunner {
  async run(
    input: SandboxScriptInput,
    signal?: AbortSignal,
  ): Promise<SandboxRunResult> {
    // ── 1. Siapkan workdir (§13.2: unik per job, caller bersihkan) ──
    await mkdir(input.workdir, { recursive: true });
    await chmod(input.workdir, 0o777);
    const framesDir = join(input.workdir, "frames");
    await mkdir(framesDir, { recursive: true });
    await chmod(framesDir, 0o777);
    await writeFile(join(input.workdir, "script.py"), input.script, {
      mode: 0o644,
    });

    const runId = crypto.randomUUID();
    const containerName = `renschat-sandbox-${runId}`;

    // ── 2. Spawn docker run ──
    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=256m",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "128",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-u",
      "65534:65534",
      "-v",
      `${input.workdir}:/work:rw`,
      "-w",
      "/work",
      "-e",
      `WIDTH=${input.width}`,
      "-e",
      `HEIGHT=${input.height}`,
      "-e",
      `FPS=${input.fps}`,
      "-e",
      `DURATION=${input.duration}`,
      "-e",
      `TOTAL_FRAMES=${input.totalFrames}`,
      "-e",
      "FRAMES_DIR=/work/frames",
      env.SANDBOX_IMAGE,
      "sh",
      "-c",
      CONTAINER_SCRIPT,
    ];

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
    } catch (err) {
      logger.error({ err }, "docker spawn failed (is Docker installed?)");
      throw new AppError(
        "PROVIDER_ERROR",
        502,
        "Sandbox tidak tersedia di server ini.",
      );
    }

    let killed = false;
    const killContainer = (): void => {
      killed = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      // SIGKILL ke client tidak mematikan container yang sudah detached
      // (attached docker run punya propagasi sinyal default SIGKILL tidak
      // ke-proxy). Kill via name.
      try {
        Bun.spawn(["docker", "kill", containerName], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(killContainer, env.SANDBOX_TIMEOUT_MS);
    timer.unref?.();

    const onExternalAbort = (): void => killContainer();
    if (signal) {
      if (signal.aborted) killContainer();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const exitCode = await proc.exited;
      const stdout = await readStreamAsText(proc.stdout);
      const stderr = await readStreamAsText(proc.stderr);

      const frameMatch = stdout.match(/FRAMES_PRODUCED=(\d+)/);
      const framesProduced =
        frameMatch !== null ? Number.parseInt(frameMatch[1], 10) : 0;

      // Fallback: kalau parse gagal, hitung langsung dari host (mount).
      const counted = await countFrames(framesDir);
      const framesFinal = Math.max(framesProduced, counted);

      const mp4Candidate = join(input.workdir, "out.mp4");
      let mp4Path: string | null = null;
      try {
        const s = await stat(mp4Candidate);
        if (s.size > 0) mp4Path = mp4Candidate;
      } catch {
        mp4Path = null;
      }

      const aborted = signal?.aborted === true;
      const ok = exitCode === 0 && !killed && !aborted && mp4Path !== null;

      return {
        ok,
        exitCode: killed || aborted ? -1 : exitCode,
        stdout,
        stderr,
        timeoutKilled: killed,
        framesProduced: framesFinal,
        mp4Path,
        workdir: input.workdir,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
