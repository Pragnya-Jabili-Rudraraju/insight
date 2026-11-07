const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");
const ReviewExecution = require("../models/review-execution.model");
const Finding = require("../models/finding.model");
const PatchProposal = require("../models/patch-proposal.model");
const SelectedRepository = require("../models/selected-repository.model");
const { createRequireGitHubAccess } = require("../auth/auth-middleware");
const { githubApiRequest } = require("../auth/github-client");
const { requireCsrf } = require("../security/csrf");
const { fetchSourceAtRevision } = require("../reviews/github-snapshot.service");
const { createPatchService } = require("./patch.service");

const currentPullSchema = z.object({ base: z.object({ sha: z.string() }).passthrough(), head: z.object({ sha: z.string() }).passthrough() }).passthrough();

function createPatchRouter(config, dependencies = {}) {
  const router = express.Router();
  const requireGitHub = createRequireGitHubAccess(config);
  const createProposal = dependencies.createProposal || createPatchService(dependencies);

  router.post("/reviews/:executionId/findings/:findingId/patch-proposals", requireGitHub, requireCsrf, async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.executionId) || !mongoose.isValidObjectId(req.params.findingId)) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Finding was not found.", retryable: false, requestId: req.requestId } });
    }
    const requestBody = z.object({
      expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
      expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/i)
    }).safeParse(req.body);
    if (!requestBody.success) return res.status(400).json({ error: { code: "INVALID_PATCH_REQUEST", message: "Expected revision details are required.", retryable: false, requestId: req.requestId } });
    try {
      const execution = await ReviewExecution.findById(req.params.executionId);
      if (!execution || !await SelectedRepository.exists({ githubRepositoryId: execution.repositoryId, accessStatus: "active" })) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Finding was not found.", retryable: false, requestId: req.requestId } });
      }
      const finding = await Finding.findOne({ _id: req.params.findingId, executionId: execution._id, disposition: "accepted" });
      if (!finding) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Finding was not found.", retryable: false, requestId: req.requestId } });
      const repository = await SelectedRepository.findOne({ githubRepositoryId: execution.repositoryId, accessStatus: "active" });
      const proposal = await createProposal({
        repository,
        execution,
        finding,
        accessToken: req.githubAccessToken,
        config,
        expectedHeadSha: requestBody.data.expectedHeadSha,
        expectedFileHash: requestBody.data.expectedFileHash,
        proposePatch: dependencies.proposePatch,
        api: dependencies.api
      });
      return res.status(201).json({ patchProposal: proposal });
    } catch (error) {
      if (error.status && error.status < 500) return res.status(error.status).json({ error: { code: error.code || "PATCH_REJECTED", message: error.message, retryable: false, requestId: req.requestId } });
      return next(error);
    }
  });

  router.get("/patch-proposals/:proposalId", requireGitHub, async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.proposalId)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Patch proposal was not found.", retryable: false, requestId: req.requestId } });
    try {
      const proposal = await PatchProposal.findById(req.params.proposalId);
      if (!proposal || !await SelectedRepository.exists({ githubRepositoryId: proposal.repositoryId, accessStatus: "active" })) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Patch proposal was not found.", retryable: false, requestId: req.requestId } });
      }
      if (proposal.contentDeleted) return res.status(410).json({ error: { code: "PATCH_CONTENT_EXPIRED", message: "Patch contents were deleted under the repository retention policy.", retryable: false, requestId: req.requestId } });
      const repository = await SelectedRepository.findOne({ githubRepositoryId: proposal.repositoryId, accessStatus: "active" });
      const encodedName = repository.fullName.split("/").map(encodeURIComponent).join("/");
      const pull = currentPullSchema.parse(await githubApiRequest(
        `/repos/${encodedName}/pulls/${proposal.pullRequestNumber}`,
        req.githubAccessToken
      ));
      if (pull.head.sha !== proposal.expectedHeadSha) {
        proposal.validationStatus = "stale";
        proposal.validationMessage = "The pull request head moved after this proposal was created.";
        await proposal.save();
        return res.status(409).json({ error: { code: "STALE_PATCH_REVISION", message: proposal.validationMessage, retryable: false, requestId: req.requestId } });
      }
      const source = await fetchSourceAtRevision({
        repository,
        filePath: proposal.path,
        revision: proposal.expectedHeadSha,
        accessToken: req.githubAccessToken,
        config
      });
      if (source.contentHash !== proposal.expectedFileHash) {
        proposal.validationStatus = "stale";
        proposal.validationMessage = "The source file changed after this proposal was created.";
        await proposal.save();
        return res.status(409).json({ error: { code: "STALE_PATCH_FILE", message: proposal.validationMessage, retryable: false, requestId: req.requestId } });
      }
      const finalPull = currentPullSchema.parse(await githubApiRequest(
        `/repos/${encodedName}/pulls/${proposal.pullRequestNumber}`,
        req.githubAccessToken
      ));
      if (finalPull.head.sha !== proposal.expectedHeadSha) {
        proposal.validationStatus = "stale";
        proposal.validationMessage = "The pull request head moved while the proposal was being checked.";
        await proposal.save();
        return res.status(409).json({ error: { code: "STALE_PATCH_REVISION", message: proposal.validationMessage, retryable: false, requestId: req.requestId } });
      }
      return res.json({ patchProposal: proposal });
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = { createPatchRouter };
