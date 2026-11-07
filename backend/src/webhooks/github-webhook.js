const express = require("express");
const { createHmac, timingSafeEqual } = require("node:crypto");
const { z } = require("zod");
const WebhookDelivery = require("../models/webhook-delivery.model");
const SelectedRepository = require("../models/selected-repository.model");
const { graceExpiry, revokeInstallationAccess, sanitizeRepositoryData } = require("../retention/retention.service");
const GitHubCredential = require("../models/github-credential.model");
const { invalidateCredential } = require("../auth/token-service");

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signatureHeader !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader) || !secret) return false;
  const provided = Buffer.from(signatureHeader.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const installationSchema = z.object({ id: z.number().int().positive() }).passthrough();
const eventSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  repositories_removed: z.array(z.object({ id: z.number().int().positive() }).passthrough()).optional(),
  repositories_added: z.array(z.object({ id: z.number().int().positive() }).passthrough()).optional()
}).passthrough();

async function processInstallationEvent(eventName, payload, config) {
  if (eventName === "github_app_authorization") {
    const parsedAuthorization = z.object({
      action: z.literal("revoked"),
      sender: z.object({ id: z.number().int().positive() }).passthrough()
    }).passthrough().safeParse(payload);
    if (!parsedAuthorization.success) throw Object.assign(new Error("GitHub authorization webhook payload is invalid."), { status: 400, code: "WEBHOOK_PAYLOAD_INVALID" });
    const githubUserId = String(parsedAuthorization.data.sender.id);
    const credential = await GitHubCredential.findOne({ singletonKey: "primary" }).select("+encryptedAccessToken +encryptedRefreshToken");
    if (credential?.githubUserId === githubUserId && credential.status === "active") {
      await invalidateCredential(credential, "revoked");
    }
    return;
  }

  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) throw Object.assign(new Error("GitHub webhook payload is invalid."), { status: 400, code: "WEBHOOK_PAYLOAD_INVALID" });
  const event = parsed.data;
  const installationId = String(event.installation.id);

  if (eventName === "installation" && ["deleted", "suspend"].includes(event.action)) {
    const accessStatus = event.action === "suspend" ? "suspended" : "uninstalled";
    await revokeInstallationAccess(installationId, accessStatus, config);
    return;
  }
  if (eventName === "installation" && event.action === "unsuspend") {
    await SelectedRepository.updateMany({ installationId }, { $set: { accessStatus: "reauthorization_required" } });
    return;
  }
  if (eventName === "installation_repositories" && event.action === "removed") {
    const removedIds = (event.repositories_removed || []).map((repository) => String(repository.id));
    const repositories = await SelectedRepository.find({ installationId, githubRepositoryId: { $in: removedIds } }).select("githubRepositoryId").lean();
    const repositoryIds = repositories.map((repository) => repository.githubRepositoryId);
    const gracePurgeAt = graceExpiry(config);
    await SelectedRepository.updateMany({ installationId, githubRepositoryId: { $in: removedIds } }, { $set: { accessStatus: "uninstalled", revokedAt: new Date() } });
    await sanitizeRepositoryData(repositoryIds, gracePurgeAt);
  }
}

function createGitHubWebhookHandler(config) {
  return async function handleGitHubWebhook(req, res, next) {
    if (!config.GITHUB_APP_WEBHOOK_SECRET) {
      return res.status(503).json({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "GitHub webhook handling is not configured.", retryable: false, requestId: req.requestId } });
    }
    const rawBody = req.body;
    if (!verifyWebhookSignature(rawBody, req.get("x-hub-signature-256"), config.GITHUB_APP_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: { code: "WEBHOOK_SIGNATURE_INVALID", message: "Webhook signature is invalid.", retryable: false, requestId: req.requestId } });
    }
    const deliveryId = req.get("x-github-delivery");
    const eventName = req.get("x-github-event");
    if (!deliveryId || deliveryId.length > 100 || !eventName || !["installation", "installation_repositories", "github_app_authorization"].includes(eventName)) {
      return res.status(400).json({ error: { code: "WEBHOOK_HEADERS_INVALID", message: "Webhook headers are invalid.", retryable: false, requestId: req.requestId } });
    }
    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch {
      return res.status(400).json({ error: { code: "WEBHOOK_PAYLOAD_INVALID", message: "Webhook payload is invalid.", retryable: false, requestId: req.requestId } });
    }
    try {
      let delivery = await WebhookDelivery.findOne({ deliveryId });
      if (delivery?.processedAt) return res.status(202).json({ accepted: true, duplicate: true });
      if (!delivery) {
        try { delivery = await WebhookDelivery.create({ deliveryId, event: eventName, action: String(payload.action || "unknown") }); }
        catch (error) {
          if (error.code !== 11000) throw error;
          delivery = await WebhookDelivery.findOne({ deliveryId });
          if (delivery?.processedAt) return res.status(202).json({ accepted: true, duplicate: true });
        }
      }
      await processInstallationEvent(eventName, payload, config);
      delivery.processedAt = new Date();
      await delivery.save();
      return res.status(202).json({ accepted: true, duplicate: false });
    } catch (error) { return next(error); }
  };
}

function createGitHubWebhookRouter(config) {
  const router = express.Router();
  const { rateLimit } = require("express-rate-limit");
  router.post("/webhooks/github", rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }), express.raw({ type: "application/json", limit: "256kb" }), createGitHubWebhookHandler(config));
  return router;
}

module.exports = { createGitHubWebhookHandler, createGitHubWebhookRouter, processInstallationEvent, verifyWebhookSignature };
