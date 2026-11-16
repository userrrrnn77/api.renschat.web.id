// scripts/env-check.ts
const REQUIRED = [
  "MONGODB_URI",
  "CLIENT_ORIGIN",
  "JWT_SECRET",
  "NVIDIA_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

const RECOMMENDED = ["KOFI_VERIFICATION_TOKEN", "KOFI_PAGE_URL"] as const;

const OPTIONAL = [
  "NODE_ENV",
  "PORT",
  "DEFAULT_TIMEZONE",
  "LLM_PROVIDER",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "HARNESS_ENABLED",
  "HARNESS_ROUTE_FAST",
  "REASONING_DEFAULT",
  "NVIDIA_BASE_URL",
  "MODEL_MAIN",
  "MODEL_VISION",
  "MODEL_FAST",
  "MODEL_SUMMARY",
  "MODEL_SAFETY",
  "SAFETY_ENABLED",
  "SHOW_REASONING",
  "TOOL_MODE",
  "CLARIFICATION_ENABLED",
  "CLARIFICATION_TIMEOUT_MS",
  "RAG_ENABLED",
  "RAG_TOP_K",
  "RAG_MIN_SIM",
  "RAG_TIMEOUT_MS",
  "CHUNK_TARGET_CHARS",
  "CHUNK_OVERLAP_CHARS",
  "EMBEDDING_ENABLED",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
  "EMBEDDING_BATCH_SIZE",
  "MAX_TOOL_ITERATIONS",
  "MAX_OUTPUT_TOKENS",
  "HISTORY_TOKEN_BUDGET",
  "ATTACH_INLINE_TOKEN_BUDGET",
  "MAX_UPLOAD_MB",
  "MAX_OCR_PAGES",
  "MAX_DOC_CHARS",
  "PDF_CONCURRENCY",
  "R2_PUBLIC_URL",
  "REDIS_URL",
  "ASSET_TTL_HOURS",
  "ASSET_URL_TTL_SECONDS",
  "CRON_SECRET",
  "ENABLE_IN_PROCESS_SCHEDULER",
  "MEDIA_ENABLED",
  "GLOBAL_DAILY_CAP_FLUX2",
  "GLOBAL_DAILY_CAP_FLUX3",
  "GLOBAL_DAILY_CAP_COSMOS",
  "GLOBAL_DAILY_CAP_PYTHON",
  "NEW_ACCOUNT_DAILY_FACTOR",
  "IMAGE_FREE_DAILY_LIMIT",
  "VIDEO_PYTHON_DAILY_LIMIT",
  "FLUX2_STEPS",
  "FLUX3_STEPS",
  "FLUX3_CFG_SCALE",
  "IMAGE_TIMEOUT_MS",
  "GEN_GLOBAL_CONCURRENCY",
  "QUEUE_MAX_WAIT_MS",
  "DONATION_MIN_BY_CURRENCY",
  "DONATION_STACK_BY_AMOUNT",
  "CREDITS_IMAGE_PER_DONATION",
  "CREDITS_VIDEO_PER_DONATION",
  "COSMOS_TIMEOUT_MS",
  "COSMOS_NUM_FRAMES",
  "COSMOS_TRANSCODE_H264",
  "JOB_STALE_MS",
  "VIDEO_GLOBAL_CONCURRENCY",
  "SANDBOX_MODE",
  "SANDBOX_IMAGE",
  "SANDBOX_TIMEOUT_MS",
  "PY_VIDEO_LOW_RES",
] as const;

function section(title: string, keys: readonly string[]): number {
  console.log(`\n=== ${title} ===`);
  let missing = 0;
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") {
      console.log(`  ✓ ${k}`);
    } else {
      console.log(`  ✗ ${k} (MISSING)`);
      missing += 1;
    }
  }
  return missing;
}

const reqMissing = section("REQUIRED (tanpa default)", REQUIRED);
section("RECOMMENDED (Fase 3)", RECOMMENDED);
section("OPTIONAL (punya default)", OPTIONAL);

console.log(
  reqMissing > 0
    ? `\n✗ ${reqMissing} env REQUIRED belum diset. App akan gagal boot.`
    : "\n✓ Semua env REQUIRED terpenuhi.",
);
process.exit(reqMissing > 0 ? 1 : 0);
