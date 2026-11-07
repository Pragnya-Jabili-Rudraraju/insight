const { createHmac } = require("node:crypto");

const SECRET_ASSIGNMENT = /((?:secret|token|password|api[_-]?key|private[_-]?key)\s*[:=]\s*)(["'`])[^"'`]*\2/gi;
const CREDENTIAL_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})\b/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const LONG_TOKEN_LITERAL = /(["'`])([A-Za-z0-9_+\/=.-]{32,})\1/g;

function redactEvidenceLine(line) {
  return line
    .replace(SECRET_ASSIGNMENT, '$1"[REDACTED]"')
    .replace(CREDENTIAL_PATTERN, "[REDACTED]")
    .replace(LONG_TOKEN_LITERAL, (_match, quote, value) => /[a-z]/i.test(value) && /\d/.test(value) ? `${quote}[REDACTED]${quote}` : _match)
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED]");
}

function redactSourceText(source) {
  return String(source).replace(PRIVATE_KEY_PATTERN, "[REDACTED]").split(/\r?\n/).map(redactEvidenceLine).join("\n");
}

function sourceForLocation(files, filePath, side) {
  const file = files.find((item) => item.path === filePath);
  if (!file) return null;
  const revision = side === "base" ? file.base : file.head;
  if (!revision?.content || !revision.contentHash) return null;
  const changedRanges = side === "base" ? file.changedBaseLineRanges : file.changedHeadLineRanges;
  return { content: revision.content, contentHash: revision.contentHash, changedRanges };
}

function intersectsChangedLines(startLine, endLine, ranges) {
  return Array.isArray(ranges) && ranges.some((range) => startLine <= range.endLine && endLine >= range.startLine);
}

function createFingerprint(finding, repositoryId, hmacKey, version = "insight-fingerprint-v1") {
  if (!/^[a-f0-9]{64}$/i.test(hmacKey || "")) throw new Error("A dedicated fingerprint HMAC key is required.");
  const ruleOrCategory = finding.ruleId || finding.category || "unknown";
  const affected = `${finding.path}:${finding.symbol ? `symbol:${finding.symbol}` : `line:${finding.startLine}`}`;
  const evidence = String(finding.fingerprintEvidence || finding.evidenceText || finding.title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/["'`]/g, "")
    .trim();
  return createHmac("sha256", Buffer.from(hmacKey, "hex"))
    .update(`${version}\u0000${repositoryId}\u0000${ruleOrCategory}\u0000${affected}\u0000${evidence}`)
    .digest("hex");
}

function sourceSnippet(content, startLine, endLine, ruleId) {
  const lines = content.split(/\r?\n/);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length || endLine - startLine > 40) {
    return null;
  }
  const from = Math.max(1, startLine - 1);
  const to = Math.min(lines.length, endLine + 1);
  return lines.slice(from - 1, to).map((line, index) => {
    const number = from + index;
    const sanitized = ruleId === "SEC002" ? redactEvidenceLine(line) : redactEvidenceLine(line);
    return `${number}: ${sanitized}`;
  }).join("\n").slice(0, 4000);
}

function validateFindings({ findings, files, repositoryId, hmacKey, fingerprintVersion = "insight-fingerprint-v1" }) {
  const validated = [];
  let rejectedCount = 0;
  for (const finding of findings) {
    const source = sourceForLocation(files, finding.path, finding.side || "head");
    const snippet = source && sourceSnippet(source.content, finding.startLine, finding.endLine, finding.ruleId);
    if (!source || !snippet || !intersectsChangedLines(finding.startLine, finding.endLine, source.changedRanges)) {
      validated.push({
        ...finding,
        evidence: [],
        verification: "unverified",
        disposition: "rejected",
        validationMessage: !source || !snippet
          ? "The finding location could not be matched to the pinned source."
          : "The finding location does not overlap changed lines in the pinned diff.",
        fingerprint: createFingerprint(finding, repositoryId, hmacKey, fingerprintVersion),
        fingerprintVersion
      });
      rejectedCount += 1;
      continue;
    }

    if (finding.provenance === "ai") {
      const candidateText = String(finding.evidenceText || "").trim();
      const sourceText = source.content.split(/\r?\n/).slice(finding.startLine - 1, finding.endLine).join("\n").trim();
      const normalizedCandidate = candidateText.replace(/\s+/g, " ").trim();
      const normalizedSource = sourceText.replace(/\s+/g, " ").trim();
      if (!normalizedCandidate || !normalizedSource.includes(normalizedCandidate)) {
        validated.push({
          ...finding,
          evidence: [],
          verification: "unverified",
          disposition: "rejected",
          validationMessage: "The supplied evidence does not match the pinned source.",
          fingerprint: createFingerprint(finding, repositoryId, hmacKey, fingerprintVersion),
          fingerprintVersion
        });
        rejectedCount += 1;
        continue;
      }
    }

    const verification = finding.provenance === "deterministic" ? "rule_checked" : "evidence_checked";
    validated.push({
      ...finding,
      fingerprint: createFingerprint(finding, repositoryId, hmacKey, fingerprintVersion),
      fingerprintVersion,
      evidence: [{
        path: finding.path,
        side: finding.side || "head",
        startLine: finding.startLine,
        endLine: finding.endLine,
        snippet,
        contentHash: source.contentHash
      }],
      verification,
      disposition: "accepted",
      validationMessage: null
    });
  }
  return { findings: validated, rejectedCount };
}

module.exports = { createFingerprint, redactEvidenceLine, redactSourceText, sourceSnippet, validateFindings };
