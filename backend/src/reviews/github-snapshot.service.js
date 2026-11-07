const { createHash } = require("node:crypto");
const { z } = require("zod");
const { githubApiRequest } = require("../auth/github-client");

const pullSchema = z.object({
  number: z.number().int().positive(),
  base: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i) }).passthrough(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i) }).passthrough()
}).passthrough();
const changedFilesSchema = z.array(z.object({
  filename: z.string().min(1),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changes: z.number().int().nonnegative().optional(),
  patch: z.string().optional()
}).passthrough());
const contentSchema = z.object({
  type: z.string(),
  encoding: z.string(),
  size: z.number().int().nonnegative(),
  sha: z.string().regex(/^[a-f0-9]{40}$/i),
  content: z.string()
}).passthrough();
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

class SnapshotError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    this.status = status;
  }
}

function repositoryParts(fullName) {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new SnapshotError("INVALID_REPOSITORY_REFERENCE", "Repository reference is invalid.", 400);
  }
  return parts.map(encodeURIComponent).join("/");
}

function safePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized && !normalized.startsWith("/") && !normalized.split("/").some((part) => part === ".." || part === ".") &&
    !normalized.includes("\u0000");
}

function getExtension(filePath) {
  const lastDot = filePath.lastIndexOf(".");
  return lastDot === -1 ? "" : filePath.slice(lastDot).toLowerCase();
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function verifyGitBlob(bytes, expectedSha) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  const actual = createHash("sha1").update(header).update(bytes).digest("hex");
  return actual === expectedSha;
}

function parseDiffRanges(patch) {
  const headLines = [];
  const baseLines = [];
  let headLine = null;
  let baseLine = null;
  for (const line of String(patch || "").split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      baseLine = Number(hunk[1]);
      headLine = Number(hunk[2]);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      headLines.push(headLine++);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      baseLines.push(baseLine++);
    } else if (line.startsWith(" ")) {
      baseLine += 1;
      headLine += 1;
    }
  }
  const ranges = (lines) => {
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    const result = [];
    for (const line of sorted) {
      const last = result[result.length - 1];
      if (last && line === last.endLine + 1) last.endLine = line;
      else result.push({ startLine: line, endLine: line });
    }
    return result;
  };
  return { head: ranges(headLines), base: ranges(baseLines) };
}

function apiPath(repo, tail) { return `/repos/${repo}/${tail}`; }

async function fetchSourceAtRevision({ repository, filePath, revision, accessToken, config, api = githubApiRequest, signal: suppliedSignal }) {
  if (!safePath(filePath) || !SOURCE_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf(".")).toLowerCase())) {
    throw new SnapshotError("UNSUPPORTED_PATCH_FILE", "This file type is not supported for a patch proposal.", 422);
  }
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new SnapshotError("INVALID_REVISION", "Expected revision is invalid.", 400);
  const signal = suppliedSignal || AbortSignal.timeout(config.OPERATION_TIMEOUT_MS);
  const repo = repositoryParts(repository.fullName);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const response = contentSchema.parse(await api(apiPath(repo, `contents/${encodedPath}?ref=${revision}`), accessToken, { signal, maxResponseBytes: 1024 * 1024 }));
  if (response.type !== "file" || response.encoding !== "base64") throw new SnapshotError("SOURCE_UNAVAILABLE", "The file could not be read at the expected revision.", 404);
  if (response.size > config.MAX_PARSED_FILE_BYTES) throw new SnapshotError("FILE_LIMIT_EXCEEDED", "The file is too large for a patch proposal.", 413);
  const bytes = Buffer.from(response.content.replace(/\s/g, ""), "base64");
  if (bytes.length !== response.size || !verifyGitBlob(bytes, response.sha)) throw new SnapshotError("SOURCE_HASH_MISMATCH", "Fetched source did not match its GitHub blob hash.");
  return { content: bytes.toString("utf8"), blobSha: response.sha, contentHash: sha256(bytes), size: bytes.length };
}

async function fetchPullSnapshot({ repository, pullRequestNumber, accessToken, config, api = githubApiRequest, onSnapshotPinned, signal: suppliedSignal }) {
  const repo = repositoryParts(repository.fullName);
  const signal = suppliedSignal || AbortSignal.timeout(config.OPERATION_TIMEOUT_MS);
  const readPull = async () => pullSchema.parse(await api(apiPath(repo, `pulls/${pullRequestNumber}`), accessToken, { signal }));
  const initialPull = await readPull();
  if (initialPull.number !== Number(pullRequestNumber)) throw new SnapshotError("PULL_REQUEST_MISMATCH", "GitHub returned a different pull request.");

  const baseSha = initialPull.base.sha;
  const headSha = initialPull.head.sha;
  const pinnedSnapshot = { repositoryId: String(repository.githubRepositoryId), pullRequestNumber: Number(pullRequestNumber), baseSha, headSha };
  if (onSnapshotPinned) await onSnapshotPinned(pinnedSnapshot);
  const rawFiles = await api(apiPath(repo, `pulls/${pullRequestNumber}/files?per_page=${Math.min(config.MAX_PR_CHANGED_FILES + 1, 100)}&page=1`), accessToken, { signal, maxResponseBytes: 1024 * 1024 });
  const parsedFiles = changedFilesSchema.safeParse(rawFiles);
  if (!parsedFiles.success) throw new SnapshotError("INVALID_GITHUB_RESPONSE", "GitHub returned changed-file data in an unexpected format.", 502);

  const warnings = [];
  const candidateFiles = parsedFiles.data;
  const truncatedByCount = candidateFiles.length > config.MAX_PR_CHANGED_FILES;
  const limitedFiles = candidateFiles.slice(0, config.MAX_PR_CHANGED_FILES);
  if (truncatedByCount) warnings.push({ code: "CHANGED_FILE_LIMIT", message: "Some changed files were skipped because the review file limit was reached." });

  let remainingDiffBytes = config.MAX_PR_DIFF_BYTES;
  const files = limitedFiles.map((file) => {
    if (!safePath(file.filename)) throw new SnapshotError("UNSAFE_REPOSITORY_PATH", "GitHub returned an unsafe file path.", 502);
    const patch = file.patch || "";
    const patchBytes = Buffer.byteLength(patch, "utf8");
    if (!patch || patchBytes > remainingDiffBytes) {
      if (patchBytes > remainingDiffBytes) warnings.push({ code: "DIFF_LIMIT", message: "Some diff content was omitted because the review diff limit was reached." });
      else if (!patch && !["added", "removed"].includes(file.status)) warnings.push({ code: "DIFF_UNAVAILABLE", message: `Diff details were unavailable for ${file.filename}; structural analysis may be incomplete.` });
      return { path: file.filename, status: file.status, patch: null, patchBytes: 0, diffIncluded: false };
    }
    remainingDiffBytes -= patchBytes;
    const changedLines = parseDiffRanges(patch);
    return { path: file.filename, status: file.status, patch, patchBytes, diffIncluded: true, changedHeadLineRanges: changedLines.head, changedBaseLineRanges: changedLines.base };
  });

  let sourceBytes = 0;
  const readContent = async (filePath, revision) => {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    let raw;
    try {
      raw = await api(apiPath(repo, `contents/${encodedPath}?ref=${revision}`), accessToken, { signal, maxResponseBytes: 1024 * 1024 });
    } catch (error) {
      if (error.status === 404) return { skippedReason: "source_unavailable" };
      throw error;
    }
    const result = contentSchema.safeParse(raw);
    if (!result.success || result.data.type !== "file" || result.data.encoding !== "base64") {
      return { skippedReason: "source_unavailable" };
    }
    if (result.data.size > config.MAX_PARSED_FILE_BYTES) return { skippedReason: "parsed_file_limit", size: result.data.size };
    const bytes = Buffer.from(result.data.content.replace(/\s/g, ""), "base64");
    if (bytes.length !== result.data.size || !verifyGitBlob(bytes, result.data.sha)) {
      throw new SnapshotError("SOURCE_HASH_MISMATCH", "Fetched source did not match its GitHub blob hash.");
    }
    if (sourceBytes + bytes.length > config.MAX_REPOSITORY_SOURCE_BYTES) return { skippedReason: "source_total_limit", size: result.data.size };
    sourceBytes += bytes.length;
    return { content: bytes.toString("utf8"), blobSha: result.data.sha, contentHash: sha256(bytes), size: bytes.length };
  };

  const sourceCandidates = files.filter((file) => SOURCE_EXTENSIONS.has(getExtension(file.path)));
  let index = 0;
  const workers = Array.from({ length: Math.min(4, sourceCandidates.length) }, async () => {
    while (index < sourceCandidates.length) {
      const file = sourceCandidates[index++];
      if (file.status !== "added") file.base = await readContent(file.path, baseSha);
      if (file.status !== "removed") file.head = await readContent(file.path, headSha);
    }
  });
  await Promise.all(workers);

  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(getExtension(file.path))) continue;
    for (const [side, revisionContent] of [["base", file.base], ["head", file.head]]) {
      if (!revisionContent?.skippedReason) continue;
      if (revisionContent.skippedReason === "source_unavailable") {
        warnings.push({
          code: `${side.toUpperCase()}_SOURCE_UNAVAILABLE`,
          message: `GitHub did not return ${side} source for ${file.path} at the pinned revision. Check the GitHub App Contents read permission and repository access.`
        });
      } else {
        warnings.push({ code: revisionContent.skippedReason.toUpperCase(), message: `Source was skipped for ${file.path} because an analysis limit was reached.` });
      }
    }
  }

  const afterRetrieval = await readPull();
  if (afterRetrieval.base.sha !== baseSha || afterRetrieval.head.sha !== headSha) {
    const error = new SnapshotError("STALE_REVISION", "The pull request changed while Insight was retrieving its source.");
    error.snapshot = pinnedSnapshot;
    throw error;
  }

  return {
    snapshot: {
      repositoryId: String(repository.githubRepositoryId),
      pullRequestNumber: Number(pullRequestNumber),
      baseSha,
      headSha
    },
    files,
    sourceBytes,
    warnings,
    partial: warnings.length > 0,
    analyzerCandidates: files.filter((file) => {
      if (!SOURCE_EXTENSIONS.has(getExtension(file.path))) return false;
      const wholeFileIsChanged = file.status === "added" || file.status === "removed";
      if (!file.diffIncluded && !wholeFileIsChanged) return false;
      return file.status === "removed"
        ? typeof file.base?.content === "string"
        : typeof file.head?.content === "string";
    })
      .map((file) => ({
        path: file.path,
        baseContent: file.base?.content ?? null,
        headContent: file.head?.content ?? "",
        changedHeadLineRanges: file.changedHeadLineRanges,
        changedBaseLineRanges: file.changedBaseLineRanges
      }))
  };
}

async function assertSnapshotCurrent({ repository, pullRequestNumber, accessToken, snapshot, config, api = githubApiRequest, signal: suppliedSignal }) {
  const repo = repositoryParts(repository.fullName);
  const signal = suppliedSignal || AbortSignal.timeout(config.OPERATION_TIMEOUT_MS);
  const current = pullSchema.parse(await api(apiPath(repo, `pulls/${pullRequestNumber}`), accessToken, { signal }));
  if (current.base.sha !== snapshot.baseSha || current.head.sha !== snapshot.headSha) {
    throw new SnapshotError("STALE_REVISION", "The pull request changed while Insight was analyzing it.");
  }
  return true;
}

module.exports = { SnapshotError, assertSnapshotCurrent, fetchPullSnapshot, fetchSourceAtRevision, parseDiffRanges, safePath, verifyGitBlob };
