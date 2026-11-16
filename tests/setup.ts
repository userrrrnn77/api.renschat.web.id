// tests/setup.ts
// Minimal env vars so importing src/config/env.ts does not exit.
// Actual secrets are dummy values — tests never call external services.

const SETUP: Record<string, string> = {
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:27017/genui-test",
  JWT_SECRET: "x".repeat(48),
  CLIENT_ORIGIN: "http://localhost:5173",
  NVIDIA_API_KEY: "nvapi-test",
  R2_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_BUCKET: "test-bucket",
};

for (const [k, v] of Object.entries(SETUP)) {
  process.env[k] ??= v;
}
