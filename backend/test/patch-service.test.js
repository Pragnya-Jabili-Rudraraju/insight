const { createHash } = require("node:crypto");
const { createPatchService } = require("../src/patches/patch.service");
const { applyReplacement, createUnifiedDiff } = require("../src/patches/unified-diff");

const sha = "a".repeat(40);
const config = { OPERATION_TIMEOUT_MS: 60_000, MAX_PARSED_FILE_BYTES: 500 * 1024 };
const source = "export function run(input) {\n  return eval(input);\n}\n";
const hash = createHash("sha256").update(source).digest("hex");

function setup(overrides = {}) {
  const proposals = [];
  const PatchProposal = { async create(value) { const item = { ...value, _id: "proposal-1" }; proposals.push(item); return item; } };
  const dependencies = {
    PatchProposal,
    assertSnapshotCurrent: async () => true,
    fetchSourceAtRevision: async () => ({ content: source, contentHash: hash }),
    ...overrides
  };
  const service = createPatchService(dependencies);
  const execution = {
    _id: "execution-1", status: "partial", repositoryId: "44", pullRequestNumber: 3,
    baseSha: "b".repeat(40), headSha: sha,
    changedFiles: [{ path: "src/run.js", headContentHash: hash }]
  };
  const finding = {
    _id: "finding-1", executionId: "execution-1", disposition: "accepted", side: "head",
    path: "src/run.js", ruleId: "SEC001", startLine: 2, endLine: 2,
    title: "Dynamic execution pattern", explanation: "Code is executed from a string.", suggestedImprovement: "Avoid eval."
  };
  return { service, proposals, execution, finding };
}

describe("single-finding patch proposals", () => {
  test("creates a syntax-checked proposal tied to the current head and file hash", async () => {
    const assertSnapshotCurrent = jest.fn(async () => true);
    const { service, proposals, execution, finding } = setup({ assertSnapshotCurrent });
    const result = await service({
      repository: { githubRepositoryId: "44", fullName: "owner/repo" }, execution, finding,
      accessToken: "token", config, expectedHeadSha: sha, expectedFileHash: hash,
      proposePatch: async () => ({ proposedCode: "  return input;", providerName: "openai", model: "test-model" })
    });
    expect(result.validationStatus).toBe("valid");
    expect(result.expectedHeadSha).toBe(sha);
    expect(result.expectedFileHash).toBe(hash);
    expect(result.originalCode).toBe("  return eval(input);");
    expect(result.proposedCode).toBe("  return input;");
    expect(result.unifiedDiff).toContain("@@ -2,1 +2,1 @@");
    expect(proposals).toHaveLength(1);
    expect(assertSnapshotCurrent).toHaveBeenCalledTimes(3);
  });

  test("rejects a changed file hash before asking the provider", async () => {
    const { service, execution, finding } = setup({ fetchSourceAtRevision: async () => ({ content: "changed", contentHash: "c".repeat(64) }) });
    const proposePatch = jest.fn();
    await expect(service({
      repository: { githubRepositoryId: "44", fullName: "owner/repo" }, execution, finding,
      accessToken: "token", config, expectedHeadSha: sha, expectedFileHash: hash, proposePatch
    })).rejects.toMatchObject({ code: "STALE_PATCH_FILE", status: 409 });
    expect(proposePatch).not.toHaveBeenCalled();
  });

  test("never includes a detected credential in a patch prompt or stored proposal", async () => {
    const secretSource = 'const apiKey = "sk_live_abc1234567890";';
    const secretHash = createHash("sha256").update(secretSource).digest("hex");
    const { service, proposals } = setup({ fetchSourceAtRevision: async () => ({ content: secretSource, contentHash: secretHash }) });
    const execution = { _id: "execution-1", status: "completed", repositoryId: "44", pullRequestNumber: 3, baseSha: "b".repeat(40), headSha: sha, changedFiles: [{ path: "src/run.js", headContentHash: secretHash }] };
    const finding = { _id: "finding-1", executionId: "execution-1", disposition: "accepted", side: "head", path: "src/run.js", ruleId: "SEC002", startLine: 1, endLine: 1, title: "Possible hardcoded secret", explanation: "Possible secret.", suggestedImprovement: "Move to configuration." };
    await expect(service({
      repository: { githubRepositoryId: "44", fullName: "owner/repo" }, execution, finding,
      accessToken: "token", config, expectedHeadSha: sha, expectedFileHash: secretHash,
      proposePatch: jest.fn()
    })).rejects.toMatchObject({ code: "PATCH_CONTAINS_SECRET" });
    expect(JSON.stringify(proposals)).not.toContain("sk_live_abc1234567890");
  });

  test("rejects a proposed replacement that breaks parsing", async () => {
    const { service, execution, finding } = setup();
    await expect(service({
      repository: { githubRepositoryId: "44", fullName: "owner/repo" }, execution, finding,
      accessToken: "token", config, expectedHeadSha: sha, expectedFileHash: hash,
      proposePatch: async () => ({ proposedCode: "  return (", providerName: "openai", model: "test-model" })
    })).rejects.toMatchObject({ code: "PATCH_PARSE_FAILED", status: 422 });
  });
});

describe("unified change preview", () => {
  test("builds a hunk and replacement modifies only the requested lines", () => {
    const diff = createUnifiedDiff("src/a.js", 2, "old line", "new line");
    expect(diff).toContain("--- a/src/a.js");
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
    expect(applyReplacement("one\ntwo\nthree", 2, 2, "changed")).toBe("one\nchanged\nthree");
  });
});
