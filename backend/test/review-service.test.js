const { createReviewService } = require("../src/reviews/review.service");

function fakeModels() {
  const store = { findings: [], occurrences: [], executions: [] };
  const ReviewExecution = {
    async create(values) {
      const record = { ...values, _id: `exec-${store.executions.length + 1}`, async save() {} };
      store.executions.push(record);
      return record;
    },
    async distinct() { return ["4", "5"]; },
    async countDocuments() { return 2; }
  };
  const Finding = {
    async insertMany(values) {
      const inserted = values.map((value, index) => ({ ...value, _id: `finding-${index + 1}` }));
      store.findings.push(...inserted);
      return inserted;
    },
    async deleteMany() { store.findings = []; }
  };
  const HistoricalOccurrence = {
    find() { return { select() { return { async lean() { return []; } }; } }; },
    async insertMany(values) { store.occurrences.push(...values); },
    async deleteMany() { store.occurrences = []; }
  };
  const AnalysisArtifact = { async insertMany(values) { store.artifacts.push(...values); }, async deleteMany() { store.artifacts = []; } };
  store.artifacts = [];
  return { store, ReviewExecution, Finding, HistoricalOccurrence, AnalysisArtifact };
}

const source = "export function readValue() { return 1; }";
const sourceHash = "a".repeat(64);
const snapshotResult = {
  snapshot: { repositoryId: "4", pullRequestNumber: 8, baseSha: "b".repeat(40), headSha: "c".repeat(40) },
  files: [{
    path: "src/value.js", status: "modified", patch: "@@ -1 +1 @@", patchBytes: 10,
    changedHeadLineRanges: [{ startLine: 1, endLine: 1 }],
    changedBaseLineRanges: [{ startLine: 1, endLine: 1 }],
    base: { content: source, contentHash: sourceHash, blobSha: "d".repeat(40) },
    head: { content: source, contentHash: sourceHash, blobSha: "e".repeat(40) }
  }],
  analyzerCandidates: [{ path: "src/value.js", baseContent: source, headContent: source, changedHeadLineRanges: [{ startLine: 1, endLine: 1 }] }],
  warnings: []
};
const analyzerResult = {
  findings: [{
    ruleId: "SEC001", category: "security", severity: "medium", title: "Potential issue",
    explanation: "A cautious explanation.", path: "src/value.js", side: "head", startLine: 1, endLine: 1,
    evidence: "Matched a rule.", fingerprintEvidence: "pattern", symbol: "readValue",
    suggestedImprovement: "Review this code.", testGuidance: "Test the behavior.", confidence: "medium",
    provenance: "deterministic", verification: "unverified", disposition: "candidate", fingerprint: "unkeyed"
  }],
  skipped: [],
  artifacts: []
};

function dependencies(overrides = {}) {
  const models = fakeModels();
  return {
    ...models,
    models,
    config: { FINGERPRINT_HMAC_KEY: "f".repeat(64), OPERATION_TIMEOUT_MS: 60_000, MAX_PARSED_FILE_BYTES: 500_000 },
    fetchSnapshot: async ({ onSnapshotPinned }) => { await onSnapshotPinned(snapshotResult.snapshot); return snapshotResult; },
    selectContext: async () => ({ selected: [], manifest: { candidateCount: 0, inspectedCount: 0, fetchedBytes: 0, selectedBytes: 0, files: [] }, warnings: [] }),
    analyze: () => analyzerResult,
    assertSnapshotCurrent: async () => true,
    ...overrides
  };
}

describe("synchronous review lifecycle", () => {
  test("persists a partial execution when deterministic results are usable but AI is absent", async () => {
    const deps = dependencies();
    const run = createReviewService(deps);
    const result = await run({ repository: { githubRepositoryId: "4", fullName: "owner/repo" }, pullRequestNumber: 8, accessToken: "token", config: deps.config });
    expect(result.execution.status).toBe("partial");
    expect(result.execution.warnings.map((item) => item.code)).toContain("AI_NOT_CONFIGURED");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].verification).toBe("rule_checked");
    expect(deps.store.occurrences).toHaveLength(1);
  });

  test("marks a moved PR stale and discards findings", async () => {
    const deps = dependencies({
      assertSnapshotCurrent: async () => { throw Object.assign(new Error("moved"), { code: "STALE_REVISION" }); }
    });
    const result = await createReviewService(deps)({
      repository: { githubRepositoryId: "4", fullName: "owner/repo" }, pullRequestNumber: 8, accessToken: "token", config: deps.config
    });
    expect(result.execution.status).toBe("stale");
    expect(result.findings).toEqual([]);
    expect(deps.store.findings).toHaveLength(0);
  });

  test("rolls back persisted candidates if the PR moves during finalization", async () => {
    let checks = 0;
    const deps = dependencies({
      assertSnapshotCurrent: async () => {
        checks += 1;
        if (checks === 2) throw Object.assign(new Error("moved during finalization"), { code: "STALE_REVISION" });
        return true;
      }
    });
    const result = await createReviewService(deps)({
      repository: { githubRepositoryId: "4", fullName: "owner/repo" }, pullRequestNumber: 8, accessToken: "token", config: deps.config
    });
    expect(checks).toBe(2);
    expect(result.execution.status).toBe("stale");
    expect(result.findings).toEqual([]);
    expect(deps.store.findings).toHaveLength(0);
    expect(deps.store.occurrences).toHaveLength(0);
  });

  test("keeps a clean deterministic result partial if AI is unavailable", async () => {
    const deps = dependencies({ analyze: () => ({ findings: [], skipped: [] }) });
    const result = await createReviewService(deps)({
      repository: { githubRepositoryId: "4", fullName: "owner/repo" }, pullRequestNumber: 8, accessToken: "token", config: deps.config
    });
    expect(result.execution.status).toBe("partial");
  });

  test("retains deterministic findings as a partial review when an AI provider fails", async () => {
    const deps = dependencies();
    const result = await createReviewService(deps)({
      repository: { githubRepositoryId: "4", fullName: "owner/repo" },
      pullRequestNumber: 8,
      accessToken: "token",
      config: deps.config,
      aiReview: async () => { throw Object.assign(new Error("provider unavailable"), { code: "AI_PROVIDER_FAILED" }); }
    });
    expect(result.execution.status).toBe("partial");
    expect(result.execution.warnings.map((item) => item.code)).toContain("AI_PROVIDER_FAILED");
    expect(result.findings).toHaveLength(1);
  });
});
