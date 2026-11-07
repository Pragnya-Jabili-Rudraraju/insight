const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { requestId } = require("./middleware/request-id");
const { notFound, errorHandler } = require("./middleware/error-handler");
const { healthRouter } = require("./routes/health.routes");
const { createGitHubAuthRouter } = require("./auth/github-auth.routes");
const { issueCsrfToken } = require("./security/csrf");
const { createRepositoryRouter } = require("./repositories/repository.routes");
const { createReviewRouter } = require("./reviews/review.routes");
const { createPatchAdapter, createProviderAdapter } = require("./ai/provider-adapter");
const { createGitHubWebhookRouter } = require("./webhooks/github-webhook");
const { createPatchRouter } = require("./patches/patch.routes");

function createApp(config, dependencies = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY ? 1 : false);
  app.use(helmet());
  app.use(requestId);
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin === config.FRONTEND_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.status(origin === config.FRONTEND_ORIGIN ? 204 : 403).end();
    return next();
  });
  app.use("/api/v1", createGitHubWebhookRouter(config));
  if (dependencies.sessionMiddleware) app.use(dependencies.sessionMiddleware);
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/api/v1", healthRouter);
  app.get("/api/v1/csrf", issueCsrfToken);
  app.use("/api/v1", createGitHubAuthRouter(config));
  app.use("/api/v1", createRepositoryRouter(config));
  app.use("/api/v1", createReviewRouter(config, {
    ...(dependencies.reviewDependencies || {}),
    aiReview: dependencies.aiReview === undefined ? createProviderAdapter(config) : dependencies.aiReview
  }));
  app.use("/api/v1", createPatchRouter(config, {
    ...(dependencies.patchDependencies || {}),
    proposePatch: dependencies.proposePatch === undefined ? createPatchAdapter(config) : dependencies.proposePatch
  }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
