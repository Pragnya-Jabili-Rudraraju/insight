const { createPatchAdapter, createProviderAdapter } = require("../src/ai/provider-adapter");
const { safeAiFailureDetails } = require("../src/reviews/review.service");
const { loadConfig } = require("../src/config/env");

const GROQ_KEY = "groq-test-key-0000";
const GEMINI_KEY = "gemini-test-key-1111";

function makeConfig(overrides = {}) {
  return {
    LLM_PROVIDER: "groq",
    LLM_MODEL: "openai/gpt-oss-120b",
    OPENAI_API_KEY: "openai-test-key-2222",
    ANTHROPIC_API_KEY: "anthropic-test-key-3333",
    GEMINI_API_KEY: GEMINI_KEY,
    GROQ_API_KEY: GROQ_KEY,
    LLM_TIMEOUT_MS: 5000,
    OPERATION_TIMEOUT_MS: 60000,
    LLM_MAX_OUTPUT_TOKENS: 1000,
    MAX_PR_DIFF_BYTES: 500 * 1024,
    MAX_CONTEXT_BYTES: 100 * 1024,
    MAX_PARSED_FILE_BYTES: 500 * 1024,
    ...overrides
  };
}

const input = {
  changedFiles: [{ path: "src/app.js", status: "modified", patch: "+const a = 1;" }],
  contextFiles: [],
  deterministicFindings: []
};

const validFinding = {
  category: "security", severity: "high", title: "Hard-coded value", explanation: "Because.",
  path: "src/app.js", side: "head", startLine: 1, endLine: 1, evidenceText: "const a = 1;",
  suggestedImprovement: "Use config.", confidence: "medium", testGuidance: "Add a test.", symbol: null
};

// Real Groq/OpenAI Responses shape: gpt-oss emits a reasoning item BEFORE the message item.
function groqBody(text, extra = {}) {
  return {
    id: "resp_x", object: "response", status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
    ],
    ...extra
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function recordingFetcher(responder) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responder(url, options);
  };
  fetcher.calls = calls;
  return fetcher;
}

async function failureOf(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected the call to fail.");
}

describe("Groq configuration", () => {
  const base = { LLM_PROVIDER: "groq", LLM_MODEL: "openai/gpt-oss-120b", GROQ_API_KEY: GROQ_KEY };

  test("accepts the allowlisted Groq provider/model with a Groq key", () => {
    expect(loadConfig(base).LLM_PROVIDER).toBe("groq");
  });

  test("requires GROQ_API_KEY even when another provider's key is present", () => {
    expect(() => loadConfig({ ...base, GROQ_API_KEY: "", GEMINI_API_KEY: GEMINI_KEY })).toThrow(/GROQ_API_KEY/);
  });

  test("rejects a model outside the Groq allowlist", () => {
    expect(() => loadConfig({ ...base, LLM_MODEL: "gemini-3.8-flash" })).toThrow(/Unsupported LLM_MODEL for groq/);
  });
});

describe("Groq review adapter request contract", () => {
  test("authenticates with GROQ_API_KEY, never another provider's key", async () => {
    const fetcher = recordingFetcher(() => json(groqBody(JSON.stringify({ findings: [] }))));
    await createProviderAdapter(makeConfig(), fetcher)(input);
    const headers = fetcher.calls[0].options.headers;
    expect(headers.Authorization).toBe(`Bearer ${GROQ_KEY}`);
    expect(JSON.stringify(fetcher.calls[0].options)).not.toContain(GEMINI_KEY);
  });

  test("posts to the fixed Groq Responses endpoint with strict json_schema output", async () => {
    const fetcher = recordingFetcher(() => json(groqBody(JSON.stringify({ findings: [] }))));
    await createProviderAdapter(makeConfig(), fetcher)(input);
    const { url, body, options } = fetcher.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/responses");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("error");
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "insight_review_findings", strict: true });
    expect(body.text.format.schema.required).toEqual(["findings"]);
    expect(body.max_output_tokens).toBe(1000);
  });

  test("extracts the message text even when a reasoning item precedes it", async () => {
    const fetcher = recordingFetcher(() => json(groqBody(JSON.stringify({ findings: [validFinding] }))));
    const result = await createProviderAdapter(makeConfig(), fetcher)(input);
    expect(result.providerName).toBe("groq");
    expect(result.model).toBe("openai/gpt-oss-120b");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ provenance: "ai", verification: "unverified", title: "Hard-coded value" });
  });

  test("does not accept Gemini-shaped bodies for Groq (steps[] is not a Groq response)", async () => {
    const geminiShape = { steps: [{ content: [{ type: "model_output", text: JSON.stringify({ findings: [] }) }] }] };
    const error = await failureOf(createProviderAdapter(makeConfig(), recordingFetcher(() => json(geminiShape)))(input));
    expect(error.message).toBe("AI provider returned no structured content.");
  });
});

describe("Groq failure handling and diagnostics", () => {
  test.each([
    [400, "json_validate_failed", "Failed to generate JSON", 422, "AI_PROVIDER_FAILED"],
    [401, "invalid_api_key", "Invalid API Key", 422, "AI_PROVIDER_FAILED"],
    [429, "rate_limit_exceeded", "Rate limit reached", 502, "AI_RATE_LIMITED"],
    [500, "internal_server_error", "Upstream exploded", 502, "AI_PROVIDER_FAILED"]
  ])("HTTP %i keeps status, upstream code and a safe message", async (status, code, message, appStatus, appCode) => {
    const fetcher = recordingFetcher(() => json({ error: { message, type: "invalid_request_error", code } }, status));
    const error = await failureOf(createProviderAdapter(makeConfig(), fetcher)(input));
    expect(error.status).toBe(appStatus);
    expect(error.code).toBe(appCode);
    const details = safeAiFailureDetails(error, makeConfig());
    expect(details).toMatchObject({ provider: "groq", model: "openai/gpt-oss-120b", stage: "http_response", upstreamStatus: status, upstreamCode: code, upstreamMessage: message });
  });

  test("upstream error text is redacted and bounded; never includes keys or failed_generation", async () => {
    const hostile = {
      error: {
        message: `Bad key Bearer ${GROQ_KEY} gsk_abcdefghijklmnop ${"x".repeat(2000)}`,
        code: "invalid_api_key",
        failed_generation: "PRIVATE SOURCE: const secret = 'hunter2';"
      }
    };
    const error = await failureOf(createProviderAdapter(makeConfig(), recordingFetcher(() => json(hostile, 401)))(input));
    const serialized = JSON.stringify(safeAiFailureDetails(error, makeConfig()));
    expect(serialized).not.toContain(GROQ_KEY);
    expect(serialized).not.toContain("gsk_abcdefghijklmnop");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("PRIVATE SOURCE");
    expect(error.upstreamMessage.length).toBeLessThanOrEqual(240);
  });

  test("a non-JSON upstream error body still yields an http failure with status only", async () => {
    const fetcher = recordingFetcher(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await failureOf(createProviderAdapter(makeConfig(), fetcher)(input));
    const details = safeAiFailureDetails(error, makeConfig());
    expect(details).toMatchObject({ reason: "upstream_http_error", upstreamStatus: 502, stage: "http_response" });
    expect(details.upstreamMessage).toBeUndefined();
  });

  test("invalid JSON text is reported at the json_parse stage", async () => {
    const error = await failureOf(createProviderAdapter(makeConfig(), recordingFetcher(() => json(groqBody("not json {"))))(input));
    expect(safeAiFailureDetails(error, makeConfig())).toMatchObject({ reason: "invalid_json", stage: "json_parse" });
  });

  test("empty output is reported with provider status and incomplete reason (e.g. token exhaustion)", async () => {
    const body = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }] };
    const error = await failureOf(createProviderAdapter(makeConfig(), recordingFetcher(() => json(body)))(input));
    expect(safeAiFailureDetails(error, makeConfig())).toMatchObject({
      reason: "empty_response", stage: "response_extraction", providerStatus: "incomplete", incompleteReason: "max_output_tokens"
    });
  });

  test.each([
    ["a JSON array", []],
    ["null", null],
    ["an object without output", { id: "resp_x" }]
  ])("malformed 200 body (%s) fails as an empty response", async (_name, body) => {
    const error = await failureOf(createProviderAdapter(makeConfig(), recordingFetcher(() => json(body)))(input));
    expect(error.message).toBe("AI provider returned no structured content.");
  });

  test("Zod failures report schema paths and codes, not values", async () => {
    const bad = { findings: [{ ...validFinding, severity: "catastrophic", title: "SECRET-TITLE-VALUE" }] };
    const error = await failureOf(createProviderAdapter(makeConfig(), recordingFetcher(() => json(groqBody(JSON.stringify(bad)))))(input));
    const details = safeAiFailureDetails(error, makeConfig());
    expect(details).toMatchObject({ reason: "invalid_structured_output", stage: "schema_validation" });
    expect(details.schemaIssues[0]).toMatch(/^findings\.0\.severity:/);
    expect(JSON.stringify(details)).not.toContain("SECRET-TITLE-VALUE");
  });

  test("a model refusal is surfaced as a failure", async () => {
    const body = { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] };
    const error = await failureOf(createProviderAdapter(makeConfig(), recordingFetcher(() => json(body)))(input));
    expect(error.message).toBe("The AI provider refused the review request.");
  });

  test("a hung request times out and reports timeout details", async () => {
    const hanging = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    });
    const config = makeConfig({ LLM_TIMEOUT_MS: 50 });
    const error = await failureOf(createProviderAdapter(config, hanging)(input));
    expect(safeAiFailureDetails(error, config)).toMatchObject({ reason: "timeout", stage: "request", llmTimeoutMs: 50, operationTimeoutMs: 60000 });
  });

  test("a network-level failure is tagged as a request-stage failure without leaking the key", async () => {
    const fetcher = async () => { throw new TypeError("fetch failed"); };
    const error = await failureOf(createProviderAdapter(makeConfig(), fetcher)(input));
    const details = safeAiFailureDetails(error, makeConfig());
    expect(details).toMatchObject({ reason: "provider_request_failed", stage: "request" });
    expect(JSON.stringify(details)).not.toContain(GROQ_KEY);
  });
});

describe("Groq patch adapter", () => {
  const patchArgs = {
    path: "src/app.js",
    finding: { title: "t", explanation: "e", suggestedImprovement: "s", startLine: 1, endLine: 1 },
    sourceContext: "const a = 1;"
  };

  test("uses the Groq key and endpoint and returns the proposed code", async () => {
    const fetcher = recordingFetcher(() => json(groqBody(JSON.stringify({ proposedCode: "const a = 2;" }))));
    const result = await createPatchAdapter(makeConfig(), fetcher)(patchArgs);
    expect(fetcher.calls[0].url).toBe("https://api.groq.com/openai/v1/responses");
    expect(fetcher.calls[0].options.headers.Authorization).toBe(`Bearer ${GROQ_KEY}`);
    expect(fetcher.calls[0].body.text.format).toMatchObject({ name: "insight_patch_proposal", strict: true });
    expect(result).toMatchObject({ proposedCode: "const a = 2;", providerName: "groq", model: "openai/gpt-oss-120b" });
  });

  test("rejects a patch response that fails the patch schema", async () => {
    const fetcher = recordingFetcher(() => json(groqBody(JSON.stringify({ wrong: true }))));
    const error = await failureOf(createPatchAdapter(makeConfig(), fetcher)(patchArgs));
    expect(error.name).toBe("ZodError");
    expect(error.stage).toBe("schema_validation");
  });
});