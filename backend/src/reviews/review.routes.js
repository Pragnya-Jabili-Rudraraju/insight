const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");
const ReviewExecution = require("../models/review-execution.model");
const Finding = require("../models/finding.model");
const HistoricalOccurrence = require("../models/historical-occurrence.model");
const PatchProposal = require("../models/patch-proposal.model");
const AnalysisArtifact = require("../models/analysis-artifact.model");
const SelectedRepository = require("../models/selected-repository.model");
const { createRequireGitHubAccess } = require("../auth/auth-middleware");
const { requireCsrf } = require("../security/csrf");
const { createReviewService } = require("./review.service");
const { invalidateCurrentCredential } = require("../auth/token-service");
const { getConcept } = require("../concepts/concept-catalog");

function createReviewRouter(config, dependencies = {}) {
  const router = express.Router();
  const requireGitHub = createRequireGitHubAccess(config);
  const runReview = dependencies.runReview || createReviewService(dependencies);

  router.post("/reviews", requireGitHub, requireCsrf, async (req, res, next) => {
    const parsed = z.object({ repositoryId: z.string().regex(/^\d+$/), pullRequestNumber: z.coerce.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: "INVALID_REVIEW_REQUEST", message: "Select a repository and a valid pull request.", retryable: false, requestId: req.requestId } });
    try {
      const repository = await SelectedRepository.findOne({ githubRepositoryId: parsed.data.repositoryId, accessStatus: "active" });
      if (!repository) return res.status(404).json({ error: { code: "REPOSITORY_NOT_SELECTED", message: "This repository is not selected or is no longer accessible.", retryable: false, requestId: req.requestId } });
      const result = await runReview({
        repository,
        pullRequestNumber: parsed.data.pullRequestNumber,
        accessToken: req.githubAccessToken,
        config,
        aiReview: dependencies.aiReview
      });
      if (result.execution.failureCode === "GITHUB_REAUTH_REQUIRED") {
        await invalidateCurrentCredential().catch(() => {});
        return res.status(401).json({ error: { code: "GITHUB_REAUTH_REQUIRED", message: "Reconnect GitHub to continue.", retryable: false, requestId: req.requestId, executionId: String(result.execution._id) } });
      }
      return res.status(201).json({
        execution: result.execution.toJSON ? result.execution.toJSON() : result.execution,
        findings: result.findings.map((finding) => finding.toJSON ? finding.toJSON() : finding)
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/reviews/:executionId", requireGitHub, async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.executionId)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Review execution was not found.", retryable: false, requestId: req.requestId } });
    try {
      const execution = await ReviewExecution.findById(req.params.executionId).lean();
      if (!execution) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Review execution was not found.", retryable: false, requestId: req.requestId } });
      const repository = await SelectedRepository.findOne({ githubRepositoryId: execution.repositoryId, accessStatus: "active" }).lean();
      if (!repository) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Review execution was not found.", retryable: false, requestId: req.requestId } });
      return res.json({ execution });
    } catch (error) { return next(error); }
  });

  router.get("/reviews/:executionId/findings", requireGitHub, async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.executionId)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Review execution was not found.", retryable: false, requestId: req.requestId } });
    const limit = z.coerce.number().int().min(1).max(config.MAX_FINDINGS_PER_RESPONSE).catch(Math.min(50, config.MAX_FINDINGS_PER_RESPONSE)).parse(req.query.limit);
    const cursor = typeof req.query.cursor === "string" && mongoose.isValidObjectId(req.query.cursor) ? req.query.cursor : null;
    try {
      const execution = await ReviewExecution.findById(req.params.executionId).select("repositoryId").lean();
      if (!execution || !await SelectedRepository.exists({ githubRepositoryId: execution.repositoryId, accessStatus: "active" })) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Review execution was not found.", retryable: false, requestId: req.requestId } });
      }
      const query = { executionId: execution._id, disposition: "accepted" };
      if (cursor) query._id = { $lt: cursor };
      const findings = await Finding.find(query).sort({ _id: -1 }).limit(limit + 1).lean();
      const hasMore = findings.length > limit;
      const page = hasMore ? findings.slice(0, limit) : findings;
      return res.json({ findings: page, nextCursor: hasMore ? String(page[page.length - 1]._id) : null, limit, hasMore });
    } catch (error) { return next(error); }
  });

  router.get("/reviews/:executionId/findings/:findingId/concept", requireGitHub, async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.executionId) || !mongoose.isValidObjectId(req.params.findingId)) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Finding concept was not found.", retryable: false, requestId: req.requestId } });
    }
    try {
      const execution = await ReviewExecution.findById(req.params.executionId).select("repositoryId").lean();
      if (!execution || !await SelectedRepository.exists({ githubRepositoryId: execution.repositoryId, accessStatus: "active" })) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Finding concept was not found.", retryable: false, requestId: req.requestId } });
      }
      const finding = await Finding.findOne({ _id: req.params.findingId, executionId: execution._id, disposition: "accepted" }).select("conceptId ruleId").lean();
      const conceptId = finding?.conceptId || null;
      const concept = conceptId && getConcept(conceptId);
      if (!concept) return res.status(404).json({ error: { code: "CONCEPT_UNAVAILABLE", message: "No concept note is available for this finding.", retryable: false, requestId: req.requestId } });
      return res.json({ conceptId, ...concept, whyItRelates: `This concept relates to finding ${finding.ruleId || "AI-assisted review"}.` });
    } catch (error) { return next(error); }
  });

  router.get("/repositories/:repositoryId/history", requireGitHub, async (req, res, next) => {
    if (!/^\d+$/.test(req.params.repositoryId)) return res.status(400).json({ error: { code: "INVALID_REPOSITORY_ID", message: "Repository ID is invalid.", retryable: false, requestId: req.requestId } });
    const limit = z.coerce.number().int().min(1).max(config.MAX_HISTORY_EXECUTIONS_PER_RESPONSE).catch(Math.min(50, config.MAX_HISTORY_EXECUTIONS_PER_RESPONSE)).parse(req.query.limit);
    const cursor = typeof req.query.cursor === "string" && mongoose.isValidObjectId(req.query.cursor) ? req.query.cursor : null;
    try {
      if (!await SelectedRepository.exists({ githubRepositoryId: req.params.repositoryId, accessStatus: "active" })) {
        return res.status(404).json({ error: { code: "REPOSITORY_NOT_SELECTED", message: "This repository is not selected or is no longer accessible.", retryable: false, requestId: req.requestId } });
      }
      const query = { repositoryId: req.params.repositoryId, retentionState: "connected" };
      if (cursor) query._id = { $lt: cursor };
      const executions = await ReviewExecution.find(query).sort({ _id: -1 }).limit(limit + 1).lean();
      const hasMore = executions.length > limit;
      const page = hasMore ? executions.slice(0, limit) : executions;
      const maxRecords = config.MAX_HISTORY_AGGREGATE_RECORDS;
      const maxRows = config.MAX_HISTORY_AGGREGATE_ROWS;
      const occurrenceMatch = { repositoryId: req.params.repositoryId, retentionState: "connected" };
      const executionMatch = { repositoryId: req.params.repositoryId, retentionState: "connected" };
      const completedMatch = { ...executionMatch, status: { $in: ["completed", "partial"] } };
      const findingMatch = { repositoryId: req.params.repositoryId, retentionState: "connected", disposition: "accepted" };
      const [occurrenceAvailable, executionAvailable, completedAvailable, findingAvailable] = await Promise.all([
        HistoricalOccurrence.countDocuments(occurrenceMatch),
        ReviewExecution.countDocuments(executionMatch),
        ReviewExecution.countDocuments(completedMatch),
        Finding.countDocuments(findingMatch)
      ]);
      const [occurrencesRaw, executionSample, completedSample, findingCountsRaw] = await Promise.all([
        HistoricalOccurrence.aggregate([
          { $match: occurrenceMatch }, { $sort: { occurredAt: -1, _id: -1 } }, { $limit: maxRecords },
          { $group: { _id: { fingerprint: "$fingerprint", fingerprintVersion: "$fingerprintVersion", matchKind: "$matchKind" }, count: { $sum: 1 }, executions: { $addToSet: "$executionId" } } },
          { $project: { fingerprint: "$_id.fingerprint", fingerprintVersion: "$_id.fingerprintVersion", matchKind: "$_id.matchKind", count: 1, comparableExecutionCount: { $size: "$executions" } } },
          { $sort: { count: -1, fingerprint: 1 } }, { $limit: maxRows + 1 }
        ]),
        ReviewExecution.find(executionMatch).select("status pullRequestNumber changedFiles qualitySummary").sort({ createdAt: -1, _id: -1 }).limit(maxRecords).lean(),
        ReviewExecution.find(completedMatch).select("pullRequestNumber changedFiles qualitySummary").sort({ createdAt: -1, _id: -1 }).limit(maxRecords).lean(),
        Finding.aggregate([
          { $match: findingMatch }, { $sort: { createdAt: -1, _id: -1 } }, { $limit: maxRecords },
          { $group: { _id: { provenance: "$provenance", verification: "$verification" }, count: { $sum: 1 } } },
          { $sort: { count: -1 } }, { $limit: maxRows + 1 }
        ])
      ]);
      const recurrenceTruncated = occurrencesRaw.length > maxRows;
      const occurrences = recurrenceTruncated ? occurrencesRaw.slice(0, maxRows) : occurrencesRaw;
      const findingCounts = findingCountsRaw.slice(0, maxRows);
      const statusCount = (name) => executionSample.filter((item) => item.status === name).length;
      const findingCount = (provenance, verification) => findingCounts.find((item) => item._id.provenance === provenance && item._id.verification === verification)?.count || 0;
      const aggregationIncomplete = occurrenceAvailable > maxRecords || executionAvailable > maxRecords || completedAvailable > maxRecords || findingAvailable > maxRecords || recurrenceTruncated || findingCountsRaw.length > maxRows;
      const changedFilesRetrieved = completedSample.reduce((sum, run) => sum + run.changedFiles.length, 0);
      const changedFilesAnalyzed = completedSample.reduce((sum, run) => sum + run.qualitySummary.analyzedChangedFiles, 0);
      const reviewedPullRequests = new Set(completedSample.map((run) => run.pullRequestNumber)).size;
      const aggregationRecordsAnalyzed = [occurrenceAvailable, executionAvailable, completedAvailable, findingAvailable]
        .reduce((sum, available) => sum + Math.min(available, maxRecords), 0);
      return res.json({
        executions: page,
        nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
        limit,
        hasMore,
        coverage: {
          reviewedPullRequests,
          reviewedExecutions: Math.min(completedAvailable, maxRecords),
          reviewedExecutionsAvailable: completedAvailable,
          changedFilesRetrieved,
          changedFilesAnalyzed,
          completedRuns: statusCount("completed"),
          partialRuns: statusCount("partial"),
          failedRuns: statusCount("failed"),
          staleRuns: statusCount("stale"),
          evidenceCheckedFindings: findingCount("ai", "evidence_checked"),
          ruleCheckedFindings: findingCount("deterministic", "rule_checked"),
          hypothesisFindings: findingCounts.filter((item) => item._id.provenance === "ai").reduce((sum, item) => sum + item.count, 0),
          findingDetailRetentionDays: config.CONNECTED_RETENTION_DAYS,
          aggregationIncomplete,
          aggregationRecordsAnalyzed,
          aggregationRecordLimit: maxRecords
        },
        recurrence: occurrences,
        recurrenceCoverage: {
          occurrencesAvailable: occurrenceAvailable,
          occurrencesAnalyzed: Math.min(occurrenceAvailable, maxRecords),
          fingerprintsReturned: occurrences.length,
          fingerprintLimit: maxRows,
          complete: occurrenceAvailable <= maxRecords && !recurrenceTruncated
        }
      });
    } catch (error) { return next(error); }
  });

  router.delete("/repositories/:repositoryId/history", requireGitHub, requireCsrf, async (req, res, next) => {
    if (!/^\d+$/.test(req.params.repositoryId)) return res.status(400).json({ error: { code: "INVALID_REPOSITORY_ID", message: "Repository ID is invalid.", retryable: false, requestId: req.requestId } });
    try {
      if (!await SelectedRepository.exists({ githubRepositoryId: req.params.repositoryId, accessStatus: "active" })) {
        return res.status(404).json({ error: { code: "REPOSITORY_NOT_SELECTED", message: "This repository is not selected or is no longer accessible.", retryable: false, requestId: req.requestId } });
      }
      const executions = await ReviewExecution.find({ repositoryId: req.params.repositoryId }).select("_id").lean();
      const executionIds = executions.map((item) => item._id);
      await Promise.all([
        Finding.deleteMany({ repositoryId: req.params.repositoryId }),
        HistoricalOccurrence.deleteMany({ repositoryId: req.params.repositoryId }),
        PatchProposal.deleteMany({ repositoryId: req.params.repositoryId }),
        AnalysisArtifact.deleteMany({ repositoryId: req.params.repositoryId }),
        ReviewExecution.deleteMany({ repositoryId: req.params.repositoryId })
      ]);
      return res.json({ deletedExecutions: executionIds.length });
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = { createReviewRouter };
