const mongoose = require("mongoose");

const patchProposalSchema = new mongoose.Schema({
  executionId: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewExecution", required: true },
  findingId: { type: mongoose.Schema.Types.ObjectId, ref: "Finding", required: true },
  repositoryId: { type: String, required: true },
  pullRequestNumber: { type: Number, required: true },
  expectedHeadSha: { type: String, required: true },
  path: { type: String, required: true },
  expectedFileHash: { type: String, required: true },
  originalCode: { type: String, required: true, maxlength: 100000 },
  proposedCode: { type: String, required: true, maxlength: 100000 },
  unifiedDiff: { type: String, required: true, maxlength: 200000 },
  validationStatus: { type: String, enum: ["valid", "invalid", "stale", "unverified"], required: true },
  validationMessage: { type: String, default: null, maxlength: 1000 },
  contentDeleted: { type: Boolean, default: false },
  providerName: { type: String, enum: ["openai", "anthropic", "gemini", "groq"], required: true },
  providerModel: { type: String, required: true },
  retentionState: { type: String, enum: ["connected", "uninstall_grace", "purged"], default: "connected", index: true },
  gracePurgeAt: { type: Date, default: null, index: true }
}, { timestamps: true, versionKey: false });

patchProposalSchema.index({ executionId: 1, findingId: 1, createdAt: -1 });
patchProposalSchema.index({ repositoryId: 1, pullRequestNumber: 1, expectedHeadSha: 1, path: 1 });

module.exports = mongoose.models.PatchProposal || mongoose.model("PatchProposal", patchProposalSchema);