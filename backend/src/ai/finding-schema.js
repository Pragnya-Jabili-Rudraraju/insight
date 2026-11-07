const { z } = require("zod");

const categoryValues = ["correctness", "security", "breaking-change", "reliability", "performance", "maintainability"];
const severityValues = ["critical", "high", "medium", "low", "info"];
const confidenceValues = ["low", "medium", "high"];

const aiFindingSchema = z.object({
  category: z.enum(categoryValues),
  severity: z.enum(severityValues),
  title: z.string().min(1).max(180),
  explanation: z.string().min(1).max(1500),
  path: z.string().min(1).max(500),
  side: z.enum(["base", "head"]),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  evidenceText: z.string().min(1).max(1000),
  suggestedImprovement: z.string().min(1).max(1500),
  confidence: z.enum(confidenceValues),
  testGuidance: z.string().max(1500),
  symbol: z.string().max(200).nullable()
}).strict();

const aiResultSchema = z.object({ findings: z.array(aiFindingSchema).max(20) }).strict();

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "severity", "title", "explanation", "path", "side", "startLine", "endLine", "evidenceText", "suggestedImprovement", "confidence", "testGuidance", "symbol"],
        properties: {
          category: { type: "string", enum: categoryValues },
          severity: { type: "string", enum: severityValues },
          title: { type: "string" },
          explanation: { type: "string" },
          path: { type: "string" },
          side: { type: "string", enum: ["base", "head"] },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          evidenceText: { type: "string" },
          suggestedImprovement: { type: "string" },
          confidence: { type: "string", enum: confidenceValues },
          testGuidance: { type: "string" },
          symbol: { type: ["string", "null"] }
        }
      }
    }
  }
};

module.exports = { aiFindingSchema, aiResultSchema, jsonSchema };
