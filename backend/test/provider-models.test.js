const ReviewExecution = require("../src/models/review-execution.model");
const Finding = require("../src/models/finding.model");
const PatchProposal = require("../src/models/patch-proposal.model");

describe("Provider persistence allowlists", () => {
  test("accept Gemini in review execution configuration and provider identity", () => {
    expect(ReviewExecution.schema.path("providerConfiguration.provider").enumValues).toContain("gemini");
    expect(ReviewExecution.schema.path("providerName").enumValues).toContain("gemini");
  });

  test("accept Gemini provenance on findings and patch proposals", () => {
    expect(Finding.schema.path("providerName").enumValues).toContain("gemini");
    expect(PatchProposal.schema.path("providerName").enumValues).toContain("gemini");
  });

  test("accept Groq everywhere a provider identity is persisted", () => {
    expect(ReviewExecution.schema.path("providerConfiguration.provider").enumValues).toContain("groq");
    expect(ReviewExecution.schema.path("providerName").enumValues).toContain("groq");
    expect(Finding.schema.path("providerName").enumValues).toContain("groq");
    expect(PatchProposal.schema.path("providerName").enumValues).toContain("groq");
  });

  test("a review execution configured for Groq passes Mongoose validation", () => {
    const execution = new ReviewExecution({
      repositoryId: "1", repositoryName: "o/r", pullRequestNumber: 1, analyzerVersion: "v", promptVersion: "p",
      providerName: "groq", providerConfiguration: { provider: "groq", model: "openai/gpt-oss-120b" }
    });
    const error = execution.validateSync();
    expect(error?.errors?.["providerConfiguration.provider"]).toBeUndefined();
    expect(error?.errors?.providerName).toBeUndefined();
  });
});