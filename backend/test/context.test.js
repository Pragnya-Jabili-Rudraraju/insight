const { selectContext } = require("../src/reviews/context-selector.service");
const { createHash } = require("node:crypto");

const snapshot = { headSha: "a".repeat(40) };
const repository = { githubRepositoryId: "9", fullName: "owner/repo" };

function gitBlobSha(source) {
  const bytes = Buffer.from(source);
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
}

function makeBlob(source, sha = gitBlobSha(source)) {
  const bytes = Buffer.from(source);
  return { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
}

function createContextApi(files, { corruptBlobSha = false } = {}) {
  const entries = Object.entries(files).map(([filePath, source]) => ({
    path: filePath, type: "blob", sha: gitBlobSha(source), size: Buffer.byteLength(source)
  }));
  const blobs = new Map(entries.map((entry) => [entry.sha, makeBlob(files[entry.path], corruptBlobSha ? "f".repeat(40) : entry.sha)]));
  return async (endpoint) => {
    if (endpoint.includes("git/trees/")) return { truncated: false, tree: entries };
    const sha = endpoint.split("/").pop();
    if (blobs.has(sha)) return blobs.get(sha);
    throw Object.assign(new Error("not found"), { status: 404 });
  };
}

const makeConfig = (overrides = {}) => ({
  OPERATION_TIMEOUT_MS: 60_000,
  MAX_REPOSITORY_FILES: 1000,
  MAX_REPOSITORY_SOURCE_BYTES: 20 * 1024 * 1024,
  MAX_PARSED_FILE_BYTES: 500 * 1024,
  MAX_CONTEXT_BYTES: 100 * 1024,
  ...overrides
});

describe("deterministic context selection", () => {
  const files = {
    "src/payment.js": "import { getAccount } from './models/account';\nexport function charge(id) { return getAccount(id); }",
    "src/models/account.js": "export function getAccount(id) { return { id }; }",
    "src/caller.js": "import { charge } from './payment';\nexport const run = () => charge('1');",
    "tests/payment.test.js": "import { charge } from '../src/payment';\ntest('charge', () => charge('1'));",
    "src/unrelated.js": "export const unused = true;"
  };

  test("selects direct dependencies, callers, and tests with reasons", async () => {
    const result = await selectContext({
      repository, snapshot,
      changedFiles: [{ path: "src/payment.js", headContent: files["src/payment.js"] }],
      changedArtifacts: [{
        path: "src/payment.js",
        imports: [{ source: "./models/account", names: ["getAccount"] }],
        exports: [{ name: "charge" }]
      }],
      accessToken: "token", config: makeConfig(), api: createContextApi(files)
    });
    const reasonsByPath = new Map(result.selected.map((file) => [file.path, file.reasonCodes]));
    expect(reasonsByPath.get("src/models/account.js")).toContain("model_used_by_changed_code");
    expect(reasonsByPath.get("src/caller.js")).toContain("calls_changed_export");
    expect(reasonsByPath.get("tests/payment.test.js")).toContain("test_for_changed_module");
    expect(reasonsByPath.has("src/unrelated.js")).toBe(false);
    expect(result.manifest.files.find((file) => file.path === "src/unrelated.js").reasonCodes).toContain("no_structural_relationship_found");
  });

  test("records budget skips and never exceeds the selected-context limit", async () => {
    const result = await selectContext({
      repository, snapshot,
      changedFiles: [{ path: "src/payment.js", headContent: files["src/payment.js"] }],
      changedArtifacts: [{ path: "src/payment.js", imports: [{ source: "./models/account", names: ["getAccount"] }], exports: [{ name: "charge" }] }],
      accessToken: "token", config: makeConfig({ MAX_CONTEXT_BYTES: 1 }), api: createContextApi(files)
    });
    expect(result.selectedBytes).toBeUndefined();
    expect(result.manifest.selectedBytes).toBe(0);
    expect(result.manifest.files.some((file) => file.reasonCodes.includes("context_budget"))).toBe(true);
  });

  test("rejects context bytes that do not match the immutable tree blob SHA", async () => {
    await expect(selectContext({
      repository, snapshot,
      changedFiles: [{ path: "src/payment.js", headContent: files["src/payment.js"] }],
      changedArtifacts: [{ path: "src/payment.js", imports: [{ source: "./models/account", names: ["getAccount"] }], exports: [{ name: "charge" }] }],
      accessToken: "token", config: makeConfig(), api: createContextApi(files, { corruptBlobSha: true })
    })).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
  });
});
