// Live provider contract test. Opt-in: `npm run test:live-ai` (sets RUN_LIVE_AI=1).
// Uses backend/.env. Sends a tiny synthetic snippet only (no private repository code).
// Skipped (and reported as skipped) when RUN_LIVE_AI is unset, LLM_PROVIDER=none, or the key is missing.
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { createPatchAdapter, createProviderAdapter } = require("../src/ai/provider-adapter");
const { aiFindingSchema, aiResultSchema } = require("../src/ai/finding-schema");
const { safeAiFailureDetails } = require("../src/reviews/review.service");
const { loadConfig } = require("../src/config/env");

const optedIn = process.env.RUN_LIVE_AI === "1";

// Jest sandboxes process.env, so process.loadEnvFile() does not reach this module. Parse .env into a
// local object instead; real environment variables take precedence, matching `node --env-file`.
function readDotEnv() {
  try { return parseEnv(fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8")); } catch { return {}; }
}

let config = null;
let configError = null;
if (optedIn) {
  try { config = loadConfig({ ...readDotEnv(), ...process.env }); } catch (error) { configError = error.message; }
}

const keyByProvider = (c) => ({ openai: c.OPENAI_API_KEY, anthropic: c.ANTHROPIC_API_KEY, gemini: c.GEMINI_API_KEY, groq: c.GROQ_API_KEY })[c.LLM_PROVIDER];
const live = optedIn && config && config.LLM_PROVIDER !== "none" && Boolean(keyByProvider(config));
const maybe = live ? describe : describe.skip;

if (!live) {
  const why = !optedIn ? "RUN_LIVE_AI is not 1" : configError ? `invalid .env: ${configError}` : config?.LLM_PROVIDER === "none" ? "LLM_PROVIDER=none" : "no API key for the selected provider";
  console.warn(`LIVE AI INTEGRATION NOT VERIFIED — skipped (${why}).`);
}

const sample = "function getUser(db, id) {\n  return db.query(\"SELECT * FROM users WHERE id = \" + id);\n}\n";
const input = {
  changedFiles: [{ path: "src/user.js", status: "modified", patch: "@@ -1,0 +1,3 @@\n+function getUser(db, id) {\n+  return db.query(\"SELECT * FROM users WHERE id = \" + id);\n+}\n" }],
  contextFiles: [],
  deterministicFindings: []
};

async function guarded(fn) {
  try { return await fn(); } catch (error) {
    console.error("LIVE AI FAILURE (safe diagnostics):", JSON.stringify(safeAiFailureDetails(error, config)));
    throw error;
  }
}

maybe("live provider integration", () => {
  jest.setTimeout(((config && config.LLM_TIMEOUT_MS) || 30_000) + 10_000);

  test("authenticated structured review round-trip passes the application schema", async () => {
    const review = createProviderAdapter(config);
    const result = await guarded(() => review(input));
    expect(result.providerName).toBe(config.LLM_PROVIDER);
    expect(result.model).toBe(config.LLM_MODEL);
    // The adapter adds provenance fields after validation; strip them to re-check the raw model shape.
    const modelFields = result.findings.map((finding) => Object.fromEntries(Object.entries(finding).filter(([key]) => key in aiFindingSchema.shape)));
    expect(() => aiResultSchema.parse({ findings: modelFields })).not.toThrow();
    console.warn(`live review OK: provider=${config.LLM_PROVIDER} model=${config.LLM_MODEL} findings=${result.findings.length}`);
  });

  test("authenticated structured patch round-trip returns replacement code", async () => {
    const propose = createPatchAdapter(config);
    const result = await guarded(() => propose({
      path: "src/user.js",
      finding: { title: "SQL built by string concatenation", explanation: "User input is concatenated into SQL.", suggestedImprovement: "Use a parameterized query.", startLine: 2, endLine: 2 },
      sourceContext: sample
    }));
    expect(typeof result.proposedCode).toBe("string");
    expect(result.proposedCode.length).toBeGreaterThan(0);
    console.warn(`live patch OK: provider=${config.LLM_PROVIDER} model=${config.LLM_MODEL}`);
  });
});