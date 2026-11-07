const path = require("node:path");
const { createHash } = require("node:crypto");
const { z } = require("zod");
const { githubApiRequest } = require("../auth/github-client");
const { parseSource, SUPPORTED_EXTENSIONS } = require("../analysis/babel-parser");
const { exportedApi } = require("../analysis/structural-analyzer");
const { SnapshotError, verifyGitBlob } = require("./github-snapshot.service");

const treeSchema = z.object({ truncated: z.boolean(), tree: z.array(z.object({
  path: z.string(), type: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/i).optional(), size: z.number().int().nonnegative().optional()
}).passthrough()) });
const blobSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i), encoding: z.literal("base64"), size: z.number().int().nonnegative(), content: z.string() }).passthrough();

function toBlobText(blob, expectedSha) {
  const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
  if (bytes.length !== blob.size) return null;
  if (blob.sha !== expectedSha || !verifyGitBlob(bytes, expectedSha)) {
    throw new SnapshotError("SOURCE_HASH_MISMATCH", "Fetched context did not match its immutable Git tree object.");
  }
  return bytes.toString("utf8");
}

function repositoryUrlPart(fullName) {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("Invalid repository name.");
  return parts.map(encodeURIComponent).join("/");
}

function possibleModulePaths(importPath, importerPath) {
  if (!importPath.startsWith(".")) return [];
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), importPath));
  const candidates = [resolved];
  const extension = path.posix.extname(resolved);
  if (!extension) {
    for (const ext of SUPPORTED_EXTENSIONS) candidates.push(`${resolved}${ext}`);
    for (const ext of SUPPORTED_EXTENSIONS) candidates.push(`${resolved}/index${ext}`);
  }
  return candidates.filter((item) => !item.startsWith("../") && item !== ".." && !item.startsWith("/"));
}

function pathKind(filePath) {
  const lower = filePath.toLowerCase();
  if (/(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(lower)) return "test";
  if (/(^|\/)(models?|schemas?|entities|repositories)(\/|$)/.test(lower)) return "model";
  if (/(^|\/)(middleware|middlewares)(\/|$)/.test(lower)) return "middleware";
  if (/(^|\/)(routes?|controllers?)(\/|$)/.test(lower)) return "route";
  return "source";
}

function uniqueReasons(reasons) { return [...new Set(reasons)]; }

async function selectContext({ repository, snapshot, changedFiles, changedArtifacts = [], accessToken, config, api = githubApiRequest, signal: suppliedSignal }) {
  const repo = repositoryUrlPart(repository.fullName);
  const signal = suppliedSignal || AbortSignal.timeout(config.OPERATION_TIMEOUT_MS);
  const rawTree = await api(`/repos/${repo}/git/trees/${snapshot.headSha}?recursive=1`, accessToken, { signal, maxResponseBytes: 4 * 1024 * 1024 });
  const parsedTree = treeSchema.safeParse(rawTree);
  if (!parsedTree.success) throw new Error("GitHub returned an invalid repository tree.");

  const changedPaths = new Set(changedFiles.map((file) => file.path));
  const changedModules = new Set();
  const changedExports = new Set();
  const changedImports = new Map();
  for (const artifact of changedArtifacts) {
    changedPaths.add(artifact.path);
    for (const item of artifact.exports || []) changedExports.add(item.name);
    changedImports.set(artifact.path, artifact.imports || []);
  }

  const treeFiles = parsedTree.data.tree.filter((entry) => entry.type === "blob" && entry.sha && SUPPORTED_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase()));
  const candidateLimit = config.MAX_REPOSITORY_FILES;
  const candidates = treeFiles.slice(0, candidateLimit);
  const candidateLimitReached = treeFiles.length > candidateLimit;
  const treeTruncated = parsedTree.data.truncated;
  const treeByPath = new Map(candidates.map((entry) => [entry.path, entry]));
  const candidateSources = new Map();
  const analysisManifest = [];
  const warnings = [];
  if (candidateLimitReached || treeTruncated) warnings.push({ code: "CONTEXT_CANDIDATE_LIMIT", message: "Context discovery could not inspect the full repository tree." });

  for (const changedPath of changedPaths) {
    const imports = changedImports.get(changedPath) || [];
    for (const imported of imports) {
      for (const resolvedPath of possibleModulePaths(imported.source, changedPath)) {
        if (treeByPath.has(resolvedPath) && !changedPaths.has(resolvedPath)) changedModules.add(resolvedPath);
      }
    }
  }

  const selectedChangedSources = changedFiles.map((file) => ({
    path: file.path,
    headContent: file.headContent || file.baseContent || ""
  })).filter((file) => file.headContent);
  for (const file of selectedChangedSources) {
    const parsed = parseSource(file.path, file.headContent, config.MAX_PARSED_FILE_BYTES);
    if (!parsed.ast) continue;
    const apiInfo = exportedApi(parsed.ast);
    changedImports.set(file.path, apiInfo.imports);
    for (const symbol of apiInfo.symbols.keys()) changedExports.add(symbol);
    for (const item of apiInfo.imports) {
      for (const resolvedPath of possibleModulePaths(item.source, file.path)) {
        if (treeByPath.has(resolvedPath) && !changedPaths.has(resolvedPath)) changedModules.add(resolvedPath);
      }
    }
  }

  const prioritized = [...candidates].sort((a, b) => {
    const aDirect = changedModules.has(a.path) ? 0 : 1;
    const bDirect = changedModules.has(b.path) ? 0 : 1;
    return aDirect - bDirect || a.path.localeCompare(b.path);
  });
  let fetchedBytes = 0;
  let selectedBytes = 0;
  let contextStopped = false;
  let cursor = 0;
  const worker = async () => {
    while (cursor < prioritized.length && !contextStopped) {
      const entry = prioritized[cursor++];
      if (changedPaths.has(entry.path)) {
        analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["changed_file_already_in_snapshot"], bytes: 0 });
        continue;
      }
      if (entry.size != null && entry.size > config.MAX_PARSED_FILE_BYTES) {
        analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["parsed_file_limit"], bytes: entry.size });
        continue;
      }
      if (entry.size == null) {
        analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["missing_blob_size"], bytes: 0 });
        continue;
      }
      if (fetchedBytes + entry.size > config.MAX_REPOSITORY_SOURCE_BYTES) {
        analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["repository_source_limit"], bytes: entry.size });
        contextStopped = true;
        continue;
      }
      fetchedBytes += entry.size;
      try {
        const rawBlob = await api(`/repos/${repo}/git/blobs/${entry.sha}`, accessToken, { signal, maxResponseBytes: 1024 * 1024 });
        const blob = blobSchema.parse(rawBlob);
        if (blob.size !== entry.size) {
          fetchedBytes -= entry.size;
          analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["tree_blob_size_mismatch"], bytes: blob.size });
          continue;
        }
        const source = toBlobText(blob, entry.sha);
        if (source == null) {
          fetchedBytes -= entry.size;
          analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["invalid_blob_encoding"], bytes: blob.size });
          continue;
        }
        const parsed = parseSource(entry.path, source, config.MAX_PARSED_FILE_BYTES);
        const moduleInfo = parsed.ast ? exportedApi(parsed.ast) : { imports: [], symbols: new Map() };
        candidateSources.set(entry.path, { source, imports: moduleInfo.imports, exports: [...moduleInfo.symbols.keys()] });
      } catch (error) {
        fetchedBytes -= entry.size;
        if (error.status === 404) {
          analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["blob_unavailable"], bytes: 0 });
          continue;
        }
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, prioritized.length) }, worker));

  const selected = [];
  for (const entry of prioritized) {
    if (changedPaths.has(entry.path)) continue;
    const sourceInfo = candidateSources.get(entry.path);
    if (!sourceInfo) continue;
    const reasons = [];
    for (const imported of sourceInfo.imports) {
      const targetsChanged = possibleModulePaths(imported.source, entry.path).some((target) => changedPaths.has(target));
      if (!targetsChanged) continue;
      if (pathKind(entry.path) === "test") reasons.push("test_for_changed_module");
      else if (imported.names.some((name) => changedExports.has(name))) reasons.push("calls_changed_export");
      else reasons.push("imports_changed_module");
    }
    if (changedModules.has(entry.path)) {
      if (pathKind(entry.path) === "model") reasons.push("model_used_by_changed_code");
      else if (pathKind(entry.path) === "middleware") reasons.push("middleware_for_changed_route");
      else reasons.push("imported_by_changed_file");
    }
    const reasonCodes = uniqueReasons(reasons);
    if (!reasonCodes.length) {
      analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["no_structural_relationship_found"], bytes: Buffer.byteLength(sourceInfo.source) });
      continue;
    }
    const byteLength = Buffer.byteLength(sourceInfo.source);
    if (selectedBytes + byteLength > config.MAX_CONTEXT_BYTES) {
      analysisManifest.push({ path: entry.path, selected: false, reasonCodes: ["context_budget"], candidateReasonCodes: reasonCodes, bytes: byteLength });
      continue;
    }
    selectedBytes += byteLength;
    selected.push({ path: entry.path, content: sourceInfo.source, contentHash: createHash("sha256").update(sourceInfo.source).digest("hex"), reasonCodes, bytes: byteLength });
    analysisManifest.push({ path: entry.path, selected: true, reasonCodes, bytes: byteLength });
  }

  if (contextStopped) warnings.push({ code: "CONTEXT_SOURCE_LIMIT", message: "Context retrieval stopped at the repository source-data limit." });
  analysisManifest.sort((a, b) => a.path.localeCompare(b.path));
  return {
    selected,
    manifest: {
      repositoryId: String(repository.githubRepositoryId),
      headSha: snapshot.headSha,
      candidateCount: treeFiles.length,
      inspectedCount: candidateSources.size,
      fetchedBytes,
      selectedBytes,
      files: analysisManifest
    },
    warnings,
    partial: warnings.length > 0
  };
}

module.exports = { pathKind, possibleModulePaths, selectContext };
