const fs = require("node:fs");
const path = require("node:path");
const { analyzeFiles } = require("../src/analysis/structural-analyzer");
const { validateFindings } = require("../src/reviews/finding-validator");
const { parseSource } = require("../src/analysis/babel-parser");
const { applyReplacement } = require("../src/patches/unified-diff");
const { createHash } = require("node:crypto");

const datasetPath = path.join(__dirname, "datasets", "v1.json");
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
const hmacKey = "e".repeat(64);
let truePositives = 0;
let falsePositives = 0;
let falseNegative = 0;
let trueNegativeCases = 0;
let falsePositiveCases = 0;
let evidenceAccurate = 0;
let evidenceReferencesAccurate = 0;
let evidenceReferencesTotal = 0;
let duplicates = 0;
let predictedTotal = 0;
const caseResults = [];
const falsePositivePullRequests = new Set();

for (const fixture of dataset.cases) {
  const analysis = analyzeFiles(fixture.files);
  const keys = new Set();
  for (const finding of analysis.findings) {
    const key = `${finding.ruleId}|${finding.path}|${finding.side}|${finding.startLine}`;
    if (keys.has(key)) duplicates += 1;
    keys.add(key);
  }
  const expected = new Set(fixture.expected.map((finding) => `${finding.ruleId}|${finding.path}|${finding.side}|${finding.startLine}`));
  const predicted = new Set(analysis.findings.map((finding) => `${finding.ruleId}|${finding.path}|${finding.side}|${finding.startLine}`));
  predictedTotal += predicted.size;
  for (const key of expected) {
    if (predicted.has(key)) truePositives += 1;
    else falseNegative += 1;
  }
  const unexpected = [...predicted].filter((key) => !expected.has(key));
  falsePositives += unexpected.length;
  if (!fixture.positive) {
    if (unexpected.length) {
      falsePositiveCases += 1;
      falsePositivePullRequests.add(fixture.pullRequest);
    } else trueNegativeCases += 1;
  }
  caseResults.push({ id: fixture.id, expected: [...expected], predicted: [...predicted], unexpected });

  const sourceFiles = fixture.files.map((file) => ({
    path: file.path,
    changedHeadLineRanges: file.changedHeadLineRanges,
    changedBaseLineRanges: file.changedBaseLineRanges,
    base: file.baseContent == null ? null : { content: file.baseContent, contentHash: "a".repeat(64) },
    head: { content: file.headContent, contentHash: "b".repeat(64) }
  }));
  const checked = validateFindings({ findings: analysis.findings, files: sourceFiles, repositoryId: "eval-fixture", hmacKey }).findings;
  const expectedLocations = new Set(fixture.expected.map((finding) => `${finding.ruleId}|${finding.path}|${finding.side}|${finding.startLine}`));
  for (const finding of checked) {
    if (finding.disposition !== "accepted") continue;
    evidenceReferencesTotal += 1;
    if (finding.evidence[0]?.contentHash && finding.evidence[0]?.snippet) evidenceReferencesAccurate += 1;
    const locationKey = `${finding.ruleId}|${finding.path}|${finding.side}|${finding.startLine}`;
    if (expectedLocations.has(locationKey) && finding.evidence[0]?.contentHash) evidenceAccurate += 1;
  }
}

const precision = predictedTotal ? truePositives / predictedTotal : 0;
const recall = truePositives + falseNegative ? truePositives / (truePositives + falseNegative) : 0;
const falsePositiveRate = dataset.cases.filter((item) => !item.positive).length
  ? falsePositiveCases / dataset.cases.filter((item) => !item.positive).length
  : 0;
const report = {
  datasetVersion: dataset.datasetVersion,
  caseCount: dataset.cases.length,
  positiveCaseCount: dataset.cases.filter((item) => item.positive).length,
  cleanCaseCount: dataset.cases.filter((item) => !item.positive).length,
  truePositives,
  falsePositives,
  falseNegatives: falseNegative,
  precision,
  recall,
  falsePositiveRate,
  falsePositiveRateDefinition: "clean cases with at least one unexpected finding / all clean cases",
  falsePositivePullRequests: falsePositivePullRequests.size,
  trueNegativeCases,
  evidenceAccuracy: evidenceReferencesTotal ? evidenceAccurate / evidenceReferencesTotal : null,
  evidenceAccuracyNumerator: evidenceAccurate,
  evidenceAccuracyDenominator: evidenceReferencesTotal,
  evidenceReferenceAccuracy: evidenceReferencesTotal ? evidenceReferencesAccurate / evidenceReferencesTotal : null,
  evidenceReferenceAccuracyNumerator: evidenceReferencesAccurate,
  evidenceReferenceAccuracyDenominator: evidenceReferencesTotal,
  falsePositivesPerPullRequest: dataset.cases.length ? falsePositives / dataset.cases.length : 0,
  duplicateFindings: duplicates,
  caseResults,
  patchValidity: (() => {
    const validFixtures = dataset.patchCases.filter((item) => item.expectedValid);
    const successful = validFixtures.filter((item) => {
      const sourceHash = createHash("sha256").update(item.source).digest("hex");
      const replaced = applyReplacement(item.source, item.startLine, item.endLine, item.proposedCode);
      return sourceHash === item.expectedFileHash && replaced != null && !parseSource("src/fixture.js", replaced).error;
    });
    return validFixtures.length ? successful.length / validFixtures.length : null;
  })(),
  patchValidityNumerator: dataset.patchCases.filter((item) => item.expectedValid && createHash("sha256").update(item.source).digest("hex") === item.expectedFileHash && applyReplacement(item.source, item.startLine, item.endLine, item.proposedCode) != null && !parseSource("src/fixture.js", applyReplacement(item.source, item.startLine, item.endLine, item.proposedCode)).error).length,
  patchValidityDenominator: dataset.patchCases.filter((item) => item.expectedValid).length,
  patchRejectionAccuracy: (() => {
    const invalidFixtures = dataset.patchCases.filter((item) => !item.expectedValid);
    const rejected = invalidFixtures.filter((item) => {
      const replaced = applyReplacement(item.source, item.startLine, item.endLine, item.proposedCode);
      return replaced == null || Boolean(parseSource("src/fixture.js", replaced).error);
    });
    return invalidFixtures.length ? rejected.length / invalidFixtures.length : null;
  })(),
  patchValidityNote: "Mechanical checks on controlled replacement fixtures only; this is not an AI proposal quality or behavioral-correctness score."
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
