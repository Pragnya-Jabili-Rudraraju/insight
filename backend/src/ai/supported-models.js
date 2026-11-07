
// Keep these explicit provider/model pairs aligned with the
// structured-output request formats used by provider-adapter.js.
const SUPPORTED_MODELS = Object.freeze({
  openai: Object.freeze(["gpt-4o-mini"]),
  anthropic: Object.freeze(["claude-sonnet-4-6"]),
  gemini: Object.freeze(["gemini-3.8-flash"]),
  groq: Object.freeze(["openai/gpt-oss-120b"])
});

function isSupportedModel(provider, model) {
  return Boolean(SUPPORTED_MODELS[provider]?.includes(model));
}

function supportedModelError(provider) {
  const models = SUPPORTED_MODELS[provider] || [];
  return "Unsupported LLM_MODEL for " + provider + ". Choose a supported model: " + models.join(", ") + ".";
}

module.exports = { SUPPORTED_MODELS, isSupportedModel, supportedModelError };
