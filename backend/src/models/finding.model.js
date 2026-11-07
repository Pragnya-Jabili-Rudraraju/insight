const mongoose = require("mongoose");

const evidenceSchema = new mongoose.Schema({
  path: { type: String, required: true },
  side: { type: String, enum: ["base", "head"], required: true },
  startLine: { type: Number, required: true, min: 1 },
  endLine: { type: Number, required: true, min: 1 },
  snippet: { type: String, required: true, maxlength: 4000 },
  contentHash: { type: String, required: true }
}, { _id: false });

const impactItemSchema = new mongoose.Schema({
  path: { type: String, required: true },
  relationship: { type: String, required: true },
  explanation: { type: String, required: true, maxlength: 500 }
}, { _id: false });

const findingSchema = new mongoose.Schema({
  executionId: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewExecution", required: true },
  repositoryId: { type: String, required: true },
  pullRequestNumber: { type: Number, required: true },
  baseSha: { type: String, required: true },
  headSha: { type: String, required: true },
  ruleId: { type: String, default: null },
  category: { type: String, required: true },
  severity: { type: String, enum: ["critical", "high", "medium", "low", "info"], required: true },
  title: { type: String, required: true, maxlength: 180 },
  explanation: { type: String, required: true, maxlength: 1500 },
  path: { type: String, required: true },
  side: { type: String, enum: ["base", "head"], required: true },
  startLine: { type: Number, required: true, min: 1 },
  endLine: { type: Number, required: true, min: 1 },
  evidence: { type: [evidenceSchema], default: [] },
  suggestedImprovement: { type: String, required: true, maxlength: 1500 },
  confidence: { type: String, enum: ["low", "medium", "high"], required: true },
  provenance: { type: String, enum: ["deterministic", "ai"], required: true },
  providerName: { type: String, enum: ["openai", "anthropic", "gemini", "groq", null], default: null },
  providerModel: { type: String, default: null },
  verification: { type: String, enum: ["unverified", "evidence_checked", "rule_checked"], required: true },
  disposition: { type: String, enum: ["candidate", "accepted", "rejected"], required: true },
  validationMessage: { type: String, default: null, maxlength: 500 },
  fingerprint: { type: String, required: true },
  fingerprintVersion: { type: String, required: true },
  testGuidance: { type: String, default: null, maxlength: 1500 },
  testCode: { type: String, default: null, maxlength: 10000 },
  conceptId: { type: String, default: null },
  impactTrail: { type: [impactItemSchema], default: [] },
  recurrence: {
    matchKind: { type: String, enum: ["confirmed", "possible_ai", "none"], default: "none" },
    previousCount: { type: Number, default: 0 },
    comparableExecutionCount: { type: Number, default: 0 }
  },
  retentionState: { type: String, enum: ["connected", "uninstall_grace", "purged"], default: "connected", index: true },
  gracePurgeAt: { type: Date, default: null, index: true }
}, { timestamps: true, versionKey: false });

findingSchema.index({ executionId: 1, createdAt: 1 });
findingSchema.index({ repositoryId: 1, fingerprintVersion: 1, fingerprint: 1, createdAt: -1 });
findingSchema.index({ repositoryId: 1, pullRequestNumber: 1, headSha: 1 });
findingSchema.index({ repositoryId: 1, retentionState: 1, createdAt: -1 });
findingSchema.index({ severity: 1, category: 1, createdAt: -1 });

module.exports = mongoose.models.Finding || mongoose.model("Finding", findingSchema);