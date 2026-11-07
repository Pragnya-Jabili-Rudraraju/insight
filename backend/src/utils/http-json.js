async function readJsonLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    const error = new Error("Upstream response exceeded the configured input limit.");
    error.code = "UPSTREAM_RESPONSE_LIMIT";
    error.status = 413;
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      const error = new Error("Upstream response exceeded the configured input limit.");
      error.code = "UPSTREAM_RESPONSE_LIMIT";
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

module.exports = { readJsonLimited };
