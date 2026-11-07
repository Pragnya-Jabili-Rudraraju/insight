const { requireAccessToken } = require("./token-service");

function requireSession(req, res, next) {
  if (!req.session?.user?.githubUserId) {
    return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Connect your GitHub account to continue.", retryable: false, requestId: req.requestId } });
  }
  return next();
}

function createRequireGitHubAccess(config) {
  return async (req, res, next) => {
    if (!req.session?.user?.githubUserId) {
      return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Connect your GitHub account to continue.", retryable: false, requestId: req.requestId } });
    }
    try {
      req.githubAccessToken = await requireAccessToken(config, req.session.user.githubUserId);
      return next();
    } catch (error) {
      if (error.status === 401) {
        return res.status(401).json({ error: { code: error.code, message: error.message, retryable: false, requestId: req.requestId } });
      }
      return next(error);
    }
  };
}

module.exports = { createRequireGitHubAccess, requireSession };
