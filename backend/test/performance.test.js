const { performance } = require("node:perf_hooks");
const { analyzeFiles } = require("../src/analysis/structural-analyzer");

describe("maximum configured parser input", () => {
  test("parses the full 20 MiB repository-source budget inside the 60-second budget", () => {
    const declarations = Array.from({ length: 1000 }, (_, index) => `const value${index} = ${index};`).join("\n") + "\n";
    const fileSizes = [...Array(40).fill(500 * 1024), 480 * 1024];
    const files = fileSizes.map((fileBytes, index) => {
      const paddingBytes = fileBytes - Buffer.byteLength(declarations) - 5;
      const source = `${declarations}\n/*${"x".repeat(paddingBytes)}*/`;
      expect(Buffer.byteLength(source)).toBe(fileBytes);
      return {
        path: `src/perf-${index}.js`,
        headContent: source,
        changedHeadLineRanges: [{ startLine: 1, endLine: 1000 }]
      };
    });

    const startedAt = performance.now();
    const result = analyzeFiles(files, { maxFileBytes: 500 * 1024 });
    const elapsedMs = performance.now() - startedAt;

    expect(files.reduce((total, file) => total + Buffer.byteLength(file.headContent), 0)).toBe(20 * 1024 * 1024);
    expect(result.skipped).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(60_000);
    process.stdout.write(`\nMaximum parser fixture: ${files.length} files, 20 MiB, ${Math.round(elapsedMs)} ms\n`);
  }, 65_000);
});
