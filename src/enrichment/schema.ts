export const analysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summaryJa", "labels", "priority", "keyPoints", "itemType", "originalLanguage"],
  properties: {
    summaryJa: { type: "string", minLength: 1 },
    labels: { type: "array", maxItems: 5, items: { type: "string", minLength: 1 } },
    priority: { type: "integer", minimum: 0, maximum: 100 },
    keyPoints: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "detail"],
        properties: {
          headline: { type: "string", minLength: 1 },
          detail: { type: "string", minLength: 1 },
        },
      },
    },
    itemType: { type: "string", enum: ["article", "discussion", "release", "other"] },
    originalLanguage: { type: "string", minLength: 2 },
  },
} as const;

export interface AnalysisResult {
  readonly summaryJa: string;
  readonly labels: readonly string[];
  readonly priority: number;
  readonly keyPoints: readonly KeyPoint[];
  readonly itemType: "article" | "discussion" | "release" | "other";
  readonly originalLanguage: string;
}

export interface KeyPoint {
  readonly headline: string;
  readonly detail: string;
}

function isGeneratedKeyPoint(value: unknown): value is KeyPoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return Object.keys(point).length === 2 &&
    typeof point.headline === "string" && Boolean(point.headline.trim()) &&
    typeof point.detail === "string" && Boolean(point.detail.trim());
}

export function validateAnalysis(value: unknown): AnalysisResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("analysis must be an object");
  const data = value as Record<string, unknown>;
  const allowed = new Set(["summaryJa", "labels", "priority", "keyPoints", "itemType", "originalLanguage"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) throw new Error("analysis has unknown properties");
  if (typeof data.summaryJa !== "string" || !data.summaryJa.trim()) throw new Error("summaryJa is required");
  if (!Array.isArray(data.labels) || data.labels.length > 5 || data.labels.some((label) => typeof label !== "string" || !label)) throw new Error("labels are invalid");
  if (!Number.isInteger(data.priority) || (data.priority as number) < 0 || (data.priority as number) > 100) throw new Error("priority is outside 0..100");
  if (!Array.isArray(data.keyPoints) || data.keyPoints.length > 3 || data.keyPoints.some((point) => !isGeneratedKeyPoint(point))) throw new Error("keyPoints are invalid");
  if (!["article", "discussion", "release", "other"].includes(String(data.itemType))) throw new Error("itemType is invalid");
  if (typeof data.originalLanguage !== "string" || data.originalLanguage.length < 2) throw new Error("originalLanguage is invalid");
  return data as unknown as AnalysisResult;
}
