// src/services/generation/sandbox/sandbox.types.ts
import { env } from "../../../config/env.js";

/**
 * Input kontrak script (§13.3). Workdir disediakan caller (service) dan
 * menjadi milik caller untuk dibersihkan di finally. Runner menganggap
 * workdir boleh belum ada dan akan membuatnya (idempoten).
 */
export interface SandboxScriptInput {
  script: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  totalFrames: number;
  /** Absolute path; di-mount ke /work di dalam container. */
  workdir: string;
}

export interface SandboxRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True jika dibunuh karena SANDBOX_TIMEOUT_MS / abort. */
  timeoutKilled: boolean;
  /** Jumlah frame PNG (frame_00001.png…) yang terdeteksi di FRAMES_DIR. */
  framesProduced: number;
  /** Absolute path MP4 hasil stitch, null kalau stitch tidak sempat jalan. */
  mp4Path: string | null;
  /** Absolute path workdir (dimiliki caller, bukan runner). */
  workdir: string;
}

export interface SandboxRunner {
  run(
    input: SandboxScriptInput,
    signal?: AbortSignal,
  ): Promise<SandboxRunResult>;
}

import { DockerSandboxRunner } from "./docker.runner.js";
import { LocalSubprocessRunner } from "./local.runner.js";

let cachedDocker: DockerSandboxRunner | null = null;
let cachedLocal: LocalSubprocessRunner | null = null;

/**
 * Runner dipilih dari `SANDBOX_MODE` (§13.2). `local-unsafe` menolak jalan
 * di production (ditegakkan di env schema + defense-in-depth di runner).
 */
export function getSandboxRunner(): SandboxRunner {
  if (env.SANDBOX_MODE === "local-unsafe") {
    cachedLocal ??= new LocalSubprocessRunner();
    return cachedLocal;
  }
  cachedDocker ??= new DockerSandboxRunner();
  return cachedDocker;
}
