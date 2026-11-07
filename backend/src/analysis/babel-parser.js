const babelParser = require("@babel/parser");

const MAX_PARSED_FILE_BYTES = 500 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

function extensionFor(filePath) {
  const lastDot = filePath.lastIndexOf(".");
  return lastDot < 0 ? "" : filePath.slice(lastDot).toLowerCase();
}

function parseSource(filePath, source, maxBytes = MAX_PARSED_FILE_BYTES) {
  const extension = extensionFor(filePath);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return { ast: null, error: { code: "UNSUPPORTED_FILE_TYPE", message: "File type is not supported." } };
  }
  if (Buffer.byteLength(source, "utf8") > maxBytes) {
    return { ast: null, error: { code: "FILE_LIMIT_EXCEEDED", message: "File exceeds the parser size limit." } };
  }

  const plugins = [];
  if (extension === ".jsx" || extension === ".js" || extension === ".tsx") plugins.push("jsx");
  if (extension === ".ts" || extension === ".tsx") plugins.push("typescript");

  try {
    const ast = babelParser.parse(source, {
      sourceType: "unambiguous",
      sourceFilename: filePath,
      errorRecovery: false,
      allowAwaitOutsideFunction: false,
      plugins
    });
    return { ast, error: null };
  } catch (error) {
    return {
      ast: null,
      error: {
        code: "PARSE_ERROR",
        message: "Source could not be parsed.",
        line: error.loc?.line || null,
        column: error.loc ? error.loc.column + 1 : null
      }
    };
  }
}

module.exports = { MAX_PARSED_FILE_BYTES, SUPPORTED_EXTENSIONS, parseSource };
