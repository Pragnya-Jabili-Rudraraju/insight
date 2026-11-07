const mongoose = require("mongoose");

const historicalOccurrenceSchema = new mongoose.Schema({
  repositoryId: { type: String, required: true },
  pullRequestNumber: { type: Number, required: true },
  executionId: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewExecution", required: true },
  findingId: { type: mongoose.Schema.Types.ObjectId, ref: "Finding", required: true },
  fingerprint: { type: String, required: true },
  fingerprintVersion: { type: String, required: true },
  category: { type: String, required: true },
  ruleId: { type: String, default: null },
  provenance: { type: String, enum: ["deterministic", "ai"], required: true },
  verification: { type: String, enum: ["unverified", "evidence_checked", "rule_checked"], required: true },
  matchKind: { type: String, enum: ["confirmed", "possible_ai"], required: true },
  occurredAt: { type: Date, required: true },
  retentionState: { type: String, enum: ["connected", "uninstall_grace", "purged"], default: "connected", index: true },
  gracePurgeAt: { type: Date, default: null, index: true }
}, { timestamps: true, versionKey: false });

historicalOccurrenceSchema.index({ repositoryId: 1, fingerprintVersion: 1, fingerprint: 1, occurredAt: -1 });
historicalOccurrenceSchema.index({ repositoryId: 1, executionId: 1 });
historicalOccurrenceSchema.index({ repositoryId: 1, retentionState: 1, occurredAt: -1 });
historicalOccurrenceSchema.index({ repositoryId: 1, matchKind: 1, occurredAt: -1 });

module.exports = mongoose.models.HistoricalOccurrence || mongoose.model("HistoricalOccurrence", historicalOccurrenceSchema);
