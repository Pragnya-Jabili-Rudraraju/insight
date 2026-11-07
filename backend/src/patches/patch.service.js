const { createHash } = require("node:crypto");
const { z } = require("zod");
const PatchProposal = require("../models/patch-proposal.model");
const { parseSource } = require("../analysis/babel-parser");
const { redactSource } = require("../ai/secret-redaction");
const { assertSnapshotCurrent, fetchSourceAtRevision } = require("../reviews/github-snapshot.service");
const { applyReplacement, createUnifiedDiff } = require("./unified-diff");

function fileHash(content) { return createHash("sha256").update(content).digest("hex"); }

function sourceRange(content, startLine, endLine) {
  const lines = content.split(/\r?\n/);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length || endLine - startLine > 40) return null;
  return lines.slice(startLine - 1, endLine).join("\n");
}

function isSensitive(code) {
  return redactSource(code) !== code;
}

function createPatchService(dependencies = {}) {
  const PatchProposalModel = dependencies.PatchProposal || PatchProposal;
  const fetchFile = dependencies.fetchSourceAtRevision || fetchSourceAtRevision;
  const checkSnapshot = dependencies.assertSnapshotCurrent || assertSnapshotCurrent;

  return async function createProposal({ repository, execution, finding, accessToken, config, expectedHeadSha, expectedFileHash, proposePatch, api = dependencies.api }) {
    if (execution.status !== "completed" && execution.status !== "partial") {
      throw Object.assign(new Error("Patch proposals require a completed review."), { status: 409, code: "REVIEW_NOT_COMPLETE" });
    }
    if (expectedHeadSha !== execution.headSha) throw Object.assign(new Error("The review revision does not match the requested patch revision."), { status: 409, code: "STALE_PATCH_REVISION" });
    if (finding.executionId.toString() !== execution._id.toString() || finding.disposition !== "accepted" || finding.side !== "head") {
      throw Object.assign(new Error("This finding is not eligible for a patch proposal."), { status: 422, code: "PATCH_FINDING_INVALID" });
    }
    if (!proposePatch) throw Object.assign(new Error("Patch proposals require a configured LLM provider."), { status: 503, code: "AI_NOT_CONFIGURED" });
    const fileMeta = execution.changedFiles.find((file) => file.path === finding.path);
    if (!fileMeta?.headContentHash || fileMeta.headContentHash !== expectedFileHash) {
      throw Object.assign(new Error("The file hash has changed since this review."), { status: 409, code: "STALE_PATCH_FILE" });
    }
    const signal = AbortSignal.timeout(config.OPERATION_TIMEOUT_MS);
    const snapshot = { repositoryId: execution.repositoryId, pullRequestNumber: execution.pullRequestNumber, baseSha: execution.baseSha, headSha: execution.headSha };
    await checkSnapshot({ repository, pullRequestNumber: execution.pullRequestNumber, accessToken, snapshot, config, signal, api });
    const source = await fetchFile({ repository, filePath: finding.path, revision: execution.headSha, accessToken, config, signal, api });
    const currentHash = fileHash(source.content);
    if (currentHash !== fileMeta.headContentHash || currentHash !== expectedFileHash) {
      throw Object.assign(new Error("The file content no longer matches the reviewed version."), { status: 409, code: "STALE_PATCH_FILE" });
    }
    const originalCode = sourceRange(source.content, finding.startLine, finding.endLine);
    if (originalCode == null) throw Object.assign(new Error("The finding lines are outside the current file."), { status: 409, code: "STALE_PATCH_LINES" });
    if (finding.ruleId === "SEC002" || isSensitive(originalCode)) {
      throw Object.assign(new Error("Insight will not include possible credentials in a patch proposal."), { status: 422, code: "PATCH_CONTAINS_SECRET" });
    }
    const sourceLines = source.content.split(/\r?\n/);
    const contextStart = Math.max(1, finding.startLine - 3);
    const contextEnd = Math.min(sourceLines.length, finding.endLine + 3);
    const sourceContext = sourceLines.slice(contextStart - 1, contextEnd).map((line, index) => `${contextStart + index}: ${line}`).join("\n");
    const proposed = await proposePatch({ path: finding.path, finding, sourceContext }, signal);
    const proposedCode = z.string().min(1).max(100_000).parse(proposed.proposedCode);
    if (isSensitive(proposedCode)) throw Object.assign(new Error("The proposed code contains content that must be redacted."), { status: 422, code: "PATCH_CONTAINS_SECRET" });
    if (proposedCode === originalCode) throw Object.assign(new Error("The proposed code does not change the finding."), { status: 422, code: "PATCH_NO_CHANGE" });

    const candidateFile = applyReplacement(source.content, finding.startLine, finding.endLine, proposedCode);
    if (!candidateFile || Buffer.byteLength(candidateFile, "utf8") > config.MAX_PARSED_FILE_BYTES) {
      throw Object.assign(new Error("The proposal exceeds the file analysis limit."), { status: 413, code: "PATCH_FILE_LIMIT" });
    }
    const parsed = parseSource(finding.path, candidateFile, config.MAX_PARSED_FILE_BYTES);
    if (parsed.error) throw Object.assign(new Error("The proposed code does not parse with the configured Babel parser."), { status: 422, code: "PATCH_PARSE_FAILED" });
    if (isSensitive(candidateFile)) throw Object.assign(new Error("The proposal would expose credential-like source content."), { status: 422, code: "PATCH_CONTAINS_SECRET" });

    await checkSnapshot({ repository, pullRequestNumber: execution.pullRequestNumber, accessToken, snapshot, config, signal, api });
    const latestSource = await fetchFile({ repository, filePath: finding.path, revision: execution.headSha, accessToken, config, signal, api });
    if (fileHash(latestSource.content) !== expectedFileHash) throw Object.assign(new Error("The file changed while the proposal was generated."), { status: 409, code: "STALE_PATCH_FILE" });
    await checkSnapshot({ repository, pullRequestNumber: execution.pullRequestNumber, accessToken, snapshot, config, signal, api });

    const unifiedDiff = createUnifiedDiff(finding.path, finding.startLine, originalCode, proposedCode);
    const proposal = await PatchProposalModel.create({
      executionId: execution._id,
      findingId: finding._id,
      repositoryId: execution.repositoryId,
      pullRequestNumber: execution.pullRequestNumber,
      expectedHeadSha: execution.headSha,
      path: finding.path,
      expectedFileHash,
      originalCode,
      proposedCode,
      unifiedDiff,
      validationStatus: "valid",
      validationMessage: "The revision and file hash match, and the proposed file parses. Behavior is not verified.",
      providerName: proposed.providerName,
      providerModel: proposed.model
    });
    return proposal;
  };
}

module.exports = { createPatchService, fileHash, sourceRange };
