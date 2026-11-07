const { createHash } = require("node:crypto");
const path = require("node:path");
const { parseSource, MAX_PARSED_FILE_BYTES } = require("./babel-parser");
const { ANALYZER_VERSION, RULES } = require("./rule-catalog");
const { conceptForRule } = require("../concepts/concept-catalog");

const SECRET_NAME = /(secret|token|password|api[_-]?key|private[_-]?key)/i;
const PLACEHOLDER = /^(?:change.?me|example|placeholder|your[_-]|test[_-]?only|dummy|none|null)$/i;

function isNode(value) {
  return value && typeof value === "object" && typeof value.type === "string";
}

function visit(node, callback) {
  if (!isNode(node)) return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => visit(item, callback));
    else visit(value, callback);
  }
}

function fingerprint(ruleId, filePath, symbol, normalizedEvidence) {
  const canonical = [ruleId, filePath.replaceAll("\\", "/"), symbol || "", normalizedEvidence]
    .join("\u0000")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(canonical).digest("hex");
}

function testGuidanceFor(ruleId) {
  const guidance = {
    JS001: "Run the affected parser, lint, build, or tests and confirm the syntax error is resolved.",
    SEC001: "Exercise the code with untrusted input and confirm it is handled as data rather than executable code.",
    SEC002: "Confirm the credential comes from a secret store and is not exposed in output or logs; rotate it if real.",
    SEC003: "Test a connection with an invalid certificate and confirm the client rejects it.",
    API001: "Search for callers of the removed export and test the affected import paths.",
    API002: "Run tests for callers using the old and new parameter shapes."
  };
  return guidance[ruleId] || "Add or update a regression test for the affected behavior.";
}

function makeFinding(rule, filePath, node, title, explanation, normalizedEvidence, extra = {}) {
  const line = node.loc?.start.line || 1;
  return {
    ruleId: rule.id,
    category: rule.category,
    severity: rule.severity,
    title,
    explanation,
    path: filePath,
    side: "head",
    startLine: line,
    endLine: node.loc?.end.line || line,
    evidence: extra.evidence || `Matched ${rule.id} at this location.`,
    suggestedImprovement: extra.suggestedImprovement || "Review this change in its project context.",
    testGuidance: extra.testGuidance || testGuidanceFor(rule.id),
    conceptId: conceptForRule[rule.id] || null,
    confidence: extra.confidence || "medium",
    provenance: "deterministic",
    verification: "unverified",
    disposition: "candidate",
    fingerprint: fingerprint(rule.id, filePath, extra.symbol, normalizedEvidence),
    fingerprintEvidence: normalizedEvidence,
    ...extra
  };
}

function stringValue(node) {
  return node && (node.type === "StringLiteral" || node.type === "Literal") && typeof node.value === "string"
    ? node.value
    : null;
}

function isPlaceholder(value) {
  return !value || value.length < 8 || PLACEHOLDER.test(value) || /^(?:\*+|x+)$/i.test(value);
}

function inspectAst(filePath, ast) {
  const findings = [];
  visit(ast, (node) => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "eval") {
      findings.push(makeFinding(
        RULES.DYNAMIC_CODE, filePath, node, "Dynamic code execution pattern",
        "This code calls eval. Dynamic execution can turn untrusted text into code; this pattern alone does not prove exploitability.",
        "call:eval", { symbol: "eval", confidence: "medium", suggestedImprovement: "Avoid eval; use an explicit parser or a fixed lookup when possible." }
      ));
    }
    if (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Function") {
      findings.push(makeFinding(
        RULES.DYNAMIC_CODE, filePath, node, "Dynamic function construction",
        "This code creates a function from strings. If those strings can contain untrusted input, they may be executed as code.",
        "new:Function", { symbol: "Function", confidence: "medium", suggestedImprovement: "Replace string-based function construction with ordinary, explicit functions." }
      ));
    }

    const secretIdentifier = node.type === "AssignmentExpression" && node.left?.type === "Identifier"
      ? node.left
      : node.type === "VariableDeclarator" && node.id?.type === "Identifier"
        ? node.id
        : null;
    if (secretIdentifier && SECRET_NAME.test(secretIdentifier.name)) {
      const secretValue = node.type === "VariableDeclarator" ? node.init : node.right;
      const value = stringValue(secretValue);
      if (value && !isPlaceholder(value)) {
        findings.push(makeFinding(
          RULES.HARDCODED_SECRET, filePath, node, "Possible hardcoded secret",
          "A string value is assigned to a variable whose name commonly holds a credential. This heuristic can be a false positive; the value is redacted.",
          `assignment:${secretIdentifier.name.toLowerCase()}:string`, {
            symbol: secretIdentifier.name,
            confidence: "low",
            evidence: `Possible credential assigned to ${secretIdentifier.name}; value withheld.`,
            suggestedImprovement: "Move credentials to a managed secret store and rotate the value if it is real."
          }
        ));
      }
    }
    if (node.type === "ObjectProperty") {
      const key = node.key?.name || stringValue(node.key);
      const value = stringValue(node.value);
      if (typeof key === "string" && SECRET_NAME.test(key) && value && !isPlaceholder(value)) {
        findings.push(makeFinding(
          RULES.HARDCODED_SECRET, filePath, node, "Possible hardcoded secret",
          "A string value is stored under a key commonly used for credentials. This heuristic can be a false positive; the value is redacted.",
          `property:${key.toLowerCase()}:string`, {
            symbol: key,
            confidence: "low",
            evidence: `Possible credential stored under ${key}; value withheld.`,
            suggestedImprovement: "Move credentials to a managed secret store and rotate the value if it is real."
          }
        ));
      }
      if (key === "rejectUnauthorized" && node.value?.type === "BooleanLiteral" && node.value.value === false) {
        findings.push(makeFinding(
          RULES.UNSAFE_TLS, filePath, node, "TLS certificate checks are disabled",
          "This configuration disables certificate verification, which can make a connection vulnerable to interception. Confirm whether this is restricted to a test environment.",
          "tls:rejectUnauthorized:false", { symbol: "rejectUnauthorized", confidence: "medium", suggestedImprovement: "Keep certificate verification enabled outside tightly controlled tests." }
        ));
      }
    }
    const tlsSetting = node.type === "AssignmentExpression" && node.left?.type === "MemberExpression"
      ? node.left
      : null;
    const envObject = tlsSetting?.object;
    if (tlsSetting && envObject?.type === "MemberExpression" && envObject.object?.name === "process" &&
        envObject.property?.name === "env" && tlsSetting.computed &&
        stringValue(tlsSetting.property) === "NODE_TLS_REJECT_UNAUTHORIZED" && stringValue(node.right) === "0") {
      findings.push(makeFinding(
        RULES.UNSAFE_TLS, filePath, node, "TLS certificate checks are disabled",
        "This assignment disables Node.js TLS certificate verification for the process. The pattern does not show whether it is reachable in production.",
        "tls:node_tls_reject_unauthorized:0", { symbol: "NODE_TLS_REJECT_UNAUTHORIZED", confidence: "medium" }
      ));
    }
  });
  return findings;
}

function parameterShape(params) {
  return params.map((param) => {
    if (param.type === "Identifier") return param.name;
    if (param.type === "AssignmentPattern") return `${parameterShape([param.left])[0]}?`;
    if (param.type === "RestElement") return `...${parameterShape([param.argument])[0]}`;
    if (param.type === "ObjectPattern") return "{…}";
    if (param.type === "ArrayPattern") return "[…]";
    return "?";
  });
}

function exportedApi(ast) {
  const symbols = new Map();
  const imports = [];
  for (const statement of ast.program.body) {
    if (statement.type === "ImportDeclaration") {
      imports.push({ source: statement.source.value, names: statement.specifiers.map((s) => s.imported?.name || "default") });
    }
    let declaration = null;
    if (statement.type === "ExportNamedDeclaration") declaration = statement.declaration;
    if (statement.type === "ExportDefaultDeclaration") declaration = statement.declaration;
    if (statement.type === "ExportNamedDeclaration" && !declaration) {
      for (const specifier of statement.specifiers) {
        symbols.set(specifier.exported.name, { node: specifier, signature: null });
      }
    }
    if (!declaration) continue;

    if (declaration.type === "FunctionDeclaration") {
      symbols.set(declaration.id?.name || "default", { node: declaration, signature: parameterShape(declaration.params) });
    } else if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        const init = item.init;
        const params = init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression" ? init.params : null;
        symbols.set(item.id.name, { node: item, signature: params ? parameterShape(params) : null });
      }
    } else {
      symbols.set("default", { node: declaration, signature: null });
    }
  }
  return { symbols, imports };
}

function inChangedRange(line, ranges) {
  return !ranges?.length || ranges.some((range) => line >= range.startLine && line <= range.endLine);
}

function analyzeFiles(files, options = {}) {
  const maxBytes = options.maxFileBytes || MAX_PARSED_FILE_BYTES;
  const findings = [];
  const artifacts = [];
  const skipped = [];

  for (const file of files) {
    const normalizedPath = path.posix.normalize(file.path.replaceAll("\\", "/"));
    if (normalizedPath.startsWith("../") || path.posix.isAbsolute(normalizedPath)) {
      skipped.push({ path: file.path, reason: "unsafe_path" });
      continue;
    }
    const parsedHead = parseSource(normalizedPath, file.headContent, maxBytes);
    if (parsedHead.error) {
      if (parsedHead.error.code === "FILE_LIMIT_EXCEEDED" || parsedHead.error.code === "UNSUPPORTED_FILE_TYPE") {
        skipped.push({ path: normalizedPath, reason: parsedHead.error.code.toLowerCase() });
      } else {
        const rule = RULES.PARSE_ERROR;
        if (!inChangedRange(parsedHead.error.line || 1, file.changedHeadLineRanges)) continue;
        const diagnostic = { loc: { start: { line: parsedHead.error.line || 1 }, end: { line: parsedHead.error.line || 1 } } };
        findings.push(makeFinding(rule, normalizedPath, diagnostic, "JavaScript syntax could not be parsed", parsedHead.error.message,
          `parse:${parsedHead.error.line || 0}:${parsedHead.error.column || 0}`, {
            confidence: "high", evidence: `Parser reported a syntax error at line ${parsedHead.error.line || "unknown"}.`,
            suggestedImprovement: "Check the syntax at this location and rerun the review."
          }));
      }
      continue;
    }

    const fileFindings = inspectAst(normalizedPath, parsedHead.ast).filter((finding) => inChangedRange(finding.startLine, file.changedHeadLineRanges));
    findings.push(...fileFindings);
    const headApi = exportedApi(parsedHead.ast);
    const artifact = {
      path: normalizedPath,
      imports: headApi.imports,
      exports: Array.from(headApi.symbols, ([name, value]) => ({ name, signature: value.signature })),
      structuralChanges: { importsAdded: [], importsRemoved: [], exportsAdded: [], exportsRemoved: [], signaturesChanged: [] }
    };
    artifacts.push(artifact);

    if (file.baseContent == null) continue;
    const parsedBase = parseSource(normalizedPath, file.baseContent, maxBytes);
    if (parsedBase.error) continue;
    const baseApi = exportedApi(parsedBase.ast);
    const importKey = (item) => `${item.source}\u0000${[...item.names].sort().join(",")}`;
    const headImportKeys = new Set(headApi.imports.map(importKey));
    const baseImportKeys = new Set(baseApi.imports.map(importKey));
    artifact.structuralChanges.importsAdded = headApi.imports.filter((item) => !baseImportKeys.has(importKey(item)));
    artifact.structuralChanges.importsRemoved = baseApi.imports.filter((item) => !headImportKeys.has(importKey(item)));
    artifact.structuralChanges.exportsAdded = [...headApi.symbols.keys()].filter((name) => !baseApi.symbols.has(name));
    artifact.structuralChanges.exportsRemoved = [...baseApi.symbols.keys()].filter((name) => !headApi.symbols.has(name));
    for (const [name, baseSymbol] of baseApi.symbols) {
      const headSymbol = headApi.symbols.get(name);
      if (!headSymbol) {
        const line = baseSymbol.node.loc?.start.line || 1;
        if (!file.changedBaseLineRanges?.length || inChangedRange(line, file.changedBaseLineRanges)) {
          findings.push(makeFinding(RULES.EXPORT_REMOVED, normalizedPath, baseSymbol.node, `Export removed: ${name}`,
            `The base revision exports ${name}, but the head revision does not. Callers may need an update.`, `removed-export:${name}`, {
              side: "base", symbol: name, confidence: "high", suggestedImprovement: "Check imports and callers before removing this public export."
            }));
        }
      } else if (baseSymbol.signature && headSymbol.signature && JSON.stringify(baseSymbol.signature) !== JSON.stringify(headSymbol.signature)) {
        artifact.structuralChanges.signaturesChanged.push({ name, from: baseSymbol.signature, to: headSymbol.signature });
        const line = headSymbol.node.loc?.start.line || 1;
        if (inChangedRange(line, file.changedHeadLineRanges)) {
          findings.push(makeFinding(RULES.SIGNATURE_CHANGED, normalizedPath, headSymbol.node, `Function signature changed: ${name}`,
            `The exported function parameters changed from (${baseSymbol.signature.join(", ")}) to (${headSymbol.signature.join(", ")}). Check its callers.`,
            `signature:${name}:${headSymbol.signature.join(",")}`, {
              symbol: name, confidence: "medium", suggestedImprovement: "Review callers and update tests for the new function contract."
            }));
        }
      }
    }
  }

  return { analyzerVersion: ANALYZER_VERSION, findings, artifacts, skipped };
}

module.exports = { analyzeFiles, exportedApi, fingerprint, inspectAst };
