const concepts = Object.freeze({
  "dynamic-code-execution": {
    title: "Dynamic code execution",
    explanation: "Dynamic execution treats a string as program code. Its behavior can be hard to inspect and unsafe when the string includes untrusted input.",
    example: "// Prefer an explicit mapping over eval(input)\nconst handlers = { sum: add, save: saveRecord };\nhandlers[action]?.(value);"
  },
  "secret-management": {
    title: "Secret management",
    explanation: "Credentials should come from a secret store or protected environment configuration, not source code. Rotate a credential if it may have been committed.",
    example: "const apiKey = process.env.PAYMENT_API_KEY;\nif (!apiKey) throw new Error('Missing payment key');"
  },
  "tls-certificate-validation": {
    title: "TLS certificate validation",
    explanation: "TLS certificate checks confirm that a remote service is the service the client intended to contact. Disabling checks can expose traffic to interception.",
    example: "const agent = new https.Agent({ rejectUnauthorized: true });"
  },
  "public-api-compatibility": {
    title: "Public API compatibility",
    explanation: "An exported function or value may have callers elsewhere in the repository or in downstream packages. Check those callers before changing its contract.",
    example: "// Keep old callers working while adding an optional argument\nexport function loadItem(id, options = {}) { /* ... */ }"
  },
  "regression-testing": {
    title: "Regression tests",
    explanation: "A regression test captures behavior that should keep working after a change. Prefer a test that exercises the affected public behavior and its failure case.",
    example: "test('rejects an invalid certificate', async () => {\n  await expect(connectToInvalidCertificate()).rejects.toThrow();\n});"
  }
});

const conceptForRule = Object.freeze({
  JS001: "regression-testing",
  SEC001: "dynamic-code-execution",
  SEC002: "secret-management",
  SEC003: "tls-certificate-validation",
  API001: "public-api-compatibility",
  API002: "public-api-compatibility"
});

function getConcept(conceptId) { return concepts[conceptId] || null; }

module.exports = { conceptForRule, getConcept };
