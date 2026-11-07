const mongoose = require("mongoose");
const { createHash } = require("node:crypto");
const { createReviewService } = require("../src/reviews/review.service");
const ReviewExecution = require("../src/models/review-execution.model");
const Finding = require("../src/models/finding.model");
const PatchProposal = require("../src/models/patch-proposal.model");
const HistoricalOccurrence = require("../src/models/historical-occurrence.model");
const AnalysisArtifact = require("../src/models/analysis-artifact.model");
const SelectedRepository = require("../src/models/selected-repository.model");
const GitHubCredential = require("../src/models/github-credential.model");
const WebhookDelivery = require("../src/models/webhook-delivery.model");
const { createSessionMiddleware } = require("../src/security/session");
const express = require("express");
const request = require("supertest");
const { createHmac } = require("node:crypto");
const { createRepositoryRouter } = require("../src/repositories/repository.routes");
const { createReviewRouter } = require("../src/reviews/review.routes");
const { createPatchRouter } = require("../src/patches/patch.routes");
const { createGitHubWebhookRouter } = require("../src/webhooks/github-webhook");
const { encryptToken } = require("../src/security/token-vault");
const { purgeExpiredData } = require("../src/retention/retention.service");
const { loadConfig } = require("../src/config/env");

const integrationUri = process.env.MONGODB_INTEGRATION_URI;
let safeTestDatabase = false;
try {
  const parsed = new URL(integrationUri);
  safeTestDatabase = ["127.0.0.1", "localhost"].includes(parsed.hostname)
    && parsed.pathname.startsWith("/insight_test_");
} catch { /* The optional integration URI is absent or invalid. */ }

const describeDatabase = safeTestDatabase ? describe : describe.skip;
const models = [ReviewExecution, Finding, PatchProposal, HistoricalOccurrence, AnalysisArtifact, SelectedRepository, GitHubCredential, WebhookDelivery];
const sha = "a".repeat(40);
const contentHash = "b".repeat(64);
const tokenKey = "c".repeat(64);
const webhookSecret = "integration-webhook-secret-with-more-than-32-characters";

function configForIntegration(overrides = {}) {
  return loadConfig({
    NODE_ENV: "test", MONGODB_URI: integrationUri,
    SESSION_SECRET: "integration-session-secret-with-more-than-32-characters",
    TOKEN_ENCRYPTION_KEY: tokenKey, FINGERPRINT_HMAC_KEY: "d".repeat(64),
    GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
    ...overrides
  });
}

async function seedCredential(githubUserId = "123", config = configForIntegration()) {
  return GitHubCredential.create({
    githubUserId, githubLogin: "integration-user",
    encryptedAccessToken: encryptToken("integration-access-token", config.TOKEN_ENCRYPTION_KEY),
    encryptedRefreshToken: encryptToken("integration-refresh-token", config.TOKEN_ENCRYPTION_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: "active", lastAuthenticatedAt: new Date()
  });
}

async function createAuthenticatedTestApp(config, routers) {
  const sessionMiddleware = createSessionMiddleware(config);
  const app = express();
  app.use(sessionMiddleware);
  app.use((req, res, next) => {
    req.session.user = { githubUserId: "123", login: "integration-user" };
    req.session.csrfToken = "integration-csrf-token";
    next();
  });
  app.use(express.json());
  for (const router of routers) app.use("/api/v1", router);
  return { app, close: () => sessionMiddleware.store.close() };
}

async function seedReviewData(repository, executionId = undefined) {
  const execution = await ReviewExecution.create({
    ...(executionId ? { _id: executionId } : {}),
    repositoryId: repository.githubRepositoryId, repositoryName: repository.fullName,
    pullRequestNumber: 8, baseSha: sha, headSha: "c".repeat(40),
    analyzerVersion: "test-analyzer", providerConfiguration: { provider: "none", maxAttempts: 1 },
    limitSnapshot: {
      repositoryCandidateFiles: 1000, repositorySourceBytes: 20 * 1024 * 1024,
      parsedFileBytes: 500 * 1024, pullRequestChangedFiles: 50,
      pullRequestDiffBytes: 500 * 1024, selectedContextBytes: 100 * 1024,
      operationTimeoutMs: 60_000
    }, status: "completed", startedAt: new Date(), finishedAt: new Date(),
    changedFiles: [{ path: "src/example.js", status: "modified", headContentHash: contentHash }],
    qualitySummary: { analyzedChangedFiles: 1 }
  });
  const finding = await Finding.create({
    executionId: execution._id, repositoryId: repository.githubRepositoryId, pullRequestNumber: 8,
    baseSha: execution.baseSha, headSha: execution.headSha, ruleId: "SEC001", category: "security",
    severity: "medium", title: "Example finding", explanation: "A test-only fixture.",
    path: "src/example.js", side: "head", startLine: 1, endLine: 1,
    evidence: [{ path: "src/example.js", side: "head", startLine: 1, endLine: 1, snippet: "1: eval(input);", contentHash }],
    suggestedImprovement: "Use an explicit operation.", confidence: "medium", provenance: "deterministic",
    verification: "rule_checked", disposition: "accepted", fingerprint: "e".repeat(64),
    fingerprintVersion: "insight-fingerprint-v1", testGuidance: "Test an unsafe input."
  });
  await HistoricalOccurrence.create({
    repositoryId: repository.githubRepositoryId, pullRequestNumber: 8, executionId: execution._id,
    findingId: finding._id, fingerprint: finding.fingerprint, fingerprintVersion: finding.fingerprintVersion,
    category: finding.category, ruleId: finding.ruleId, provenance: finding.provenance,
    verification: finding.verification, matchKind: "confirmed", occurredAt: new Date()
  });
  return { execution, finding };
}

describeDatabase("MongoDB persistence and index integration", () => {
  beforeAll(async () => {
    await mongoose.connect(integrationUri, { serverSelectionTimeoutMS: 5000 });
    await mongoose.connection.dropDatabase();
    await Promise.all(models.map((model) => model.createIndexes()));
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
    await mongoose.connection.collection("sessions").deleteMany({});
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test("persists revision-bound review records and builds declared indexes", async () => {
    const repository = await SelectedRepository.create({
      githubRepositoryId: "987654321", installationId: "1122", fullName: "insight-test/repo", isPrivate: true
    });
    const execution = await ReviewExecution.create({
      repositoryId: repository.githubRepositoryId,
      repositoryName: repository.fullName,
      pullRequestNumber: 8,
      baseSha: sha,
      headSha: "c".repeat(40),
      analyzerVersion: "test-analyzer",
      providerConfiguration: { provider: "none", maxAttempts: 1 },
      limitSnapshot: {
        repositoryCandidateFiles: 1000, repositorySourceBytes: 20 * 1024 * 1024,
        parsedFileBytes: 500 * 1024, pullRequestChangedFiles: 50,
        pullRequestDiffBytes: 500 * 1024, selectedContextBytes: 100 * 1024,
        operationTimeoutMs: 60_000
      },
      status: "completed",
      startedAt: new Date(),
      changedFiles: [{ path: "src/example.js", status: "modified", headContentHash: contentHash }]
    });
    const finding = await Finding.create({
      executionId: execution._id, repositoryId: repository.githubRepositoryId, pullRequestNumber: 8,
      baseSha: execution.baseSha, headSha: execution.headSha, ruleId: "SEC001", category: "security",
      severity: "medium", title: "Example finding", explanation: "A test-only fixture.",
      path: "src/example.js", side: "head", startLine: 1, endLine: 1,
      evidence: [{ path: "src/example.js", side: "head", startLine: 1, endLine: 1, snippet: "1: eval(input);", contentHash }],
      suggestedImprovement: "Use an explicit operation.", confidence: "medium", provenance: "deterministic",
      verification: "rule_checked", disposition: "accepted", fingerprint: "d".repeat(64),
      fingerprintVersion: "insight-fingerprint-v1", testGuidance: "Test an unsafe input."
    });
    await AnalysisArtifact.create({
      executionId: execution._id, repositoryId: repository.githubRepositoryId, pullRequestNumber: 8,
      baseSha: execution.baseSha, headSha: execution.headSha, path: "src/example.js",
      headContentHash: contentHash, imports: [], exports: [], structuralChanges: {}
    });
    await HistoricalOccurrence.create({
      repositoryId: repository.githubRepositoryId, pullRequestNumber: 8, executionId: execution._id,
      findingId: finding._id, fingerprint: finding.fingerprint, fingerprintVersion: finding.fingerprintVersion,
      category: finding.category, ruleId: finding.ruleId, provenance: finding.provenance,
      verification: finding.verification, matchKind: "confirmed", occurredAt: new Date()
    });
    const proposal = await PatchProposal.create({
      executionId: execution._id, findingId: finding._id, repositoryId: repository.githubRepositoryId,
      pullRequestNumber: 8, expectedHeadSha: execution.headSha, path: finding.path,
      expectedFileHash: contentHash, originalCode: "eval(input);", proposedCode: "handle(input);",
      unifiedDiff: "--- old\n+++ new", validationStatus: "valid", providerName: "openai", providerModel: "test-model"
    });
    const credential = await GitHubCredential.create({
      githubUserId: "123", githubLogin: "insight-test", encryptedAccessToken: "v1.encrypted.access",
      encryptedRefreshToken: "v1.encrypted.refresh", accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + 3600_000), lastAuthenticatedAt: new Date()
    });
    const webhook = await WebhookDelivery.create({ deliveryId: "integration-delivery-1", event: "installation", action: "suspend" });

    expect((await ReviewExecution.findById(execution._id).lean()).headSha).toBe(execution.headSha);
    expect((await Finding.findById(finding._id).lean()).evidence[0].contentHash).toBe(contentHash);
    expect((await PatchProposal.findById(proposal._id).lean()).expectedFileHash).toBe(contentHash);
    expect((await HistoricalOccurrence.countDocuments({ executionId: execution._id }))).toBe(1);
    expect((await AnalysisArtifact.countDocuments({ executionId: execution._id }))).toBe(1);
    expect((await WebhookDelivery.findById(webhook._id).lean()).processedAt).toBeNull();
    expect((await GitHubCredential.findById(credential._id)).encryptedRefreshToken).toBeUndefined();
    expect((await GitHubCredential.findById(credential._id).select("+encryptedRefreshToken")).encryptedRefreshToken).toBe("v1.encrypted.refresh");

    await expect(SelectedRepository.create({
      githubRepositoryId: repository.githubRepositoryId, installationId: "1122", fullName: "insight-test/duplicate", isPrivate: true
    })).rejects.toMatchObject({ code: 11000 });

    const repositoryIndexes = await SelectedRepository.collection.indexes();
    expect(repositoryIndexes.some((index) => index.key.githubRepositoryId === 1 && index.unique)).toBe(true);
    const executionIndexes = await ReviewExecution.collection.indexes();
    expect(executionIndexes.some((index) => index.key.repositoryId === 1 && index.key.pullRequestNumber === 1 && index.key.createdAt === -1)).toBe(true);
    const findingIndexes = await Finding.collection.indexes();
    expect(findingIndexes.some((index) => index.key.repositoryId === 1 && index.key.fingerprintVersion === 1 && index.key.fingerprint === 1)).toBe(true);
    const patchIndexes = await PatchProposal.collection.indexes();
    expect(patchIndexes.some((index) => index.key.executionId === 1 && index.key.findingId === 1 && index.key.createdAt === -1)).toBe(true);
    const occurrenceIndexes = await HistoricalOccurrence.collection.indexes();
    expect(occurrenceIndexes.some((index) => index.key.repositoryId === 1 && index.key.fingerprintVersion === 1 && index.key.fingerprint === 1)).toBe(true);
    const artifactIndexes = await AnalysisArtifact.collection.indexes();
    expect(artifactIndexes.some((index) => index.key.executionId === 1 && index.key.path === 1 && index.unique)).toBe(true);
    const credentialIndexes = await GitHubCredential.collection.indexes();
    expect(credentialIndexes.some((index) => index.key.singletonKey === 1 && index.unique)).toBe(true);
    const webhookIndexes = await WebhookDelivery.collection.indexes();
    expect(webhookIndexes.some((index) => index.key.receivedAt === 1 && index.expireAfterSeconds === 60 * 24 * 60 * 60)).toBe(true);
  });

  test("stores and reloads server-side sessions through MongoDB", async () => {
    const sessionMiddleware = createSessionMiddleware({
      NODE_ENV: "test",
      SESSION_SECRET: "integration-session-secret-with-more-than-32-characters",
      MONGODB_URI: integrationUri
    });
    const app = express();
    app.use(sessionMiddleware);
    app.get("/seed-session", (req, res) => {
      req.session.user = { githubUserId: "123", login: "integration-user" };
      res.json({ saved: true });
    });
    app.get("/read-session", (req, res) => res.json({ user: req.session.user || null }));

    const client = request.agent(app);
    try {
      await client.get("/seed-session").expect(200);
      await client.get("/read-session").expect(200).expect(({ body }) => {
        expect(body.user.githubUserId).toBe("123");
      });
      expect(await mongoose.connection.collection("sessions").countDocuments()).toBeGreaterThan(0);
    } finally {
      await sessionMiddleware.store.close();
    }
  });

  test("runs deterministic review orchestration against real MongoDB models with a mocked GitHub snapshot", async () => {
    const repository = await SelectedRepository.create({
      githubRepositoryId: "987654322", installationId: "1122", fullName: "insight-test/review", isPrivate: true
    });
    const baseContent = "export function run(value) { return value; }\n";
    const headContent = "export function run(value) { return eval(value); }\n";
    const contentHashOf = (content) => createHash("sha256").update(content).digest("hex");
    const snapshot = { repositoryId: repository.githubRepositoryId, pullRequestNumber: 12, baseSha: "1".repeat(40), headSha: "2".repeat(40) };
    const file = {
      path: "src/run.js", status: "modified", patch: "@@ -1 +1 @@\n-export function run(value) { return value; }\n+export function run(value) { return eval(value); }",
      patchBytes: 90, diffIncluded: true,
      changedHeadLineRanges: [{ startLine: 1, endLine: 1 }], changedBaseLineRanges: [{ startLine: 1, endLine: 1 }],
      base: { content: baseContent, contentHash: contentHashOf(baseContent), blobSha: "3".repeat(40) },
      head: { content: headContent, contentHash: contentHashOf(headContent), blobSha: "4".repeat(40) }
    };
    const config = {
      FINGERPRINT_HMAC_KEY: "f".repeat(64), OPERATION_TIMEOUT_MS: 60_000, LLM_PROVIDER: "none",
      MAX_REPOSITORY_FILES: 1000, MAX_REPOSITORY_SOURCE_BYTES: 20 * 1024 * 1024,
      MAX_PARSED_FILE_BYTES: 500 * 1024, MAX_PR_CHANGED_FILES: 50,
      MAX_PR_DIFF_BYTES: 500 * 1024, MAX_CONTEXT_BYTES: 100 * 1024
    };
    const runReview = createReviewService({
      fetchSnapshot: async ({ onSnapshotPinned }) => {
        await onSnapshotPinned(snapshot);
        return { snapshot, files: [file], sourceBytes: Buffer.byteLength(baseContent) + Buffer.byteLength(headContent), warnings: [], analyzerCandidates: [{
          path: file.path, baseContent, headContent,
          changedHeadLineRanges: file.changedHeadLineRanges,
          changedBaseLineRanges: file.changedBaseLineRanges
        }] };
      },
      selectContext: async () => ({
        selected: [],
        manifest: { candidateCount: 0, inspectedCount: 0, fetchedBytes: 0, selectedBytes: 0, files: [] },
        warnings: []
      }),
      assertSnapshotCurrent: async () => true
    });

    const result = await runReview({ repository, pullRequestNumber: 12, accessToken: "mock-token", config });
    const storedExecution = await ReviewExecution.findById(result.execution._id).lean();
    const storedFinding = await Finding.findOne({ executionId: result.execution._id }).lean();

    expect(storedExecution.status).toBe("partial");
    expect(storedExecution.baseSha).toBe(snapshot.baseSha);
    expect(storedExecution.headSha).toBe(snapshot.headSha);
    expect(storedFinding.provenance).toBe("deterministic");
    expect(storedFinding.verification).toBe("rule_checked");
    expect(storedFinding.evidence[0].contentHash).toBe(file.head.contentHash);
    expect(await HistoricalOccurrence.countDocuments({ executionId: result.execution._id })).toBe(1);
    expect(await AnalysisArtifact.countDocuments({ executionId: result.execution._id })).toBe(1);
  });

  test("bounds history recurrence aggregation and reports coverage denominators", async () => {
    const config = configForIntegration({ MAX_HISTORY_AGGREGATE_RECORDS: 2, MAX_HISTORY_AGGREGATE_ROWS: 10 });
    const repository = await SelectedRepository.create({
      githubRepositoryId: "987654330", installationId: "1122", fullName: "insight-test/history", isPrivate: true
    });
    await seedCredential("123", config);
    for (let index = 0; index < 3; index += 1) {
      const { execution, finding } = await seedReviewData(repository);
      await HistoricalOccurrence.create({
        repositoryId: repository.githubRepositoryId, pullRequestNumber: execution.pullRequestNumber,
        executionId: execution._id, findingId: finding._id, fingerprint: "f".repeat(64),
        fingerprintVersion: "insight-fingerprint-v1", category: "security", ruleId: "SEC001",
        provenance: "deterministic", verification: "rule_checked", matchKind: "confirmed",
        occurredAt: new Date(Date.now() + index)
      });
    }
    await HistoricalOccurrence.deleteMany({ repositoryId: repository.githubRepositoryId, fingerprint: { $ne: "f".repeat(64) } });
    const harness = await createAuthenticatedTestApp(config, [createReviewRouter(config)]);
    try {
      const response = await request(harness.app).get(`/api/v1/repositories/${repository.githubRepositoryId}/history?limit=1`).expect(200);
      expect(response.body.executions).toHaveLength(1);
      expect(response.body.hasMore).toBe(true);
      expect(response.body.nextCursor).toEqual(expect.any(String));
      expect(response.body.recurrenceCoverage).toMatchObject({ occurrencesAvailable: 3, occurrencesAnalyzed: 2, complete: false });
      expect(response.body.recurrence.find((item) => item.fingerprint === "f".repeat(64))).toMatchObject({ count: 2, comparableExecutionCount: 2 });
      expect(response.body.coverage).toMatchObject({ reviewedExecutionsAvailable: 3, aggregationIncomplete: true, aggregationRecordLimit: 2 });
    } finally { await harness.close(); }
  });

  test("purges connected detail after retention and removes expired uninstall-grace data", async () => {
    const config = configForIntegration({ CONNECTED_RETENTION_DAYS: 90, UNINSTALL_GRACE_DAYS: 30 });
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const graceDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const connectedRepo = await SelectedRepository.create({ githubRepositoryId: "987654340", installationId: "1122", fullName: "insight-test/old", isPrivate: true });
    const { execution, finding } = await seedReviewData(connectedRepo);
    await ReviewExecution.collection.updateOne({ _id: execution._id }, { $set: { createdAt: oldDate } });
    await Finding.collection.updateOne({ _id: finding._id }, { $set: { createdAt: oldDate } });
    const oldPatch = await PatchProposal.create({
      executionId: execution._id, findingId: finding._id, repositoryId: connectedRepo.githubRepositoryId,
      pullRequestNumber: execution.pullRequestNumber, expectedHeadSha: execution.headSha, path: finding.path,
      expectedFileHash: contentHash, originalCode: "before", proposedCode: "after", unifiedDiff: "diff",
      validationStatus: "valid", providerName: "openai", providerModel: "gpt-4o-mini", createdAt: oldDate
    });
    await PatchProposal.collection.updateOne({ _id: oldPatch._id }, { $set: { createdAt: oldDate } });
    const oldArtifact = await AnalysisArtifact.create({
      executionId: execution._id, repositoryId: connectedRepo.githubRepositoryId, pullRequestNumber: execution.pullRequestNumber,
      baseSha: execution.baseSha, headSha: execution.headSha, path: finding.path, headContentHash: contentHash,
      imports: [], exports: [], structuralChanges: {}, createdAt: oldDate
    });
    await AnalysisArtifact.collection.updateOne({ _id: oldArtifact._id }, { $set: { createdAt: oldDate } });

    const graceRepo = await SelectedRepository.create({ githubRepositoryId: "987654341", installationId: "1122", fullName: "insight-test/grace", isPrivate: true, accessStatus: "suspended", revokedAt: graceDate });
    const { execution: graceExecution, finding: graceFinding } = await seedReviewData(graceRepo);
    await ReviewExecution.updateOne({ _id: graceExecution._id }, { $set: { retentionState: "uninstall_grace", gracePurgeAt: graceDate } });
    await Finding.updateOne({ _id: graceFinding._id }, { $set: { retentionState: "uninstall_grace", gracePurgeAt: graceDate } });
    await HistoricalOccurrence.updateMany({ repositoryId: graceRepo.githubRepositoryId }, { $set: { retentionState: "uninstall_grace", gracePurgeAt: graceDate } });
    await PatchProposal.create({
      executionId: graceExecution._id, findingId: graceFinding._id, repositoryId: graceRepo.githubRepositoryId,
      pullRequestNumber: graceExecution.pullRequestNumber, expectedHeadSha: graceExecution.headSha, path: graceFinding.path,
      expectedFileHash: contentHash, originalCode: "before", proposedCode: "after", unifiedDiff: "diff",
      validationStatus: "valid", providerName: "openai", providerModel: "gpt-4o-mini",
      retentionState: "uninstall_grace", gracePurgeAt: graceDate
    });

    const result = await purgeExpiredData(config);
    expect(result.oldFindings).toBeGreaterThanOrEqual(1);
    expect(await Finding.exists({ _id: finding._id })).toBeNull();
    expect(await PatchProposal.exists({ repositoryId: connectedRepo.githubRepositoryId })).toBeNull();
    expect(await ReviewExecution.exists({ _id: execution._id })).not.toBeNull();
    expect(await HistoricalOccurrence.exists({ repositoryId: connectedRepo.githubRepositoryId })).not.toBeNull();
    expect(await ReviewExecution.exists({ _id: graceExecution._id })).toBeNull();
    expect(await Finding.exists({ _id: graceFinding._id })).toBeNull();
    expect(await HistoricalOccurrence.exists({ repositoryId: graceRepo.githubRepositoryId })).toBeNull();
    expect(await SelectedRepository.exists({ _id: graceRepo._id })).toBeNull();
  });

  test("handles signed user revocation, installation suspension, and reconnect retention", async () => {
    const config = configForIntegration();
    const repository = await SelectedRepository.create({ githubRepositoryId: "987654350", installationId: "1122", fullName: "insight-test/reconnect", isPrivate: true });
    const { execution, finding } = await seedReviewData(repository);
    await PatchProposal.create({
      executionId: execution._id, findingId: finding._id, repositoryId: repository.githubRepositoryId,
      pullRequestNumber: execution.pullRequestNumber, expectedHeadSha: execution.headSha, path: finding.path,
      expectedFileHash: contentHash, originalCode: "eval(input);", proposedCode: "safe(input);", unifiedDiff: "diff",
      validationStatus: "valid", providerName: "openai", providerModel: "gpt-4o-mini"
    });
    const initialCredential = await seedCredential("123", config);
    const webhookApp = express();
    webhookApp.use("/api/v1", createGitHubWebhookRouter(config));
    const otherUserPayload = Buffer.from(JSON.stringify({ action: "revoked", sender: { id: 999, login: "other-user" } }));
    const otherUserSignature = "sha256=" + createHmac("sha256", webhookSecret).update(otherUserPayload).digest("hex");
    await request(webhookApp).post("/api/v1/webhooks/github").set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "integration-other-user-revoke").set("X-GitHub-Event", "github_app_authorization")
      .set("X-Hub-Signature-256", otherUserSignature).send(otherUserPayload.toString("utf8")).type("json").expect(202);
    expect((await GitHubCredential.findById(initialCredential._id)).status).toBe("active");
    const authorizationPayload = Buffer.from(JSON.stringify({ action: "revoked", sender: { id: 123, login: "integration-user" } }));
    const authorizationSignature = "sha256=" + createHmac("sha256", webhookSecret).update(authorizationPayload).digest("hex");
    await request(webhookApp).post("/api/v1/webhooks/github").set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "integration-user-revoke").set("X-GitHub-Event", "github_app_authorization")
      .set("X-Hub-Signature-256", authorizationSignature).send(authorizationPayload.toString("utf8")).type("json").expect(202);
    const revokedCredential = await GitHubCredential.findById(initialCredential._id).select("+encryptedAccessToken +encryptedRefreshToken");
    expect(revokedCredential.status).toBe("revoked");
    expect(revokedCredential.encryptedAccessToken).toBeUndefined();
    expect((await SelectedRepository.findById(repository._id)).accessStatus).toBe("reauthorization_required");

    await GitHubCredential.updateOne({ _id: initialCredential._id }, {
      $set: {
        status: "active", encryptedAccessToken: encryptToken("new-access-token", config.TOKEN_ENCRYPTION_KEY),
        encryptedRefreshToken: encryptToken("new-refresh-token", config.TOKEN_ENCRYPTION_KEY),
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });
    const githubApiRequest = async (path) => {
      if (path.includes("/repositories?")) return { repositories: [{ id: 987654350, name: "reconnect", full_name: "insight-test/reconnect", private: true, owner: { login: "insight-test" } }] };
      throw new Error(`Unexpected GitHub fixture path: ${path}`);
    };
    const harness = await createAuthenticatedTestApp(config, [createRepositoryRouter(config, { githubApiRequest })]);
    try {
      await request(harness.app).put(`/api/v1/repositories/${repository.githubRepositoryId}/selection`)
        .set("X-CSRF-Token", "integration-csrf-token")
        .send({ installationId: 1122, selected: true, retainHistory: true }).expect(200);
    } finally { await harness.close(); }
    expect((await SelectedRepository.findById(repository._id)).accessStatus).toBe("active");
    expect((await ReviewExecution.findById(execution._id)).retentionState).toBe("connected");
    expect((await Finding.findById(finding._id)).evidence).toHaveLength(1);
    const proposalAfterReconnect = await PatchProposal.findOne({ executionId: execution._id });
    expect(proposalAfterReconnect.retentionState).toBe("connected");
    expect(proposalAfterReconnect.contentDeleted).toBe(false);

    const suspendPayload = Buffer.from(JSON.stringify({ action: "suspend", installation: { id: 1122 } }));
    const suspendSignature = "sha256=" + createHmac("sha256", webhookSecret).update(suspendPayload).digest("hex");
    await request(webhookApp).post("/api/v1/webhooks/github").set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "integration-install-suspend").set("X-GitHub-Event", "installation")
      .set("X-Hub-Signature-256", suspendSignature).send(suspendPayload.toString("utf8")).type("json").expect(202);
    expect((await SelectedRepository.findById(repository._id)).accessStatus).toBe("suspended");
    expect((await ReviewExecution.findById(execution._id)).retentionState).toBe("uninstall_grace");
    expect((await Finding.findById(finding._id)).evidence).toHaveLength(0);
    expect((await PatchProposal.findOne({ executionId: execution._id })).contentDeleted).toBe(true);
  });

  test("serves successful repository, PR, review, history and patch-creation API flows", async () => {
    const config = configForIntegration({ MAX_REPOSITORY_RESULTS: 1, MAX_FINDINGS_PER_RESPONSE: 1 });
    const repository = await SelectedRepository.create({ githubRepositoryId: "987654360", installationId: "1122", fullName: "insight-test/api", isPrivate: true });
    const { execution, finding } = await seedReviewData(repository);
    await Finding.create({
      executionId: execution._id, repositoryId: repository.githubRepositoryId, pullRequestNumber: execution.pullRequestNumber,
      baseSha: execution.baseSha, headSha: execution.headSha, ruleId: "SEC003", category: "security",
      severity: "low", title: "Second fixture finding", explanation: "A second test-only fixture.",
      path: "src/other.js", side: "head", startLine: 2, endLine: 2,
      evidence: [{ path: "src/other.js", side: "head", startLine: 2, endLine: 2, snippet: "2: secure();", contentHash }],
      suggestedImprovement: "Keep the secure behavior.", confidence: "low", provenance: "deterministic",
      verification: "rule_checked", disposition: "accepted", fingerprint: "9".repeat(64),
      fingerprintVersion: "insight-fingerprint-v1"
    });
    await seedCredential("123", config);
    const githubApiRequest = async (path) => {
      if (path === "/user/installations?per_page=100&page=1") return { installations: [{ id: 1122 }] };
      if (path.includes("/user/installations/1122/repositories?")) {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
        return { repositories: page === 1 ? [{ id: 987654360, name: "api", full_name: "insight-test/api", private: true, owner: { login: "insight-test" } }] : [] };
      }
      if (path.includes("/pulls?")) {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
        return Array.from({ length: 50 }, (_, index) => ({
          number: page * 50 + index + 1, title: "Sample PR " + index, state: "open",
          html_url: `https://github.com/insight-test/api/pull/${page * 50 + index + 1}`,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          base: { sha, ref: "main" }, head: { sha: execution.headSha, ref: "feature" }, user: { login: "integration-user" }
        }));
      }
      throw new Error(`Unexpected GitHub fixture path: ${path}`);
    };
    const createProposal = async ({ execution: reviewed, finding: reviewedFinding }) => PatchProposal.create({
      executionId: reviewed._id, findingId: reviewedFinding._id, repositoryId: reviewed.repositoryId,
      pullRequestNumber: reviewed.pullRequestNumber, expectedHeadSha: reviewed.headSha,
      path: reviewedFinding.path, expectedFileHash: contentHash, originalCode: "eval(input);",
      proposedCode: "handle(input);", unifiedDiff: "--- original\n+++ proposed",
      validationStatus: "valid", validationMessage: "Integration route fixture.",
      providerName: "openai", providerModel: "gpt-4o-mini"
    });
    const routers = [
      createRepositoryRouter(config, { githubApiRequest }),
      createReviewRouter(config),
      createPatchRouter(config, { createProposal })
    ];
    const harness = await createAuthenticatedTestApp(config, routers);
    try {
      const repositories = await request(harness.app).get("/api/v1/repositories").expect(200);
      expect(repositories.body.repositories[0]).toMatchObject({ id: repository.githubRepositoryId, selected: true, accessStatus: "active" });
      expect(repositories.body).toMatchObject({ hasMore: true, incomplete: false, limit: 1 });
      const repositoryPageTwo = await request(harness.app).get(`/api/v1/repositories?cursor=${repositories.body.nextCursor}`).expect(200);
      expect(repositoryPageTwo.body).toMatchObject({ hasMore: false, incomplete: false });

      const pulls = await request(harness.app).get(`/api/v1/repositories/${repository.githubRepositoryId}/pull-requests`).expect(200);
      expect(pulls.body.pullRequests[0]).toMatchObject({ number: 51, title: "Sample PR 0", headSha: execution.headSha });
      expect(pulls.body).toMatchObject({ hasMore: true, incomplete: false, limit: 50, nextCursor: "2" });
      const pullPageTen = await request(harness.app).get(`/api/v1/repositories/${repository.githubRepositoryId}/pull-requests?cursor=10`).expect(200);
      expect(pullPageTen.body).toMatchObject({ hasMore: true, incomplete: true, nextCursor: null, incompleteReason: "github_page_limit" });

      const review = await request(harness.app).get(`/api/v1/reviews/${execution._id}`).expect(200);
      expect(review.body.execution.headSha).toBe(execution.headSha);
      const findings = await request(harness.app).get(`/api/v1/reviews/${execution._id}/findings?limit=100`).expect(200);
      expect(findings.body.findings[0].path).toBe("src/other.js");
      expect(findings.body).toMatchObject({ hasMore: true, limit: 1 });
      expect(findings.body.findings).toHaveLength(1);

      const history = await request(harness.app).get(`/api/v1/repositories/${repository.githubRepositoryId}/history`).expect(200);
      expect(history.body.executions[0]._id).toBe(String(execution._id));
      expect(history.body.recurrence[0]).toMatchObject({ fingerprint: finding.fingerprint, count: 1 });

      const patch = await request(harness.app).post(`/api/v1/reviews/${execution._id}/findings/${finding._id}/patch-proposals`)
        .set("X-CSRF-Token", "integration-csrf-token")
        .send({ expectedHeadSha: execution.headSha, expectedFileHash: contentHash }).expect(201);
      expect(patch.body.patchProposal.expectedHeadSha).toBe(execution.headSha);
      expect(await PatchProposal.countDocuments({ executionId: execution._id })).toBe(1);
    } finally { await harness.close(); }
  });
});
