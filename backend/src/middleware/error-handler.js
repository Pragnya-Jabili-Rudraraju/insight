function notFound(req, res) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
      retryable: false,
      requestId: req.requestId
    }
  });
}

function errorHandler(error, req, res, _next) {
  const errorStatus = error.status || error.statusCode;
  const status = Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 600
    ? errorStatus
    : 500;
  if (status >= 500) console.error("request_failed", { requestId: req.requestId, name: error.name });

  const code = status === 500 ? "INTERNAL_ERROR"
    : error.type === "entity.parse.failed" ? "INVALID_JSON"
      : error.type === "entity.too.large" ? "REQUEST_TOO_LARGE"
        : (error.code || "REQUEST_ERROR");
  const message = status === 500 ? "An unexpected error occurred."
    : error.type === "entity.parse.failed" ? "Request body must contain valid JSON."
      : error.type === "entity.too.large" ? "Request body exceeds the configured limit."
        : error.message;
  res.status(status).json({
    error: {
      code,
      message,
      retryable: status === 429 || status >= 500,
      requestId: req.requestId
    }
  });
}

module.exports = { notFound, errorHandler };
