const { createHash } = require("node:crypto");
const ReviewExecution = require("../models/review-execution.model");
const Finding = require("../models/finding.model");
const HistoricalOccurrence = require("../models/historical-occurrence.model");
const AnalysisArtifact = require("../models/analysis-artifact.model");
const { ANALYZER_VERSION } = require("../analysis/rule-catalog");
const { analyzeFiles } = require("../analysis/structural-analyzer");
const { assertSnapshotCurrent, fetchPullSnapshot } = require("./github-snapshot.service");
const { selectContext } = require("./context-selector.service");
const { validateFindings } = require("./finding-validator");
const { createDeadline } = require("../utils/deadline");

function safeFailureCode(error) {
  if (error.code === "STALE_REVISION") return "STALE_REVISION";
  if (error.code === "UPSTREAM_RESPONSE_LIMIT") return "UPSTREAM_RESPONSE_LIMIT";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "OPERATION_TIMEOUT";
  if (typeof error.code === "string" && /^[A-Z0-9_]{2,64}$/.test(error.code)) return error.code;
  return "REVIEW_FAILED";
}

function warning(code, message) { return { code, message }; }

// Diagnostic fields are an explicit allowlist: provider/model/stage/status/upstream code and a
// short sanitized upstream message. Never the request, response body, headers, keys, or source.
function safeAiFailureDetails(error, config = {}) {
  let reason = "provider_request_failed";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") reason = "timeout";
  else if (error?.code === "AI_RATE_LIMITED") reason = "rate_limited";
  else if (error?.name === "ZodError") reason = "invalid_structured_output";
  else if (error?.message === "AI provider returned invalid JSON.") reason = "invalid_json";
  else if (error?.message === "AI provider returned no structured content.") reason = "empty_response";
  else if (Number.isInteger(error?.upstreamStatus)) reason = "upstream_http_error";
  const timedOut = reason === "timeout";
  const zodPaths = error?.name === "ZodError" && Array.isArray(error.issues)
    ? error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    : undefined;
  return {
    reason,
    stage: typeof error?.stage === "string" ? error.stage : (timedOut ? "request" : "unknown"),
    ...(config.LLM_PROVIDER ? { provider: config.LLM_PROVIDER } : {}),
    ...(config.LLM_MODEL ? { model: config.LLM_MODEL } : {}),
    ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(typeof error?.upstreamCode === "string" ? { upstreamCode: error.upstreamCode } : {}),
    ...(typeof error?.upstreamMessage === "string" ? { upstreamMessage: error.upstreamMessage } : {}),
    ...(typeof error?.providerStatus === "string" ? { providerStatus: error.providerStatus } : {}),
    ...(typeof error?.incompleteReason === "string" ? { incompleteReason: error.incompleteReason } : {}),
    ...(zodPaths ? { schemaIssues: zodPaths } : {}),
    ...(timedOut ? { llmTimeoutMs: config.LLM_TIMEOUT_MS, operationTimeoutMs: config.OPERATION_TIMEOUT_MS } : {})
  };
}

function sourceMetadata(files) {
  return files.map((file) => ({
    path: file.path,
    status: file.status,
    baseBlobSha: file.base?.blobSha || null,
    headBlobSha: file.head?.blobSha || null,
    baseContentHash: file.base?.contentHash || null,
    headContentHash: file.head?.contentHash || null,
    diffHash: file.patch ? createHash("sha256").update(file.patch).digest("hex") : null,
    diffBytes: file.patchBytes || 0
  }));
}

function impactTrailFor(finding, contextResult) {
  if (!contextResult) return [];
  return contextResult.selected
    .filter((file) => file.reasonCodes.some((reason) => ["calls_changed_export", "imports_changed_module", "imported_by_changed_file", "model_used_by_changed_code", "middleware_for_changed_route", "test_for_changed_module"].includes(reason)))
    .slice(0, 8)
    .map((file) => ({
      path: file.path,
      relationship: file.reasonCodes[0],
      explanation: `This file was selected because it is related to the change (${file.reasonCodes.join(", ")}).`
    }));
}

function mapImpacts(findings, contextResult) {
  return findings.map((finding) => ({ ...finding, impactTrail: impactTrailFor(finding, contextResult) }));
}

async function historyFor(ReviewExecutionModel, repositoryId) {
  const filter = {
    repositoryId,
    status: { $in: ["completed", "partial"] },
    retentionState: "connected"
  };
  const [reviewedPullRequests, reviewedExecutions] = await Promise.all([
    ReviewExecutionModel.distinct("pullRequestNumber", filter),
    ReviewExecutionModel.countDocuments(filter)
  ]);
  return { reviewedPullRequests: reviewedPullRequests.length, reviewedExecutions };
}

async function attachRecurrence(HistoricalOccurrenceModel, findings, repositoryId) {
  const enriched = [];
  const occurrences = [];
  for (const finding of findings) {
    const previous = await HistoricalOccurrenceModel.find({
      repositoryId,
      fingerprintVersion: finding.fingerprintVersion,
      fingerprint: finding.fingerprint,
      retentionState: "connected"
    }).select("executionId matchKind").lean();
    const currentKind = finding.provenance === "deterministic" && finding.verification === "rule_checked" ? "confirmed" : "possible_ai";
    const comparable = previous.filter((item) => item.matchKind === currentKind);
    const comparableExecutions = new Set(comparable.map((item) => String(item.executionId)));
    enriched.push({
      ...finding,
      recurrence: {
        matchKind: comparable.length ? currentKind : "none",
        previousCount: comparable.length,
        comparableExecutionCount: comparableExecutions.size
      }
    });
    occurrences.push({
      repositoryId,
      pullRequestNumber: finding.pullRequestNumber,
      executionId: finding.executionId,
      findingId: finding._id,
      fingerprint: finding.fingerprint,
      fingerprintVersion: finding.fingerprintVersion,
      category: finding.category,
      ruleId: finding.ruleId || null,
      provenance: finding.provenance,
      verification: finding.verification,
      matchKind: currentKind,
      occurredAt: new Date()
    });
  }
  return { findings: enriched, occurrences };
}

function createReviewService(dependencies = {}) {
  const models = {
    ReviewExecution: dependencies.ReviewExecution || ReviewExecution,
    Finding: dependencies.Finding || Finding,
    HistoricalOccurrence: dependencies.HistoricalOccurrence || HistoricalOccurrence,
    AnalysisArtifact: dependencies.AnalysisArtifact || AnalysisArtifact
  };
  const fetchSnapshot = dependencies.fetchSnapshot || fetchPullSnapshot;
  const chooseContext = dependencies.selectContext || selectContext;
  const analyze = dependencies.analyze || analyzeFiles;
  const verifySnapshot = dependencies.assertSnapshotCurrent || assertSnapshotCurrent;

  return async function runReview({ repository, pullRequestNumber, accessToken, config, aiReview }) {
    const execution = await models.ReviewExecution.create({
      repositoryId: String(repository.githubRepositoryId),
      repositoryName: repository.fullName,
      pullRequestNumber: Number(pullRequestNumber),
      analyzerVersion: ANALYZER_VERSION,
      promptVersion: config.LLM_PROVIDER === "none" ? null : config.PROMPT_VERSION,
      providerConfiguration: {
        provider: config.LLM_PROVIDER,
        model: config.LLM_PROVIDER === "none" ? null : config.LLM_MODEL,
        timeoutMs: config.LLM_PROVIDER === "none" ? null : config.LLM_TIMEOUT_MS,
        maxOutputTokens: config.LLM_PROVIDER === "none" ? null : config.LLM_MAX_OUTPUT_TOKENS,
        maxAttempts: 1
      },
      limitSnapshot: {
        repositoryCandidateFiles: config.MAX_REPOSITORY_FILES,
        repositorySourceBytes: config.MAX_REPOSITORY_SOURCE_BYTES,
        parsedFileBytes: config.MAX_PARSED_FILE_BYTES,
        pullRequestChangedFiles: config.MAX_PR_CHANGED_FILES,
        pullRequestDiffBytes: config.MAX_PR_DIFF_BYTES,
        selectedContextBytes: config.MAX_CONTEXT_BYTES,
        operationTimeoutMs: config.OPERATION_TIMEOUT_MS
      },
      status: "created",
      stage: "snapshot",
      startedAt: new Date(),
      warnings: []
    });
    const warnings = [];
    const deadline = createDeadline(config.OPERATION_TIMEOUT_MS);
    const operationSignal = deadline.signal;
    let snapshotResult = null;
    let contextResult = null;
    let persistedFindings = false;

    try {
      execution.status = "running";
      await execution.save();
      snapshotResult = await fetchSnapshot({
        repository, pullRequestNumber, accessToken, config, signal: operationSignal,
        onSnapshotPinned: async (snapshot) => {
          execution.baseSha = snapshot.baseSha;
          execution.headSha = snapshot.headSha;
          await execution.save();
        }
      });
      warnings.push(...snapshotResult.warnings);
      execution.changedFiles = sourceMetadata(snapshotResult.files);
      await execution.save();

      execution.stage = "context";
      await execution.save();
      try {
        const remainingSourceBytes = Math.max(0, config.MAX_REPOSITORY_SOURCE_BYTES - snapshotResult.sourceBytes);
        if (remainingSourceBytes > 0) {
          contextResult = await chooseContext({
            repository,
            snapshot: snapshotResult.snapshot,
            changedFiles: snapshotResult.analyzerCandidates,
            accessToken,
            config: { ...config, MAX_REPOSITORY_SOURCE_BYTES: remainingSourceBytes },
            signal: operationSignal
          });
        } else {
          contextResult = {
            selected: [],
            manifest: { candidateCount: 0, inspectedCount: 0, fetchedBytes: 0, selectedBytes: 0, files: [] },
            warnings: [warning("REPOSITORY_SOURCE_LIMIT", "Related source was skipped because the repository source-data limit was reached.")]
          };
        }
        warnings.push(...contextResult.warnings);
        const selectedHashes = new Map(contextResult.selected.map((file) => [file.path, file.contentHash]));
        execution.contextManifest = {
          ...contextResult.manifest,
          files: contextResult.manifest.files.map((file) => ({ ...file, contentHash: selectedHashes.get(file.path) || null }))
        };
      } catch {
        warnings.push(warning("CONTEXT_SELECTION_FAILED", "Related source could not be fully selected; the review used changed files only."));
      }
      await execution.save();

      execution.stage = "deterministic";
      await execution.save();
      const analysisResult = analyze(snapshotResult.analyzerCandidates, { maxFileBytes: config.MAX_PARSED_FILE_BYTES });
      for (const skipped of analysisResult.skipped) {
        warnings.push(warning("ANALYZER_FILE_SKIPPED", `Analysis skipped ${skipped.path} (${skipped.reason}).`));
      }

      let aiFindings = [];
      if (typeof aiReview === "function") {
        execution.stage = "ai";
        await execution.save();
        try {
          const aiResult = await aiReview({
            repository,
            snapshot: snapshotResult.snapshot,
            changedFiles: snapshotResult.files,
            contextFiles: contextResult?.selected || [],
            deterministicFindings: analysisResult.findings,
            structuralArtifacts: analysisResult.artifacts
          }, operationSignal);
          aiFindings = aiResult.findings || [];
          execution.providerName = aiResult.providerName || null;
          execution.providerModel = aiResult.model || null;
          execution.promptVersion = aiResult.promptVersion || null;
        } catch (error) {
          console.warn("ai_provider_failed", safeAiFailureDetails(error, config));
          warnings.push(warning("AI_PROVIDER_FAILED", "AI analysis could not complete; deterministic findings are shown."));
        }
      } else {
        warnings.push(warning("AI_NOT_CONFIGURED", "AI analysis is not configured; only deterministic results are available."));
      }

      execution.stage = "validation";
      await execution.save();
      const candidates = mapImpacts([...analysisResult.findings, ...aiFindings], contextResult);
      const validation = validateFindings({
        findings: candidates,
        files: snapshotResult.files,
        repositoryId: String(repository.githubRepositoryId),
        hmacKey: config.FINGERPRINT_HMAC_KEY
      });
      const accepted = validation.findings.filter((finding) => finding.disposition === "accepted");
      if (validation.rejectedCount) warnings.push(warning("FINDINGS_REJECTED", `${validation.rejectedCount} candidate finding(s) did not match the pinned source and were excluded.`));

      execution.stage = "final_revision_check";
      await execution.save();
      await verifySnapshot({ repository, pullRequestNumber, accessToken, snapshot: snapshotResult.snapshot, config, signal: operationSignal });

      execution.stage = "persistence";
      const previousHistory = await historyFor(models.ReviewExecution, String(repository.githubRepositoryId));
      const executionId = execution._id;
      const withRecurrence = await attachRecurrence(models.HistoricalOccurrence, accepted.map((finding) => ({
        ...finding,
        executionId,
        repositoryId: String(repository.githubRepositoryId),
        pullRequestNumber: Number(pullRequestNumber),
        baseSha: snapshotResult.snapshot.baseSha,
        headSha: snapshotResult.snapshot.headSha
      })), String(repository.githubRepositoryId));

      let createdFindings = [];
      if (withRecurrence.findings.length) {
        createdFindings = await models.Finding.insertMany(withRecurrence.findings, { ordered: true });
        persistedFindings = true;
        const occurrences = withRecurrence.occurrences.map((occurrence, index) => ({ ...occurrence, findingId: createdFindings[index]._id }));
        await models.HistoricalOccurrence.insertMany(occurrences, { ordered: true });
      }
      const structuralArtifacts = analysisResult.artifacts || [];
      if (structuralArtifacts.length) {
        const sourceHashes = new Map(sourceMetadata(snapshotResult.files).map((file) => [file.path, file.headContentHash]));
        const artifacts = structuralArtifacts.map((artifact) => ({
          ...artifact,
          executionId,
          repositoryId: String(repository.githubRepositoryId),
          pullRequestNumber: Number(pullRequestNumber),
          baseSha: snapshotResult.snapshot.baseSha,
          headSha: snapshotResult.snapshot.headSha,
          headContentHash: sourceHashes.get(artifact.path) || null
        }));
        await models.AnalysisArtifact.insertMany(artifacts, { ordered: true });
        persistedFindings = true;
      }

      await verifySnapshot({ repository, pullRequestNumber, accessToken, snapshot: snapshotResult.snapshot, config, signal: operationSignal });

      const deterministicUsable = snapshotResult.analyzerCandidates.length > 0;
      const status = warnings.length
        ? (deterministicUsable ? "partial" : "failed")
        : "completed";
      execution.status = status;
      execution.stage = "finished";
      execution.finishedAt = new Date();
      execution.warnings = warnings;
      execution.historyCoverage = {
        reviewedPullRequests: previousHistory.reviewedPullRequests,
        reviewedExecutions: previousHistory.reviewedExecutions,
        comparableExecutions: previousHistory.reviewedExecutions,
        confirmedMatches: createdFindings.filter((finding) => finding.recurrence?.matchKind === "confirmed").length,
        possibleAiMatches: createdFindings.filter((finding) => finding.recurrence?.matchKind === "possible_ai").length
      };
      execution.qualitySummary = {
        totalFindings: createdFindings.length,
        evidenceChecked: createdFindings.filter((finding) => finding.verification === "evidence_checked").length,
        ruleChecked: createdFindings.filter((finding) => finding.verification === "rule_checked").length,
        hypotheses: createdFindings.filter((finding) => finding.provenance === "ai").length,
        rejectedCandidates: validation.rejectedCount,
        analyzedChangedFiles: snapshotResult.analyzerCandidates.length,
        changedFileCoverage: snapshotResult.files.length ? snapshotResult.analyzerCandidates.length / snapshotResult.files.length : 0,
        analysisLimits: [...new Set(warnings.map((item) => item.code))]
      };
      await execution.save();
      return { execution, findings: createdFindings };
    } catch (error) {
      if (persistedFindings) {
        await models.Finding.deleteMany({ executionId: execution._id }).catch(() => {});
        await models.HistoricalOccurrence.deleteMany({ executionId: execution._id }).catch(() => {});
        await models.AnalysisArtifact.deleteMany({ executionId: execution._id }).catch(() => {});
      }
      const code = safeFailureCode(error);
      execution.status = code === "STALE_REVISION" ? "stale" : "failed";
      execution.failureCode = code;
      execution.stage = "finished";
      execution.finishedAt = new Date();
      execution.warnings = [...warnings, warning(code, code === "STALE_REVISION"
        ? "The pull request changed during review. Run a new review for the current revision."
        : code === "OPERATION_TIMEOUT"
          ? "The review exceeded its time limit. Try again with a smaller change set."
          : "The review could not finish. Check the review details and try again.")];
      await execution.save().catch(() => {});
      return { execution, findings: [] };
    } finally {
      deadline.dispose();
    }
  };
}

module.exports = { createReviewService, safeAiFailureDetails };