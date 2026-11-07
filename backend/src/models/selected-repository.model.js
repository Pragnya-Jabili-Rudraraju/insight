const mongoose = require("mongoose");

const selectedRepositorySchema = new mongoose.Schema({
  githubRepositoryId: { type: String, required: true, unique: true },
  installationId: { type: String, required: true, index: true },
  fullName: { type: String, required: true },
  isPrivate: { type: Boolean, required: true },
  selectedAt: { type: Date, required: true, default: Date.now },
  accessStatus: { type: String, enum: ["active", "suspended", "uninstalled", "unselected", "reauthorization_required"], default: "active", index: true },
  revokedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.SelectedRepository || mongoose.model("SelectedRepository", selectedRepositorySchema);
