const { analyzeFiles } = require("../src/analysis/structural-analyzer");
const { createFingerprint, validateFindings } = require("../src/reviews/finding-validator");

const hmacKey = "b".repeat(64);

describe("finding evidence validation", () => {
  test("checks deterministic findings against pinned source and records a redacted snippet", () => {
    const content = 'const apiKey = "sk_live_abc1234567890";\neval(input);';
    const analyzer = analyzeFiles([{ path: "src/service.js", headContent: content, changedHeadLineRanges: [{ startLine: 1, endLine: 2 }] }]);
    const result = validateFindings({
      findings: analyzer.findings,
      files: [{ path: "src/service.js", changedHeadLineRanges: [{ startLine: 1, endLine: 2 }], head: { content, contentHash: "f".repeat(64) } }],
      repositoryId: "42", hmacKey
    });
    expect(result.rejectedCount).toBe(0);
    expect(result.findings.every((finding) => finding.verification === "rule_checked")).toBe(true);
    expect(JSON.stringify(result.findings)).not.toContain("sk_live_abc1234567890");
    expect(result.findings[0].evidence[0].contentHash).toBe("f".repeat(64));
  });

  test("rejects an out-of-range location and an AI snippet that is not in source", () => {
    const content = "const amount = 3;";
    const result = validateFindings({
      repositoryId: "42", hmacKey,
      files: [{ path: "src/pay.js", changedHeadLineRanges: [{ startLine: 1, endLine: 1 }], head: { content, contentHash: "a".repeat(64) } }],
      findings: [
        { ruleId: "AI001", category: "correctness", severity: "medium", title: "Invalid line", explanation: "x", path: "src/pay.js", side: "head", startLine: 7, endLine: 7, suggestedImprovement: "x", confidence: "low", provenance: "ai", evidenceText: "no source" },
        { ruleId: "AI002", category: "correctness", severity: "medium", title: "Unsupported", explanation: "x", path: "src/pay.js", side: "head", startLine: 1, endLine: 1, suggestedImprovement: "x", confidence: "low", provenance: "ai", evidenceText: "secret statement" }
      ]
    });
    expect(result.rejectedCount).toBe(2);
    expect(result.findings.every((finding) => finding.disposition === "rejected")).toBe(true);
  });

  test("rejects evidence that matches source but maps only to unchanged diff lines", () => {
    const content = "const first = 1;\neval(input);\nconst last = 3;";
    const result = validateFindings({
      repositoryId: "42", hmacKey,
      files: [{ path: "src/app.js", changedHeadLineRanges: [{ startLine: 3, endLine: 3 }], head: { content, contentHash: "c".repeat(64) } }],
      findings: [{
        ruleId: "AI001", category: "security", severity: "medium", title: "Dynamic execution",
        explanation: "Potential dynamic execution.", path: "src/app.js", side: "head", startLine: 2, endLine: 2,
        evidenceText: "eval(input);", suggestedImprovement: "Avoid dynamic execution.", confidence: "medium",
        provenance: "ai", fingerprintEvidence: "eval call"
      }]
    });
    expect(result.rejectedCount).toBe(1);
    expect(result.findings[0].validationMessage).toContain("changed lines");
  });

  test("fingerprints are repository-scoped and include normalized evidence", () => {
    const candidate = { ruleId: "SEC001", category: "security", path: "src/a.js", startLine: 10, fingerprintEvidence: "  eval call  " };
    expect(createFingerprint(candidate, "1", hmacKey)).toBe(createFingerprint({ ...candidate, fingerprintEvidence: "eval   call" }, "1", hmacKey));
    expect(createFingerprint(candidate, "1", hmacKey)).not.toBe(createFingerprint(candidate, "2", hmacKey));
    expect(createFingerprint(candidate, "1", "c".repeat(64))).not.toBe(createFingerprint(candidate, "1", hmacKey));
  });
});
