
const { createProviderAdapter } = require("../src/ai/provider-adapter");

function makeConfig(provider) {
  return {
    LLM_PROVIDER: provider,
    LLM_MODEL:
      provider === "openai"
        ? "gpt-4o-mini"
        : provider === "anthropic"
          ? "claude-sonnet-4-6"
          : "gemini-3.8-flash",
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    GEMINI_API_KEY: "gemini-secret",
    LLM_TIMEOUT_MS: 5000,
    LLM_MAX_OUTPUT_TOKENS: 1000,
    MAX_PR_DIFF_BYTES: 500 * 1024,
    MAX_CONTEXT_BYTES: 100 * 1024
  };
}

const providerInput = {
  changedFiles: [
    {
      path: "src/app.js",
      status: "modified",
      patch: '+const apiKey = "sk_live_abc1234567890";'
    }
  ],
  contextFiles: [
    {
      path: "src/helper.js",
      content: "export const ok = true;",
      reasonCodes: ["imports_changed_module"]
    }
  ],
  deterministicFindings: []
};

describe("named LLM provider adapter", () => {
  test("uses OpenAI's fixed endpoint and validates structured output", async () => {
    let requestUrl;
    let requestBody;

    const fetcher = async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ findings: [] })
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const review = createProviderAdapter(makeConfig("openai"), fetcher);
    const result = await review(providerInput);

    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(requestBody.text.format.type).toBe("json_schema");
    expect(requestBody.text.format.strict).toBe(true);
    expect(requestBody.store).toBe(false);
    expect(result.providerName).toBe("openai");
    expect(JSON.stringify(requestBody)).not.toContain("sk_live_abc1234567890");
  });

  test("uses Anthropic's fixed endpoint and structured output config", async () => {
    let requestUrl;
    let requestBody;

    const fetcher = async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);

      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({ findings: [] })
            }
          ]
        }),
        { status: 200 }
      );
    };

    const review = createProviderAdapter(makeConfig("anthropic"), fetcher);
    const result = await review(providerInput);

    expect(requestUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(requestBody.output_config.format.type).toBe("json_schema");
    expect(result.providerName).toBe("anthropic");
  });

  test("uses Gemini's Interactions endpoint and JSON schema response configuration", async () => {
    let requestUrl;
    let requestOptions;

    const fetcher = async (url, options) => {
      requestUrl = url;
      requestOptions = options;

      return new Response(
        JSON.stringify({
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "model_output",
                  text: JSON.stringify({ findings: [] })
                }
              ]
            }
          ]
        }),
        { status: 200 }
      );
    };

    const result = await createProviderAdapter(makeConfig("gemini"), fetcher)(
      providerInput
    );

    expect(requestUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions"
    );
    expect(requestOptions.headers["x-goog-api-key"]).toBe("gemini-secret");

    const requestBody = JSON.parse(requestOptions.body);

    expect(requestBody.model).toBe("gemini-3.8-flash");
    expect(requestBody.response_format.mime_type).toBe("application/json");
    expect(requestBody.response_format.schema).toBeDefined();
    expect(requestOptions.body).not.toContain("sk_live_abc1234567890");
    expect(result.providerName).toBe("gemini");
  });

  test("rejects provider output that fails the application schema", async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    findings: [{ title: "missing required fields" }]
                  })
                }
              ]
            }
          ]
        }),
        { status: 200 }
      );

    await expect(
      createProviderAdapter(makeConfig("openai"), fetcher)(providerInput)
    ).rejects.toThrow();
  });

  test("maps provider rate limiting to a bounded retryable provider failure", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429
      });

    await expect(
      createProviderAdapter(makeConfig("openai"), fetcher)(providerInput)
    ).rejects.toMatchObject({
      status: 502,
      code: "AI_RATE_LIMITED"
    });
  });

  test("does not create an adapter for an unconfigured provider", () => {
    expect(createProviderAdapter({ LLM_PROVIDER: "none" })).toBeNull();
  });

  test("rejects model names outside the configured provider allowlist", () => {
    expect(() =>
      createProviderAdapter({
        ...makeConfig("openai"),
        LLM_MODEL: "arbitrary-model"
      })
    ).toThrow("Unsupported LLM_MODEL for openai");
  });
});
