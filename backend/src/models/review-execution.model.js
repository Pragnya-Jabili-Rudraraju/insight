const mongoose = require("mongoose");

const sourceFileSchema = new mongoose.Schema({
  path: { type: String, required: true },
  status: { type: String, required: true },
  baseBlobSha: { type: String, default: null },
  headBlobSha: { type: String, default: null },
  baseContentHash: { type: String, default: null },
  headContentHash: { type: String, default: null },
  diffHash: { type: String, default: null },
  diffBytes: { type: Number, default: 0 }
}, { _id: false });

const contextFileSchema = new mongoose.Schema({
  path: { type: String, required: true },
  selected: { type: Boolean, required: true },
  reasonCodes: { type: [String], default: [] },
  candidateReasonCodes: { type: [String], default: undefined },
  contentHash: { type: String, default: null },
  bytes: { type: Number, default: 0 }
}, { _id: false });

const warningSchema = new mongoose.Schema({
  code: { type: String, required: true },
  message: { type: String, required: true }
}, { _id: false });

const reviewExecutionSchema = new mongoose.Schema({
  repositoryId: { type: String, required: true },
  repositoryName: { type: String, required: true },
  pullRequestNumber: { type: Number, required: true },
  baseSha: { type: String, default: null },
  headSha: { type: String, default: null },
  analyzerVersion: { type: String, required: true },
  promptVersion: { type: String, default: null },
  providerName: { type: String, enum: ["openai", "anthropic", "gemini", "groq", null], default: null },
  providerModel: { type: String, default: null },
  providerConfiguration: {
    provider: { type: String, enum: ["none", "openai", "anthropic", "gemini", "groq"], default: "none" },
    model: { type: String, default: null },
    timeoutMs: { type: Number, default: null },
    maxOutputTokens: { type: Number, default: null },
    maxAttempts: { type: Number, default: 1 }
  },
  limitSnapshot: {
    repositoryCandidateFiles: { type: Number, required: true },
    repositorySourceBytes: { type: Number, required: true },
    parsedFileBytes: { type: Number, required: true },
    pullRequestChangedFiles: { type: Number, required: true },
    pullRequestDiffBytes: { type: Number, required: true },
    selectedContextBytes: { type: Number, required: true },
    operationTimeoutMs: { type: Number, required: true }
  },
  status: { type: String, enum: ["created", "running", "completed", "partial", "failed", "stale"], required: true, index: true },
  stage: { type: String, enum: ["snapshot", "context", "deterministic", "ai", "validation", "final_revision_check", "persistence", "finished"], default: "snapshot" },
  failureCode: { type: String, default: null },
  startedAt: { type: Date, required: true, default: Date.now },
  finishedAt: { type: Date, default: null },
  changedFiles: { type: [sourceFileSchema], default: [] },
  contextManifest: {
    candidateCount: { type: Number, default: 0 },
    inspectedCount: { type: Number, default: 0 },
    fetchedBytes: { type: Number, default: 0 },
    selectedBytes: { type: Number, default: 0 },
    files: { type: [contextFileSchema], default: [] }
  },
  qualitySummary: {
    totalFindings: { type: Number, default: 0 },
    evidenceChecked: { type: Number, default: 0 },
    ruleChecked: { type: Number, default: 0 },
    hypotheses: { type: Number, default: 0 },
    rejectedCandidates: { type: Number, default: 0 },
    analyzedChangedFiles: { type: Number, default: 0 },
    changedFileCoverage: { type: Number, default: 0 },
    analysisLimits: { type: [String], default: [] }
  },
  warnings: { type: [warningSchema], default: [] },
  historyCoverage: {
    reviewedPullRequests: { type: Number, default: 0 },
    reviewedExecutions: { type: Number, default: 0 },
    comparableExecutions: { type: Number, default: 0 },
    confirmedMatches: { type: Number, default: 0 },
    possibleAiMatches: { type: Number, default: 0 }
  },
  retentionState: { type: String, enum: ["connected", "uninstall_grace", "purged"], default: "connected", index: true },
  gracePurgeAt: { type: Date, default: null, index: true }
}, { timestamps: true, versionKey: false });

reviewExecutionSchema.index({ repositoryId: 1, pullRequestNumber: 1, createdAt: -1 });
reviewExecutionSchema.index({ repositoryId: 1, retentionState: 1, createdAt: -1 });
reviewExecutionSchema.index({ repositoryId: 1, headSha: 1, createdAt: -1 });
reviewExecutionSchema.index({ status: 1, startedAt: -1 });

module.exports = mongoose.models.ReviewExecution || mongoose.model("ReviewExecution", reviewExecutionSchema);