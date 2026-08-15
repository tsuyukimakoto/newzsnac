import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { LmStudioClient } from "../src/enrichment/client.js";
import { EnrichmentService, EnrichmentWorker, deterministicPreScore } from "../src/enrichment/service.js";
import { analysisJsonSchema, validateAnalysis } from "../src/enrichment/schema.js";

function addItem(database: ReturnType<typeof openDatabase>): number {
  const timestamp = "2026-08-15T00:00:00.000Z";
  return Number(database.prepare(`
    INSERT INTO items(canonical_url, title, discovered_at, feed_content, extraction_status, created_at, updated_at)
    VALUES ('https://example.com/item', 'Local AI', ?, 'article body', 'available', ?, ?)
  `).run(timestamp, timestamp, timestamp).lastInsertRowid);
}

function response(content: unknown): Response {
  return Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
}

const valid = {
  summaryJa: "ローカルAIの記事", labels: ["AI"], priority: 82,
  reasons: ["関心分野"], itemType: "article", originalLanguage: "en",
};

test("analysis validates structured output, stores valid results, and orders deterministically", async () => {
  const database = openDatabase(":memory:");
  try {
    const itemId = addItem(database);
    const service = new EnrichmentService(database);
    assert.ok(deterministicPreScore(50, "2026-08-14T23:00:00Z", new Date("2026-08-15T00:00:00Z")) >
      deterministicPreScore(50, "2026-08-01T00:00:00Z", new Date("2026-08-15T00:00:00Z")));
    service.enqueueAnalysis(itemId, 50, "2026-08-14T23:00:00Z", new Date("2026-08-15T00:00:00Z"));
    const client = new LmStudioClient(new URL("http://127.0.0.1:1234/v1"), async () => response(valid));
    const worker = new EnrichmentWorker(database, client, "worker-a");
    assert.equal(await worker.runOne("qwen", "v1", new Date("2026-08-15T00:00:00Z")), true);
    const stored = database.prepare("SELECT summary_ja, priority FROM item_analyses WHERE item_id = ?").get(itemId);
    assert.equal(stored?.summary_ja, "ローカルAIの記事");
    assert.equal(stored?.priority, 82);
  } finally { database.close(); }
});

test("LM Studio compatibility omits unsupported schema keys and accepts separated reasoning content", async () => {
  assert.equal("uniqueItems" in analysisJsonSchema.properties.labels, false);
  const client = new LmStudioClient(new URL("http://127.0.0.1:1234/v1"), async () => Response.json({
    choices: [{ message: { content: "", reasoning_content: JSON.stringify(valid) } }],
  }));
  assert.deepEqual(await client.analyze("qwen", "Title", "Body"), valid);
});

test("LM Studio HTTP failures include the response detail", async () => {
  const client = new LmStudioClient(new URL("http://127.0.0.1:1234/v1"), async () => new Response(
    JSON.stringify({ error: "Unimplemented keys: uniqueItems" }), { status: 400 },
  ));
  await assert.rejects(() => client.analyze("qwen", "Title", "Body"), /Unimplemented keys: uniqueItems/);
});

test("invalid JSON, out-of-range values, and connection failure stay retryable and are not saved", async () => {
  assert.throws(() => validateAnalysis({ ...valid, priority: 101 }), /outside/);
  assert.throws(() => validateAnalysis({ ...valid, labels: ["1", "2", "3", "4", "5", "6"] }), /labels/);
  for (const fetcher of [
    async () => response("not-json"),
    async () => response({ ...valid, priority: 101 }),
    async () => { throw new Error("connection refused"); },
  ] as const) {
    const database = openDatabase(":memory:");
    try {
      const itemId = addItem(database);
      new EnrichmentService(database).enqueueAnalysis(itemId, 50, null, new Date("2026-08-15T00:00:00Z"));
      const client = new LmStudioClient(new URL("http://127.0.0.1:1234/v1"), fetcher);
      await new EnrichmentWorker(database, client, "worker").runOne("qwen", "v1", new Date("2026-08-15T00:00:00Z"));
      assert.equal(database.prepare("SELECT count(*) AS count FROM item_analyses").get()?.count, 0);
      assert.equal(database.prepare("SELECT status FROM jobs").get()?.status, "retry_wait");
    } finally { database.close(); }
  }
});

test("translation is queued on demand and reused by model and prompt version", async () => {
  const database = openDatabase(":memory:");
  try {
    const itemId = addItem(database);
    const service = new EnrichmentService(database);
    const queued = service.requestTranslation(itemId, "qwen", "translate-v1");
    assert.equal(queued.status, "queued");
    const client = new LmStudioClient(new URL("http://127.0.0.1:1234/v1"), async () => response("翻訳済み本文"));
    await new EnrichmentWorker(database, client, "worker").runOne("qwen", "v1");
    assert.deepEqual(service.requestTranslation(itemId, "qwen", "translate-v1"), { status: "ready", content: "翻訳済み本文" });
    assert.equal(database.prepare("SELECT count(*) AS count FROM jobs").get()?.count, 1);
  } finally { database.close(); }
});
