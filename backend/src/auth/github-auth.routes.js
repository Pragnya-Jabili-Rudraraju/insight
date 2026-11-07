const express = require("express");
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const GitHubCredential = require("../models/github-credential.model");
const { encryptToken } = require("../security/token-vault");
const { exchangeCode, getAuthenticatedUser, revokeGrant } = require("./github-client");
const { requireCsrf } = require("../security/csrf");
const { requireSession } = require("./auth-middleware");
const { revokeConfiguredUser } = require("./token-service");

function configured(config) {
  return Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET && config.GITHUB_ALLOWED_USER_ID && config.TOKEN_ENCRYPTION_KEY);
}

function safeError(res, req, status, code, message) {
  return res.status(status).json({ error: { code, message, retryable: false, requestId: req.requestId } });
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function createGitHubAuthRouter(config) {
  const router = express.Router();

  router.get("/auth/github/start", (req, res) => {
    if (!configured(config)) return safeError(res, req, 503, "GITHUB_NOT_CONFIGURED", "GitHub connection is not configured yet.");
    if (!req.session) return safeError(res, req, 503, "SESSION_UNAVAILABLE", "Session service is unavailable.");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    req.session.oauthTransaction = { state, verifier, createdAt: Date.now() };

    const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", config.GITHUB_CLIENT_ID);
    authorizationUrl.searchParams.set("redirect_uri", config.GITHUB_CALLBACK_URL);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("allow_signup", "false");
    return res.redirect(302, authorizationUrl.toString());
  });

  router.get("/auth/github/callback", async (req, res, next) => {
    const transaction = req.session?.oauthTransaction;
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!req.session || !transaction || !secureEqual(transaction.state, state) || Date.now() - transaction.createdAt > 10 * 60 * 1000) {
      return safeError(res, req, 400, "OAUTH_STATE_INVALID", "GitHub sign-in expired. Start the connection again.");
    }
    delete req.session.oauthTransaction;
    if (req.query.error) {
      return req.session.save((error) => error ? next(error) : res.redirect(302, `${config.FRONTEND_ORIGIN}/?github=cancelled`));
    }
    if (!code || code.length > 500) return safeError(res, req, 400, "OAUTH_CODE_INVALID", "GitHub sign-in could not be completed.");
    try {
      await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      const token = await exchangeCode(config, code, transaction.verifier);
      const user = await getAuthenticatedUser(token.access_token);
      if (String(user.id) !== config.GITHUB_ALLOWED_USER_ID) {
        await revokeGrant(config, token.access_token).catch(() => false);
        return safeError(res, req, 403, "GITHUB_ACCOUNT_NOT_ALLOWED", "This GitHub account is not the configured Insight account.");
      }

      const now = new Date();
      await GitHubCredential.findOneAndUpdate({ singletonKey: "primary" }, {
        $set: {
          githubUserId: String(user.id),
          githubLogin: user.login,
          encryptedAccessToken: encryptToken(token.access_token, config.TOKEN_ENCRYPTION_KEY),
          encryptedRefreshToken: encryptToken(token.refresh_token, config.TOKEN_ENCRYPTION_KEY),
          accessTokenExpiresAt: new Date(now.getTime() + token.expires_in * 1000),
          refreshTokenExpiresAt: new Date(now.getTime() + token.refresh_token_expires_in * 1000),
          status: "active",
          lastAuthenticatedAt: now
        }
      }, { upsert: true, new: true, runValidators: true });

      await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
      req.session.user = { githubUserId: String(user.id), login: user.login };
      req.session.csrfToken = randomBytes(32).toString("base64url");
      await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      return res.redirect(302, `${config.FRONTEND_ORIGIN}/?github=connected`);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/session", async (req, res, next) => {
    const user = req.session?.user;
    if (!user) return res.json({ authenticated: false });
    try {
      const credential = await GitHubCredential.findOne({ singletonKey: "primary", githubUserId: user.githubUserId }).select("status").lean();
      return res.json({
        authenticated: true,
        githubUser: user,
        githubConnection: credential?.status === "active" ? "connected" : "reauthorization_required"
      });
    } catch (error) { return next(error); }
  });

  router.post("/auth/github/disconnect", requireSession, requireCsrf, async (req, res, next) => {
    try {
      await revokeConfiguredUser(config);
      if (!req.session) return res.status(204).end();
      return req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie(config.NODE_ENV === "production" ? "__Host-insight.sid" : "insight.sid", {
          httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax", path: "/"
        });
        return res.status(204).end();
      });
    } catch (error) { return next(error); }
  });

  router.post("/session/logout", requireCsrf, (req, res, next) => {
    if (!req.session) return res.status(204).end();
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie(config.NODE_ENV === "production" ? "__Host-insight.sid" : "insight.sid", {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "lax",
        path: "/"
      });
      return res.status(204).end();
    });
  });

  return router;
}

module.exports = { createGitHubAuthRouter };
