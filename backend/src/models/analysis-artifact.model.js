const mongoose = require("mongoose");

const importSchema = new mongoose.Schema({
  source: { type: String, required: true, maxlength: 500 },
  names: { type: [String], default: [] }
}, { _id: false });
const signatureChangeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  from: { type: [String], default: [] },
  to: { type: [String], default: [] }
}, { _id: false });
const exportSchema = new mongoose.Schema({
  name: { type: String, required: true },
  signature: { type: [String], default: null }
}, { _id: false });

const analysisArtifactSchema = new mongoose.Schema({
  executionId: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewExecution", required: true },
  repositoryId: { type: String, required: true },
  pullRequestNumber: { type: Number, required: true },
  baseSha: { type: String, required: true },
  headSha: { type: String, required: true },
  path: { type: String, required: true },
  headContentHash: { type: String, default: null },
  imports: { type: [importSchema], default: [] },
  exports: { type: [exportSchema], default: [] },
  structuralChanges: {
    importsAdded: { type: [importSchema], default: [] },
    importsRemoved: { type: [importSchema], default: [] },
    exportsAdded: { type: [String], default: [] },
    exportsRemoved: { type: [String], default: [] },
    signaturesChanged: { type: [signatureChangeSchema], default: [] }
  },
  retentionState: { type: String, enum: ["connected", "uninstall_grace", "purged"], default: "connected", index: true },
  gracePurgeAt: { type: Date, default: null, index: true }
}, { timestamps: true, versionKey: false });

analysisArtifactSchema.index({ executionId: 1, path: 1 }, { unique: true });
analysisArtifactSchema.index({ repositoryId: 1, path: 1, headSha: 1 });

module.exports = mongoose.models.AnalysisArtifact || mongoose.model("AnalysisArtifact", analysisArtifactSchema);
