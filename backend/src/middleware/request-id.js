const { randomUUID } = require("node:crypto");

function requestId(req, res, next) {
  const id = randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

module.exports = { requestId };
