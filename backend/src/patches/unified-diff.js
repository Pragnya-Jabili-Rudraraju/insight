function createUnifiedDiff(filePath, startLine, originalCode, proposedCode) {
  const original = String(originalCode).split(/\r?\n/);
  const proposed = String(proposedCode).split(/\r?\n/);
  if (originalCode === proposedCode) return "";
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${startLine},${original.length} +${startLine},${proposed.length} @@`,
    ...original.map((line) => `-${line}`),
    ...proposed.map((line) => `+${line}`)
  ];
  return lines.join("\n");
}

function applyReplacement(source, startLine, endLine, replacement) {
  const lines = String(source).split(/\r?\n/);
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  const replacementLines = String(replacement).split(/\r?\n/);
  return [...lines.slice(0, startLine - 1), ...replacementLines, ...lines.slice(endLine)].join("\n");
}

module.exports = { applyReplacement, createUnifiedDiff };
