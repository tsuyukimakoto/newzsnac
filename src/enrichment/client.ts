import type { Fetch } from "../sources/resolver.js";
import { analysisJsonSchema, validateAnalysis, type AnalysisResult } from "./schema.js";

export interface ChatCompletionMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

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
        max_tokens: 1_200,
        stream: false,
        messages: [{ role: "user", content: `次の記事を日本語で分析してください。\nタイトル: ${title}\n本文:\n${content}` }],
        response_format: { type: "json_schema", json_schema: { name: "article_analysis", strict: true, schema: analysisJsonSchema } },
      }),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
    const message = body.choices?.[0]?.message;
    const contentJson = message?.content || message?.reasoning_content || message?.reasoning;
    if (!contentJson) throw new Error("LM Studio response did not contain structured content");
    let parsed: unknown;
    try { parsed = JSON.parse(contentJson); } catch { throw new Error(`LM Studio returned invalid JSON: ${contentJson.slice(0, 300)}`); }
    return validateAnalysis(parsed);
  }

  async translate(model: string, content: string): Promise<string> {
    const url = new URL(`${this.endpoint.pathname.replace(/\/$/, "")}/chat/completions`, this.endpoint);
    const response = await this.fetcher(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: `次の全文を日本語へ翻訳してください。\n${content}` }] }),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const translated = body.choices?.[0]?.message?.content;
    if (!translated) throw new Error("LM Studio response did not contain a translation");
    return translated;
  }

  async chat(model: string, messages: readonly ChatCompletionMessage[]): Promise<string> {
    const url = new URL(`${this.endpoint.pathname.replace(/\/$/, "")}/chat/completions`, this.endpoint);
    const response = await this.fetcher(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: 4_096, stream: false, messages }),
    });
    if (!response.ok) throw new Error(`LM Studio chat returned HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
    const body = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
    const choice = body.choices?.[0];
    const answer = choice?.message?.content?.trim();
    if (!answer && choice?.finish_reason === "length") throw new Error("LM Studio ran out of output tokens before producing an answer");
    if (!answer) throw new Error("LM Studio response did not contain an answer");
    return answer;
  }

  async embed(model: string, input: string): Promise<Float32Array> {
    const url = new URL(`${this.endpoint.pathname.replace(/\/$/, "")}/embeddings`, this.endpoint);
    const response = await this.fetcher(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
    if (!response.ok) throw new Error(`LM Studio embeddings returned HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
    const body = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const value = body.data?.[0]?.embedding;
    if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      throw new Error("LM Studio response did not contain a finite embedding vector");
    }
    const vector = Float32Array.from(value as number[]);
    if (![...vector].every(Number.isFinite)) throw new Error("LM Studio embedding exceeds Float32 range");
    return vector;
  }
}
