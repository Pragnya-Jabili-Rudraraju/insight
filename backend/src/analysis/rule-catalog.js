const ANALYZER_VERSION = "insight-structural-0.1.0";

const RULES = Object.freeze({
  PARSE_ERROR: { id: "JS001", category: "correctness", severity: "high" },
  DYNAMIC_CODE: { id: "SEC001", category: "security", severity: "medium" },
  HARDCODED_SECRET: { id: "SEC002", category: "security", severity: "high" },
  UNSAFE_TLS: { id: "SEC003", category: "security", severity: "medium" },
  EXPORT_REMOVED: { id: "API001", category: "breaking-change", severity: "high" },
  SIGNATURE_CHANGED: { id: "API002", category: "breaking-change", severity: "medium" }
});

module.exports = { ANALYZER_VERSION, RULES };
