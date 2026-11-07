
const { z } = require("zod");
const { isSupportedModel, supportedModelError } = require("../ai/supported-models");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/insight"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["error", "warn", "info"]).default("info"),
  SESSION_SECRET: z.string().default(""),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^(?:[a-f0-9]{64})?$/i, "must be a 32-byte hex key").default(""),
  FINGERPRINT_HMAC_KEY: z.string().regex(/^(?:[a-f0-9]{64})?$/i, "must be a 32-byte hex key").default(""),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  GITHUB_CALLBACK_URL: z.string().url().default("http://localhost:4000/api/v1/auth/github/callback"),
  GITHUB_ALLOWED_USER_ID: z.string().regex(/^(?:[0-9]+)?$/).default(""),
  GITHUB_APP_WEBHOOK_SECRET: z.string().default(""),
  FRONTEND_ORIGIN: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash;
  }, "must be an origin without a path").default("http://localhost:5173"),
  LLM_PROVIDER: z.enum(["none", "openai", "anthropic", "gemini", "groq"]).default("none"),
  LLM_MODEL: z.string().max(120).default(""),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(25_000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8000).default(3000),
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  GEMINI_API_KEY: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  PROMPT_VERSION: z.string().min(1).max(80).default("insight-review-0.1.0"),
  MAX_REPOSITORY_FILES: z.coerce.number().int().min(1).max(1000).default(1000),
  MAX_REPOSITORY_SOURCE_BYTES: z.coerce.number().int().min(1).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
  MAX_PARSED_FILE_BYTES: z.coerce.number().int().min(1).max(500 * 1024).default(500 * 1024),
  MAX_PR_CHANGED_FILES: z.coerce.number().int().min(1).max(50).default(50),
  MAX_PR_DIFF_BYTES: z.coerce.number().int().min(1).max(500 * 1024).default(500 * 1024),
  MAX_CONTEXT_BYTES: z.coerce.number().int().min(1).max(100 * 1024).default(100 * 1024),
  MAX_REPOSITORY_RESULTS: z.coerce.number().int().min(1).max(100).default(100),
  MAX_FINDINGS_PER_RESPONSE: z.coerce.number().int().min(1).max(100).default(100),
  MAX_HISTORY_EXECUTIONS_PER_RESPONSE: z.coerce.number().int().min(1).max(100).default(100),
  MAX_HISTORY_AGGREGATE_RECORDS: z.coerce.number().int().min(1).max(10_000).default(10_000),
  MAX_HISTORY_AGGREGATE_ROWS: z.coerce.number().int().min(1).max(1_000).default(1_000),
  OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(60_000),
  CONNECTED_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  UNINSTALL_GRACE_DAYS: z.coerce.number().int().min(1).max(30).default(30)
}).superRefine((config, context) => {
  if (config.LLM_PROVIDER === "openai" && (!config.LLM_MODEL || !config.OPENAI_API_KEY)) {
    context.addIssue({ code: "custom", path: ["LLM_MODEL"], message: "OpenAI provider requires LLM_MODEL and OPENAI_API_KEY." });
  }

  if (config.LLM_PROVIDER === "anthropic" && (!config.LLM_MODEL || !config.ANTHROPIC_API_KEY)) {
    context.addIssue({ code: "custom", path: ["LLM_MODEL"], message: "Anthropic provider requires LLM_MODEL and ANTHROPIC_API_KEY." });
  }

  if (config.LLM_PROVIDER === "gemini" && (!config.LLM_MODEL || !config.GEMINI_API_KEY)) {
    context.addIssue({ code: "custom", path: ["LLM_MODEL"], message: "Gemini provider requires LLM_MODEL and GEMINI_API_KEY." });
  }

  if (config.LLM_PROVIDER === "groq" && (!config.LLM_MODEL || !config.GROQ_API_KEY)) {
    context.addIssue({ code: "custom", path: ["LLM_MODEL"], message: "Groq provider requires LLM_MODEL and GROQ_API_KEY." });
  }

  if (config.LLM_PROVIDER !== "none" && config.LLM_MODEL && !isSupportedModel(config.LLM_PROVIDER, config.LLM_MODEL)) {
    context.addIssue({ code: "custom", path: ["LLM_MODEL"], message: supportedModelError(config.LLM_PROVIDER) });
  }

  if (config.LLM_PROVIDER === "none" && config.LLM_MODEL) {
    context.addIssue({ code: "custom", path: ["LLM_MODEL"], message: "LLM_MODEL must be empty when LLM_PROVIDER is none." });
  }

  if (config.NODE_ENV === "production") {
    for (const key of ["SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "FINGERPRINT_HMAC_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_ALLOWED_USER_ID", "GITHUB_APP_WEBHOOK_SECRET"]) {
      if (!config[key]) context.addIssue({ code: "custom", path: [key], message: "is required in production." });
    }

    if (config.SESSION_SECRET.length < 32) context.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "must contain at least 32 characters." });
    if (/replace-with|change-me|example/i.test(config.SESSION_SECRET)) context.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "must not use a placeholder value." });
    if (/^(.)\1{63}$/i.test(config.TOKEN_ENCRYPTION_KEY)) context.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_KEY"], message: "must not use a repeated placeholder key." });
    if (/^(.)\1{63}$/i.test(config.FINGERPRINT_HMAC_KEY)) context.addIssue({ code: "custom", path: ["FINGERPRINT_HMAC_KEY"], message: "must not use a repeated placeholder key." });
    if (config.TOKEN_ENCRYPTION_KEY === config.FINGERPRINT_HMAC_KEY) context.addIssue({ code: "custom", path: ["FINGERPRINT_HMAC_KEY"], message: "must be different from TOKEN_ENCRYPTION_KEY." });
    if (!config.GITHUB_CALLBACK_URL.startsWith("https://")) context.addIssue({ code: "custom", path: ["GITHUB_CALLBACK_URL"], message: "must use HTTPS in production." });
    if (!config.FRONTEND_ORIGIN.startsWith("https://")) context.addIssue({ code: "custom", path: ["FRONTEND_ORIGIN"], message: "must use HTTPS in production." });
    if (config.GITHUB_APP_WEBHOOK_SECRET.length < 32) context.addIssue({ code: "custom", path: ["GITHUB_APP_WEBHOOK_SECRET"], message: "must contain at least 32 characters." });
  }
});

function loadConfig(source = process.env) {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return Object.freeze({
    ...parsed.data,
    TRUST_PROXY: parsed.data.TRUST_PROXY === "true"
  });
}

module.exports = { loadConfig };
