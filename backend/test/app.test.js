const request = require("supertest");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config/env");

const app = createApp(loadConfig({ NODE_ENV: "test" }));

describe("Insight API foundation", () => {
  test("serves health status and a request id", async () => {
    const response = await request(app).get("/api/v1/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", service: "insight-api" });
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });

  test("returns the stable error envelope for missing routes", async () => {
    const response = await request(app).get("/api/v1/missing");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.requestId).toEqual(expect.any(String));
  });

  test("validates configuration and rejects invalid ports", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow("Invalid environment configuration");
  });

  test("rejects development placeholder encryption keys in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      SESSION_SECRET: "a-secure-random-session-secret-with-32-plus-characters",
      TOKEN_ENCRYPTION_KEY: "0".repeat(64),
      FINGERPRINT_HMAC_KEY: "1".repeat(64)
    })).toThrow("repeated placeholder key");
  });

  test("rejects unsupported and provider-mismatched LLM models during configuration", () => {
    expect(() => loadConfig({
      NODE_ENV: "test", LLM_PROVIDER: "openai", LLM_MODEL: "arbitrary-model", OPENAI_API_KEY: "key"
    })).toThrow("Unsupported LLM_MODEL for openai");
    expect(() => loadConfig({
      NODE_ENV: "test", LLM_PROVIDER: "anthropic", LLM_MODEL: "gpt-4o-mini", ANTHROPIC_API_KEY: "key"
    })).toThrow("Unsupported LLM_MODEL for anthropic");
    expect(loadConfig({
      NODE_ENV: "test", LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-4-6", ANTHROPIC_API_KEY: "key"
    }).LLM_MODEL).toBe("claude-sonnet-4-6");
    expect(loadConfig({
      NODE_ENV: "test", LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.8-flash", GEMINI_API_KEY: "key"
    }).LLM_MODEL).toBe("gemini-3.8-flash");
    expect(() => loadConfig({
      NODE_ENV: "test", LLM_PROVIDER: "gemini", LLM_MODEL: "gpt-4o-mini", GEMINI_API_KEY: "key"
    })).toThrow("Unsupported LLM_MODEL for gemini");
  });
});
