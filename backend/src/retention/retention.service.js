const ReviewExecution = require("../models/review-execution.model");
const Finding = require("../models/finding.model");
const PatchProposal = require("../models/patch-proposal.model");
const HistoricalOccurrence = require("../models/historical-occurrence.model");
const SelectedRepository = require("../models/selected-repository.model");
const GitHubCredential = require("../models/github-credential.model");
const AnalysisArtifact = require("../models/analysis-artifact.model");
const { invalidateCredential } = require("../auth/token-service");

function graceExpiry(config, now = new Date()) {
  return new Date(now.getTime() + config.UNINSTALL_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

async function sanitizeRepositoryData(repositoryIds, gracePurgeAt) {
  if (!repositoryIds.length) return;
  const executionFilter = { repositoryId: { $in: repositoryIds } };
  const findingFilter = { repositoryId: { $in: repositoryIds } };
  const patchFilter = { repositoryId: { $in: repositoryIds } };
  const occurrenceFilter = { repositoryId: { $in: repositoryIds } };
  await Promise.all([
    ReviewExecution.updateMany(executionFilter, {
      $set: { retentionState: "uninstall_grace", gracePurgeAt, changedFiles: [], "contextManifest.files": [] }
    }),
    Finding.updateMany(findingFilter, {
      $set: { retentionState: "uninstall_grace", gracePurgeAt },
      $unset: {
        evidence: "", title: "", explanation: "", path: "", side: "", startLine: "", endLine: "",
        suggestedImprovement: "", testGuidance: "", testCode: "", impactTrail: "", conceptId: "", validationMessage: ""
      }
    }),
    PatchProposal.updateMany(patchFilter, {
      $set: { retentionState: "uninstall_grace", gracePurgeAt, contentDeleted: true, validationStatus: "stale" },
      $unset: { originalCode: "", proposedCode: "", unifiedDiff: "" }
    }),
    AnalysisArtifact.deleteMany(executionFilter),
    HistoricalOccurrence.updateMany(occurrenceFilter, { $set: { retentionState: "uninstall_grace", gracePurgeAt } })
  ]);
}

async function revokeInstallationAccess(installationId, accessStatus, config) {
  const repositories = await SelectedRepository.find({ installationId: String(installationId) }).select("githubRepositoryId").lean();
  const repositoryIds = repositories.map((repository) => repository.githubRepositoryId);
  const credential = await GitHubCredential.findOne({ singletonKey: "primary" }).select("+encryptedAccessToken +encryptedRefreshToken");
  if (credential) await invalidateCredential(credential);
  const gracePurgeAt = graceExpiry(config);
  await SelectedRepository.updateMany({ installationId: String(installationId) }, {
    $set: { accessStatus, revokedAt: new Date() }
  });
  await sanitizeRepositoryData(repositoryIds, gracePurgeAt);
  return repositoryIds.length;
}

async function retainSanitizedHistory(repositoryId) {
  await ReviewExecution.updateMany({ repositoryId, retentionState: "uninstall_grace" }, {
    $set: { retentionState: "connected" }, $unset: { gracePurgeAt: "" }
  });
  await Finding.updateMany({ repositoryId, retentionState: "uninstall_grace" }, {
    $set: { retentionState: "connected" }, $unset: { gracePurgeAt: "" }
  });
  await PatchProposal.updateMany({ repositoryId, retentionState: "uninstall_grace" }, {
    $set: { retentionState: "connected" }, $unset: { gracePurgeAt: "" }
  });
  await HistoricalOccurrence.updateMany({ repositoryId, retentionState: "uninstall_grace" }, {
    $set: { retentionState: "connected" }, $unset: { gracePurgeAt: "" }
  });
}

async function purgeExpiredData(config, now = new Date()) {
  const purgeAt = new Date(now.getTime() - config.CONNECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const oldFindings = await Finding.deleteMany({ retentionState: "connected", createdAt: { $lt: purgeAt } });
  const oldPatches = await PatchProposal.deleteMany({ retentionState: "connected", createdAt: { $lt: purgeAt } });
  await AnalysisArtifact.deleteMany({ retentionState: "connected", createdAt: { $lt: purgeAt } });
  const expiredRuns = await ReviewExecution.find({ retentionState: "uninstall_grace", gracePurgeAt: { $lte: now } }).select("_id repositoryId").lean();
  const expiredRepositoryIds = [...new Set(expiredRuns.map((item) => item.repositoryId))];
  if (expiredRepositoryIds.length) {
    await Promise.all([
      Finding.deleteMany({ repositoryId: { $in: expiredRepositoryIds }, retentionState: "uninstall_grace" }),
      PatchProposal.deleteMany({ repositoryId: { $in: expiredRepositoryIds }, retentionState: "uninstall_grace" }),
      AnalysisArtifact.deleteMany({ repositoryId: { $in: expiredRepositoryIds } }),
      HistoricalOccurrence.deleteMany({ repositoryId: { $in: expiredRepositoryIds }, retentionState: "uninstall_grace" }),
      ReviewExecution.deleteMany({ repositoryId: { $in: expiredRepositoryIds }, retentionState: "uninstall_grace" }),
      SelectedRepository.deleteMany({ githubRepositoryId: { $in: expiredRepositoryIds }, accessStatus: { $in: ["uninstalled", "suspended"] } })
    ]);
  }
  await Finding.deleteMany({ retentionState: "uninstall_grace", gracePurgeAt: { $lte: now } });
  await PatchProposal.deleteMany({ retentionState: "uninstall_grace", gracePurgeAt: { $lte: now } });
  await HistoricalOccurrence.deleteMany({ retentionState: "uninstall_grace", gracePurgeAt: { $lte: now } });
  const oldRevocationDate = new Date(now.getTime() - config.UNINSTALL_GRACE_DAYS * 24 * 60 * 60 * 1000);
  await SelectedRepository.deleteMany({ accessStatus: { $in: ["uninstalled", "suspended"] }, revokedAt: { $lte: oldRevocationDate } });
  return { oldFindings: oldFindings.deletedCount, oldPatches: oldPatches.deletedCount, expiredRepositories: expiredRepositoryIds.length };
}

module.exports = { graceExpiry, purgeExpiredData, retainSanitizedHistory, revokeInstallationAccess, sanitizeRepositoryData };
