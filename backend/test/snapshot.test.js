const { createHash } = require("node:crypto");
const { assertSnapshotCurrent, fetchPullSnapshot, parseDiffRanges } = require("../src/reviews/github-snapshot.service");
const { analyzeFiles } = require("../src/analysis/structural-analyzer");

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const repository = { githubRepositoryId: "42", fullName: "owner/project" };
const config = {
  OPERATION_TIMEOUT_MS: 60_000,
  MAX_PR_CHANGED_FILES: 50,
  MAX_PR_DIFF_BYTES: 500 * 1024,
  MAX_PARSED_FILE_BYTES: 500 * 1024,
  MAX_REPOSITORY_SOURCE_BYTES: 20 * 1024 * 1024
};

function githubContent(source) {
  const bytes = Buffer.from(source);
  const sha = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
  return { type: "file", encoding: "base64", size: bytes.length, sha, content: bytes.toString("base64") };
}

function snapshotApi({ changeAfterRetrieval = false, corruptHash = false } = {}) {
  let pullCalls = 0;
  return async (endpoint) => {
    if (endpoint.endsWith("pulls/7")) {
      pullCalls += 1;
      return { number: 7, base: { sha: baseSha }, head: { sha: changeAfterRetrieval && pullCalls > 1 ? "c".repeat(40) : headSha } };
    }
    if (endpoint.includes("pulls/7/files")) {
      return [{ filename: "src/value.js", status: "modified", patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;" }];
    }
    if (endpoint.includes("contents/src/value.js")) {
      const isBase = endpoint.includes(`ref=${baseSha}`);
      const content = githubContent(isBase ? "export const value = 1;\n" : "export const value = 2;\n");
      if (corruptHash) content.sha = "d".repeat(40);
      return content;
    }
    throw new Error(`Unexpected API path: ${endpoint}`);
  };
}

describe("revision-pinned PR source retrieval", () => {
  test("fetches files by immutable SHAs and maps changed lines", async () => {
    const result = await fetchPullSnapshot({ repository, pullRequestNumber: 7, accessToken: "token", config, api: snapshotApi() });
    expect(result.snapshot).toEqual({ repositoryId: "42", pullRequestNumber: 7, baseSha, headSha });
    expect(result.files[0].base.content).toContain("value = 1");
    expect(result.files[0].head.content).toContain("value = 2");
    expect(result.analyzerCandidates[0].changedHeadLineRanges).toEqual([{ startLine: 1, endLine: 1 }]);
    expect(result.warnings).toEqual([]);
  });


  test("analyzes a newly added source file even if GitHub omits its patch", async () => {
    const api = async (endpoint) => {
      if (endpoint.endsWith("pulls/7")) {
        return { number: 7, base: { sha: baseSha }, head: { sha: headSha } };
      }
      if (endpoint.includes("pulls/7/files")) {
        return [{ filename: "src/runner.js", status: "added", additions: 2, changes: 2 }];
      }
      if (endpoint.includes("contents/src/runner.js")) return githubContent("export function run(input) {\n  return eval(input);\n}\n");
      throw new Error(`Unexpected API path: ${endpoint}`);
    };

    const result = await fetchPullSnapshot({ repository, pullRequestNumber: 7, accessToken: "token", config, api });
    const analysis = analyzeFiles(result.analyzerCandidates);

    expect(result.files[0].diffIncluded).toBe(false);
    expect(result.analyzerCandidates).toHaveLength(1);
    expect(analysis.findings.some((finding) => finding.title.toLowerCase().includes("dynamic code"))).toBe(true);
    expect(result.warnings).toEqual([]);
  });


  test("reports missing GitHub source instead of silently returning zero candidates", async () => {
    const api = async (endpoint) => {
      if (endpoint.endsWith("pulls/7")) return { number: 7, base: { sha: baseSha }, head: { sha: headSha } };
      if (endpoint.includes("pulls/7/files")) return [{ filename: "src/value.js", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }];
      if (endpoint.includes("contents/src/value.js")) {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      throw new Error(`Unexpected API path: ${endpoint}`);
    };
    const result = await fetchPullSnapshot({ repository, pullRequestNumber: 7, accessToken: "token", config, api });
    expect(result.analyzerCandidates).toHaveLength(0);
    expect(result.warnings.map((item) => item.code)).toEqual(["BASE_SOURCE_UNAVAILABLE", "HEAD_SOURCE_UNAVAILABLE"]);
    expect(result.warnings[0].message).toContain("Contents read permission");
  });

  test("marks the snapshot stale if the PR moves during retrieval", async () => {
    await expect(fetchPullSnapshot({
      repository, pullRequestNumber: 7, accessToken: "token", config,
      api: snapshotApi({ changeAfterRetrieval: true })
    })).rejects.toMatchObject({ code: "STALE_REVISION", status: 409 });
  });

  test("rejects content whose Git blob hash does not match", async () => {
    await expect(fetchPullSnapshot({
      repository, pullRequestNumber: 7, accessToken: "token", config,
      api: snapshotApi({ corruptHash: true })
    })).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
  });

  test("checks SHAs again before finalizing a review", async () => {
    await expect(assertSnapshotCurrent({
      repository, pullRequestNumber: 7, accessToken: "token", snapshot: { baseSha, headSha }, config,
      api: async () => ({ number: 7, base: { sha: baseSha }, head: { sha: "c".repeat(40) } })
    })).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  test("maps only added and deleted lines from unified hunks", () => {
    expect(parseDiffRanges("@@ -2,2 +2,2 @@\n same\n-old\n+new\n+extra")).toEqual({
      head: [{ startLine: 3, endLine: 4 }],
      base: [{ startLine: 3, endLine: 3 }]
    });
  });
});
