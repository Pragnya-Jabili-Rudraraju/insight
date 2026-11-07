const mongoose = require("mongoose");

const githubCredentialSchema = new mongoose.Schema({
  singletonKey: { type: String, required: true, unique: true, default: "primary" },
  githubUserId: { type: String, required: true, index: true },
  githubLogin: { type: String, required: true },
  encryptedAccessToken: { type: String, select: false },
  encryptedRefreshToken: { type: String, select: false },
  accessTokenExpiresAt: { type: Date },
  refreshTokenExpiresAt: { type: Date },
  status: { type: String, enum: ["active", "reauthorization_required", "revoked"], default: "active", index: true },
  lastAuthenticatedAt: { type: Date, required: true }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.GitHubCredential || mongoose.model("GitHubCredential", githubCredentialSchema);
