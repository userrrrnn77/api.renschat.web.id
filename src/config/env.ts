// src/config/env.ts
import { z } from "zod";

const BoolStr = z.enum(["true", "false"]).transform((v) => v === "true");
const IntStr = z.coerce.number().int();

const EnvSchema = z
  .object({
    // Core
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: IntStr.positive().default(3000),
    MONGODB_URI: z.string().min(1),
    CLIENT_ORIGIN: z
      .string()
      .min(1)
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    JWT_SECRET: z.string().min(32),
    DEFAULT_TIMEZONE: z.string().default("Asia/Jakarta"),

    // LLM Provider (Phase 3)
    LLM_PROVIDER: z.enum(["nvidia", "openai_compat"]).default("nvidia"),
    LLM_BASE_URL: z.string().url().optional(),
    LLM_API_KEY: z.string().optional(),
    HARNESS_ENABLED: BoolStr.default(true),
    HARNESS_ROUTE_FAST: BoolStr.default(false),
    REASONING_DEFAULT: z
      .enum(["off", "low", "medium", "high"])
      .default("medium"),

    // NVIDIA
    NVIDIA_API_KEY: z.string().min(1),
    NVIDIA_BASE_URL: z
      .string()
      .min(1)
      .default("https://integrate.api.nvidia.com/v1"),
    MODEL_MAIN: z.string().default("nvidia/nemotron-3-ultra-550b-a55b"),
    MODEL_VISION: z
      .string()
      .default("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
    MODEL_FAST: z.string().default("nvidia/nemotron-3.5-lightning-30b-a3b"),
    MODEL_SUMMARY: z.string().optional(),
    MODEL_SAFETY: z.string().default("nvidia/nemotron-3.5-content-safety"),
    SAFETY_ENABLED: BoolStr.default(false),
    SHOW_REASONING: BoolStr.default(false),
    TOOL_MODE: z.enum(["native", "json"]).default("native"),

    // Clarification (Phase 1)
    CLARIFICATION_ENABLED: BoolStr.default(true),
    CLARIFICATION_TIMEOUT_MS: IntStr.positive().default(120_000),

    // RAG (Phase 2)
    RAG_ENABLED: BoolStr.default(true),
    RAG_TOP_K: IntStr.positive().max(50).default(6),
    RAG_MIN_SIM: z.coerce.number().min(0).max(1).default(0.3),
    RAG_TIMEOUT_MS: IntStr.positive().default(5000),
    CHUNK_TARGET_CHARS: IntStr.positive().default(1800),
    CHUNK_OVERLAP_CHARS: IntStr.positive().default(250),

    // Embedding (vector search)
    EMBEDDING_ENABLED: BoolStr.default(false),
    EMBEDDING_MODEL: z.string().default("nvidia/nemotron-3.5-embed-8b"),
    EMBEDDING_DIM: IntStr.positive().default(4096),
    EMBEDDING_BATCH_SIZE: IntStr.positive().max(128).default(32),

    // Limits
    MAX_TOOL_ITERATIONS: IntStr.positive().default(8),
    MAX_OUTPUT_TOKENS: IntStr.positive().default(4096),
    HISTORY_TOKEN_BUDGET: IntStr.positive().default(24_000),
    ATTACH_INLINE_TOKEN_BUDGET: IntStr.positive().default(12_000),
    MAX_UPLOAD_MB: IntStr.positive().default(20),
    MAX_OCR_PAGES: IntStr.positive().default(15),
    MAX_DOC_CHARS: IntStr.positive().default(2_000_000),
    PDF_CONCURRENCY: IntStr.positive().default(1),

    // Storage
    R2_ACCOUNT_ID: z.string().min(1),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_BUCKET: z.string().min(1),
    R2_PUBLIC_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().url().optional(),

    // Media generation — storage & flush (Fase 1)
    /** Umur media generated sebelum dihapus (jam). */
    ASSET_TTL_HOURS: IntStr.positive()
      .max(24 * 7)
      .default(24),
    /** TTL presigned URL GET untuk <img>/<video>. */
    ASSET_URL_TTL_SECONDS: IntStr.positive().default(3600),
    /** Secret untuk POST /internal/cron/flush-assets. Tidak diset → endpoint cron selalu 401. */
    CRON_SECRET: z.string().min(16).optional(),
    /** Scheduler in-process tambahan (job recovery, Fase 4). Cleanup repo tetap jalan. */
    ENABLE_IN_PROCESS_SCHEDULER: BoolStr.default(false),

    // Media generation — image, entitlement, budget (Fase 2)
    /** Kill switch semua fitur media (§8.4). */
    MEDIA_ENABLED: BoolStr.default(true),
    /** Cap harian global per engine (§8.4). */
    GLOBAL_DAILY_CAP_FLUX2: IntStr.positive().default(2000),
    GLOBAL_DAILY_CAP_FLUX3: IntStr.positive().default(500),
    GLOBAL_DAILY_CAP_COSMOS: IntStr.positive().default(100),
    GLOBAL_DAILY_CAP_PYTHON: IntStr.positive().default(1000),
    /** Limit harian user baru (<24 jam) = limit × faktor ini (§8.4). */
    NEW_ACCOUNT_DAILY_FACTOR: z.coerce.number().min(0).max(1).default(0.5),
    /** Limit harian per user (§8.3). */
    IMAGE_FREE_DAILY_LIMIT: IntStr.positive().default(20),
    VIDEO_PYTHON_DAILY_LIMIT: IntStr.positive().default(5),
    /** Provider image (§4.2/§4.3). */
    FLUX2_STEPS: IntStr.positive().default(4),
    FLUX3_STEPS: IntStr.positive().max(50).default(30),
    FLUX3_CFG_SCALE: z.coerce.number().min(0).max(20).default(3.5),
    IMAGE_TIMEOUT_MS: IntStr.positive().default(60000),
    /** Semaphore global generate gambar + antre (§8.3). */
    GEN_GLOBAL_CONCURRENCY: IntStr.positive().default(3),
    QUEUE_MAX_WAIT_MS: IntStr.positive().default(120000),
    /** Halaman Ko-fi untuk payload entitlements (§7.2). */
    KOFI_PAGE_URL: z.string().url().optional(),

    // Media generation — Ko-fi (Fase 3, §9, §16)
    /** Token dari ko-fi.com/manage/webhooks (Advanced). Tidak diset → webhook selalu 401. */
    KOFI_VERIFICATION_TOKEN: z.string().min(1).optional(),
    /** Minimum donasi per mata uang. JSON object string. Default {"USD":3}. */
    DONATION_MIN_BY_CURRENCY: z
      .string()
      .default('{"USD":3}')
      .transform((v, ctx) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(v);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "DONATION_MIN_BY_CURRENCY is not valid JSON",
          });
          return z.NEVER;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          ctx.addIssue({
            code: "custom",
            message: "DONATION_MIN_BY_CURRENCY must be a JSON object",
          });
          return z.NEVER;
        }
        const result: Record<string, number> = {};
        for (const [k, val] of Object.entries(parsed)) {
          if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
            ctx.addIssue({
              code: "custom",
              message: `Invalid minimum for currency ${k}`,
            });
            return z.NEVER;
          }
          result[k.toUpperCase()] = val;
        }
        return result;
      }),
    /** Bila true, unit = floor(amount / min). Default false (per donasi). */
    DONATION_STACK_BY_AMOUNT: BoolStr.default(false),
    /** Kredit gambar flux-3 per unit donasi. */
    CREDITS_IMAGE_PER_DONATION: IntStr.positive().default(10),
    /** Kredit video cosmos per unit donasi. */
    CREDITS_VIDEO_PER_DONATION: IntStr.positive().default(4),

    // Media generation — video cosmos (Fase 4, §12, §16)
    /** Timeout provider cosmos3-nano (§4.4: request bisa lama). */
    COSMOS_TIMEOUT_MS: IntStr.positive().default(600000),

    /** Jumlah frame default (pola 4k+1, tier 480 → 25..297). */
    COSMOS_NUM_FRAMES: IntStr.positive().default(97),

    /** Transcode MP4 VP9 → H.264 (§4.4, §12.1). */
    COSMOS_TRANSCODE_H264: BoolStr.default(true),

    /** Job `queued`/`running` lebih tua dari ini saat boot → failed + refund (§12.2). */
    JOB_STALE_MS: IntStr.positive().default(900000),
    /** Semaphore global generate video (§8.3). */
    VIDEO_GLOBAL_CONCURRENCY: IntStr.positive().default(2),

    // Media generation — video python sandbox (Fase 5, §13, §16)
    /** Mode sandbox: docker = aman; local-unsafe hanya development (§13.2). */
    SANDBOX_MODE: z.enum(["docker", "local-unsafe"]).default("docker"),
    /** Image Docker sandbox (build dari sandbox/Dockerfile). */
    SANDBOX_IMAGE: z.string().min(1).default("renschat-sandbox"),
    /** Batas keras eksekusi script + stitch per job (§13.2). */
    SANDBOX_TIMEOUT_MS: IntStr.positive().default(120000),
    /** Turunkan resolusi video python ke 854×480 / 480×854 (§13.4). */
    PY_VIDEO_LOW_RES: BoolStr.default(false),
  })
  .superRefine((val, ctx) => {
    if (val.LLM_PROVIDER === "openai_compat") {
      if (!val.LLM_BASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "LLM_BASE_URL wajib diisi jika LLM_PROVIDER=openai_compat",
          path: ["LLM_BASE_URL"],
        });
      }
      if (!val.LLM_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "LLM_API_KEY wajib diisi jika LLM_PROVIDER=openai_compat",
          path: ["LLM_API_KEY"],
        });
      }
    }
    // §4.4: num_frames wajib berpola 4k+1.
    if ((val.COSMOS_NUM_FRAMES - 1) % 4 !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "COSMOS_NUM_FRAMES must follow 4k+1 pattern",
        path: ["COSMOS_NUM_FRAMES"],
      });
    }
    if (val.SANDBOX_MODE === "local-unsafe" && val.NODE_ENV === "production") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "SANDBOX_MODE=local-unsafe tidak diizinkan di production (§13.2)",
        path: ["SANDBOX_MODE"],
      });
    }
  });

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Model untuk task helper (judul, summaryLine, rolling summary). */
export const SUMMARY_MODEL = env.MODEL_SUMMARY ?? env.MODEL_FAST;
