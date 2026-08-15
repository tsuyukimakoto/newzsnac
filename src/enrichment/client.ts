import type { Fetch } from "../sources/resolver.js";
import { analysisJsonSchema, validateAnalysis, type AnalysisResult } from "./schema.js";

export class LmStudioClient {
  constructor(
    private readonly endpoint: URL,
    private readonly fetcher: Fetch = globalThis.fetch,
  ) {}

  async analyze(model: string, title: string, content: string): Promise<AnalysisResult> {
    const url = new URL(`${this.endpoint.pathname.replace(/\/$/, "")}/chat/completions`, this.endpoint);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "user", content: `次の記事を日本語で分析してください。\nタイトル: ${title}\n本文:\n${content}` }],
        response_format: { type: "json_schema", json_schema: { name: "article_analysis", strict: true, schema: analysisJsonSchema } },
      }),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const contentJson = body.choices?.[0]?.message?.content;
    if (!contentJson) throw new Error("LM Studio response did not contain structured content");
    let parsed: unknown;
    try { parsed = JSON.parse(contentJson); } catch { throw new Error("LM Studio returned invalid JSON"); }
    return validateAnalysis(parsed);
  }

  async translate(model: string, content: string): Promise<string> {
    const url = new URL(`${this.endpoint.pathname.replace(/\/$/, "")}/chat/completions`, this.endpoint);
    const response = await this.fetcher(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: `次の全文を日本語へ翻訳してください。\n${content}` }] }),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const translated = body.choices?.[0]?.message?.content;
    if (!translated) throw new Error("LM Studio response did not contain a translation");
    return translated;
  }
}
