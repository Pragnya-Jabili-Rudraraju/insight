const { analyzeFiles } = require("../src/analysis/structural-analyzer");
const { parseSource } = require("../src/analysis/babel-parser");

describe("bounded Babel analysis", () => {
  test.each([
    ["component.jsx", "export default function Card() { return <div />; }"],
    ["types.ts", "export function load(id: string): number { return Number(id); }"],
    ["view.tsx", "type Props = { name: string }; export const View = ({ name }: Props) => <p>{name}</p>;"],
    ["module.js", "export const ready = true;"]
  ])("parses supported source: %s", (filePath, source) => {
    expect(parseSource(filePath, source).ast).toBeTruthy();
  });

  test("reports parser diagnostics without throwing or exposing source text", () => {
    const result = analyzeFiles([{ path: "src/broken.js", headContent: "const x = ;" }]);
    expect(result.findings[0].ruleId).toBe("JS001");
    expect(result.findings[0].evidence).toContain("Parser reported");
    expect(result.findings[0].verification).toBe("unverified");
  });

  test("detects dynamic execution and unsafe TLS cautiously", () => {
    const result = analyzeFiles([{
      path: "src/risky.js",
      headContent: "eval(input); new Function('return 1'); process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';"
    }]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["SEC001", "SEC001", "SEC003"]);
    expect(result.findings.every((finding) => finding.provenance === "deterministic")).toBe(true);
    expect(result.findings.every((finding) => !finding.explanation.includes("proves exploitability"))).toBe(true);
  });

  test("redacts possible credential values from findings", () => {
    const secret = "sk_live_abc1234567890";
    const result = analyzeFiles([{
      path: "src/config.js",
      headContent: `const apiKey = "${secret}";`
    }]);
    expect(result.findings).toHaveLength(1);
    expect(JSON.stringify(result.findings)).not.toContain(secret);
    expect(result.findings[0].evidence).toContain("withheld");
  });

  test("detects removed exports and changed public signatures", () => {
    const result = analyzeFiles([{
      path: "src/service.js",
      baseContent: "export function getItem(id) { return id; }\nexport const oldName = 1;",
      headContent: "export function getItem(id, options) { return id; }",
      changedHeadLineRanges: [{ startLine: 1, endLine: 1 }],
      changedBaseLineRanges: [{ startLine: 1, endLine: 2 }]
    }]);
    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual(["API001", "API002"]);
  });

  test("skips oversized and unsafe paths explicitly", () => {
    const result = analyzeFiles([
      { path: "src/large.js", headContent: "x".repeat(20), baseContent: null },
      { path: "../../outside.js", headContent: "const a = 1;" }
    ], { maxFileBytes: 10 });
    expect(result.skipped.map((item) => item.reason).sort()).toEqual(["file_limit_exceeded", "unsafe_path"]);
  });
});
