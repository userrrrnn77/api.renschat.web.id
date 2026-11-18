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

    // Google OAuth
    GOOGLE_AUTH_ENABLED: BoolStr.default(false),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    GOOGLE_POST_LOGIN_REDIRECT: z.string().url().optional(),

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
    RAG_SMART_EMBEDDING: BoolStr.default(true),
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

    // timeout, retry & concurrency control.
    EMBEDDING_TIMEOUT_MS: IntStr.positive().max(120_000).default(20_000),
    EMBEDDING_MAX_ATTEMPTS: IntStr.positive().max(6).default(3),
    EMBEDDING_RETRY_BASE_MS: IntStr.positive().max(10_000).default(500),
    EMBEDDING_CONCURRENCY: IntStr.positive().max(16).default(4),

    // Web Scrape (Fase 3)
    WEB_SCRAPE_ENABLED: BoolStr.default(true),
    WEB_SCRAPE_RENDER_ENABLED: BoolStr.default(false),
    WEB_SCRAPE_TIMEOUT_MS: IntStr.positive().default(15000),
    WEB_SCRAPE_MAX_BYTES: IntStr.positive().default(3 * 1024 * 1024),
    WEB_SCRAPE_HOURLY_LIMIT: IntStr.positive().default(30),

    PERSONALITY_ENABLED: BoolStr.default(true),

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

    // Prompt Cache (Phase 2)
    PROMPT_CACHE_ENABLED: BoolStr.default(true),
    PROMPT_CACHE_TTL_SECONDS: IntStr.positive()
      .max(7 * 24 * 60 * 60)
      .default(24 * 60 * 60),
    PROMPT_CACHE_MAX_BYTES: IntStr.positive().default(262_144),

    // Rate limit Redis fallback (Phase 7)
    RATE_LIMIT_REDIS_TIMEOUT_MS: IntStr.positive().max(10_000).default(1500),
    RATE_LIMIT_REDIS_COOLDOWN_MS: IntStr.positive().max(300_000).default(5000),
    RATE_LIMIT_MEMORY_MAX_ENTRIES: IntStr.positive()
      .max(1_000_000)
      .default(10_000),
    RATE_LIMIT_MEMORY_SWEEP_MS: IntStr.positive().max(600_000).default(60_000),

    // Media generation — storage & flush (Fase 1)
    ASSET_TTL_HOURS: IntStr.positive()
      .max(24 * 7)
      .default(24),
    ASSET_URL_TTL_SECONDS: IntStr.positive().default(3600),
    CRON_SECRET: z.string().min(16).optional(),
    ENABLE_IN_PROCESS_SCHEDULER: BoolStr.default(false),

    // Media generation — image, entitlement, budget (Fase 2)
    MEDIA_ENABLED: BoolStr.default(true),
    GLOBAL_DAILY_CAP_FLUX2: IntStr.positive().default(2000),
    GLOBAL_DAILY_CAP_FLUX3: IntStr.positive().default(500),
    GLOBAL_DAILY_CAP_COSMOS: IntStr.positive().default(100),
    GLOBAL_DAILY_CAP_PYTHON: IntStr.positive().default(1000),
    NEW_ACCOUNT_DAILY_FACTOR: z.coerce.number().min(0).max(1).default(0.5),
    IMAGE_FREE_DAILY_LIMIT: IntStr.positive().default(20),
    VIDEO_PYTHON_DAILY_LIMIT: IntStr.positive().default(5),
    FLUX2_STEPS: IntStr.positive().default(4),
    FLUX3_STEPS: IntStr.positive().max(50).default(30),
    FLUX3_CFG_SCALE: z.coerce.number().min(0).max(20).default(3.5),
    IMAGE_TIMEOUT_MS: IntStr.positive().default(60000),
    GEN_GLOBAL_CONCURRENCY: IntStr.positive().default(3),
    QUEUE_MAX_WAIT_MS: IntStr.positive().default(120000),
    KOFI_PAGE_URL: z.string().url().optional(),

    // Media generation — Ko-fi (Fase 3, §9, §16)
    KOFI_VERIFICATION_TOKEN: z.string().min(1).optional(),
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
    DONATION_STACK_BY_AMOUNT: BoolStr.default(false),
    CREDITS_IMAGE_PER_DONATION: IntStr.positive().default(10),
    CREDITS_VIDEO_PER_DONATION: IntStr.positive().default(4),

    // Media generation — video cosmos (Fase 4, §12, §16)
    COSMOS_TIMEOUT_MS: IntStr.positive().default(600000),
    COSMOS_NUM_FRAMES: IntStr.positive().default(97),
    COSMOS_TRANSCODE_H264: BoolStr.default(true),
    JOB_STALE_MS: IntStr.positive().default(900000),
    VIDEO_GLOBAL_CONCURRENCY: IntStr.positive().default(2),

    // Media generation — video python sandbox (Fase 5, §13, §16)
    SANDBOX_MODE: z.enum(["docker", "local-unsafe"]).default("docker"),
    SANDBOX_IMAGE: z.string().min(1).default("renschat-sandbox"),
    SANDBOX_TIMEOUT_MS: IntStr.positive().default(120000),
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
    if (val.GOOGLE_AUTH_ENABLED) {
      if (!val.GOOGLE_CLIENT_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GOOGLE_CLIENT_ID wajib diisi jika GOOGLE_AUTH_ENABLED=true",
          path: ["GOOGLE_CLIENT_ID"],
        });
      }
      if (!val.GOOGLE_CLIENT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "GOOGLE_CLIENT_SECRET wajib diisi jika GOOGLE_AUTH_ENABLED=true",
          path: ["GOOGLE_CLIENT_SECRET"],
        });
      }
      if (!val.GOOGLE_REDIRECT_URI) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "GOOGLE_REDIRECT_URI wajib diisi jika GOOGLE_AUTH_ENABLED=true",
          path: ["GOOGLE_REDIRECT_URI"],
        });
      }
    }
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
export const SUMMARY_MODEL = env.MODEL_SUMMARY ?? env.MODEL_FAST;
