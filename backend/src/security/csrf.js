const { randomBytes, timingSafeEqual } = require("node:crypto");

function issueCsrfToken(req, res) {
  if (!req.session) return res.status(503).json({ error: { code: "SESSION_UNAVAILABLE", message: "Session service is unavailable.", retryable: true, requestId: req.requestId } });
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("base64url");
  return res.json({ csrfToken: req.session.csrfToken });
}

function requireCsrf(req, res, next) {
  const expected = req.session?.csrfToken;
  const supplied = req.get("x-csrf-token");
  if (!expected || !supplied) {
    return res.status(403).json({ error: { code: "CSRF_INVALID", message: "Refresh the page and try again.", retryable: false, requestId: req.requestId } });
  }
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    return res.status(403).json({ error: { code: "CSRF_INVALID", message: "Refresh the page and try again.", retryable: false, requestId: req.requestId } });
  }
  return next();
}

module.exports = { issueCsrfToken, requireCsrf };
