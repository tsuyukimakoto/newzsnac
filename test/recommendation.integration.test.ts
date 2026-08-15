import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { EnrichmentWorker } from "../src/enrichment/service.js";
import { LmStudioClient } from "../src/enrichment/client.js";
import { ReadingService } from "../src/reading/service.js";
import { createApplicationOperations } from "../src/application/operations.js";
import {
  blobToVector, buildEmbeddingInput, cosineSimilarity, RecommendationService,
  vectorNorm, vectorToBlob,
} from "../src/recommendation/service.js";

function insertItem(database: ReturnType<typeof openDatabase>, id: number, title: string): void {
  const now = "2026-08-15T00:00:00Z";
  database.prepare(`
    INSERT INTO items(id, canonical_url, title, published_at, discovered_at, feed_content,
      extraction_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
  `).run(id, `https://example.com/${id}`, title, now, now, `${title} details`, now, now);
}

test("embedding input, BLOB storage, compatibility, and cosine similarity are deterministic", () => {
  const first = buildEmbeddingInput({ title: "e\u0301", summary: " summary ", content: "body" }, 40);
  const second = buildEmbeddingInput({ title: "é", summary: " summary ", content: "body" }, 40);
  assert.equal(first.text, second.text);
  assert.equal(first.hash, second.hash);
  assert.equal(buildEmbeddingInput({ title: "Title" }, 1_000).text, "TITLE:\nTitle");

  const values = new Float32Array([0.6, 0.8]);
  assert.deepEqual([...blobToVector(vectorToBlob(values), 2)], [...values]);
  assert.ok(Math.abs(vectorNorm(values) - 1) < 1e-6);
  const embedding = { itemId: 1, modelId: "model", inputVersion: "v1", values, norm: vectorNorm(values) };
  assert.ok(Math.abs(cosineSimilarity(embedding, embedding) - 1) < 1e-6);
  assert.throws(() => blobToVector(vectorToBlob(values), 3), /dimensions/);
  assert.throws(() => vectorNorm(new Float32Array([0, 0])), /positive/);
  assert.throws(() => cosineSimilarity(embedding, { ...embedding, modelId: "other" }), /compatible/);
});

test("LM Studio embeddings client validates HTTP errors and vectors", async () => {
  const endpoint = new URL("http://127.0.0.1:1234/v1");
  const ok = new LmStudioClient(endpoint, async () => Response.json({ data: [{ embedding: [1, 0.5] }] }));
  assert.deepEqual([...await ok.embed("embed", "text")], [1, 0.5]);
  const invalid = new LmStudioClient(endpoint, async () => Response.json({ data: [{ embedding: [1, "bad"] }] }));
  await assert.rejects(() => invalid.embed("embed", "text"), /finite embedding/);
  const failed = new LmStudioClient(endpoint, async () => new Response("model missing", { status: 404 }));
  await assert.rejects(() => failed.embed("embed", "text"), /404: model missing/);
});

test("explicit interest incrementally creates and removes explainable recommendations", async () => {
  const database = openDatabase(":memory:");
  try {
    insertItem(database, 1, "Local AI architecture");
    insertItem(database, 2, "Local AI implementation");
    insertItem(database, 3, "Cooking recipe");
    const config = loadConfig({
      NEWSZNAC_DATABASE_PATH: ":memory:", NEWSZNAC_EMBEDDING_MODEL: "embed-model",
      NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD: "0.8",
    });
    const recommendations = new RecommendationService(database, config);
    const reading = new ReadingService(database, "embed-model", config.embeddingInputVersion,
      config.recommendationSimilarityThreshold);
    const client = new LmStudioClient(config.lmStudioUrl, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      const vector = body.input.includes("Cooking") ? [0, 1] : body.input.includes("implementation") ? [0.98, 0.2] : [1, 0];
      return Response.json({ data: [{ embedding: vector }] });
    });

    for (const id of [1, 2, 3]) recommendations.ensureEmbeddingQueued(id);
    reading.setSaved(1, true);
    reading.setRead(1, true);
    reading.setInterest(1, "interested");
    recommendations.onInterestChanged(1, "interested");
    const worker = new EnrichmentWorker(database, client, "recommendation-test", recommendations);
    while (await worker.runOne("qwen", "v1", new Date("2026-08-16T01:00:00Z"))) { /* drain */ }

    const recommended = reading.list({ recommended: true });
    assert.deepEqual(recommended.map((item) => item.id), [2]);
    assert.equal(recommended[0]?.recommendation?.sourceItemId, 1);
    assert.equal(recommended[0]?.recommendation?.sourceTitle, "Local AI architecture");
    assert.ok((recommended[0]?.recommendation?.score ?? 0) > 0.9);
    assert.equal(database.prepare("SELECT count(*) AS count FROM item_recommendations").get()?.count, 2);
    assert.equal(database.prepare("SELECT score FROM item_recommendations WHERE target_item_id = 3").get()?.score, 0);
    assert.equal(reading.list({ interested: true })[0]?.id, 1);

    reading.setInterest(1, null);
    recommendations.onInterestChanged(1, null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM item_recommendations").get()?.count, 0);
    while (await worker.runOne("qwen", "v1", new Date("2026-08-16T02:00:00Z"))) { /* drain */ }
    assert.equal(reading.list({ recommended: true }).length, 0);
    const source = reading.list().find((item) => item.id === 1);
    assert.equal(source?.isSaved, true);
    assert.equal(source?.isRead, true);
    assert.equal(source?.interest, null);
  } finally { database.close(); }
});

test("reading and dashboard apply the current threshold to persisted recommendations", async () => {
  const database = openDatabase(":memory:");
  try {
    for (let id = 1; id <= 6; id += 1) insertItem(database, id, `Article ${id}`);
    const now = "2026-08-15T00:00:00Z";
    database.prepare("INSERT INTO item_user_states(item_id, interest, updated_at) VALUES (1, 'interested', ?)").run(now);
    const insertRecommendation = database.prepare(`
      INSERT INTO item_recommendations(target_item_id, source_item_id, score, model_id, input_version, calculated_at)
      VALUES (?, 1, ?, 'embed-model', 'embedding-v1', ?)
    `);
    const savedRecommendations: ReadonlyArray<readonly [number, number]> =
      [[2, 0.9], [3, 0.88], [4, 0.87], [5, 0.86], [6, 0.85]];
    savedRecommendations.forEach(([id, score]) =>
      insertRecommendation.run(id, score, now));
    const config = loadConfig({
      NEWSZNAC_EMBEDDING_MODEL: "embed-model",
      NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD: "0.86",
    });
    const reading = new ReadingService(database, "embed-model", "embedding-v1",
      config.recommendationSimilarityThreshold);
    assert.deepEqual(reading.list({ recommended: true }).map((item) => item.id), [2, 3, 4, 5]);
    assert.deepEqual(reading.list().filter((item) => item.recommendation).map((item) => item.id).sort(), [2, 3, 4, 5]);

    const fetcher = async (input: string | URL | Request) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "embed-model" }] });
      throw new Error(`unexpected request: ${String(input)}`);
    };
    const operations = createApplicationOperations(database, config, fetcher);
    const summary = await operations.execute("dashboard.summary", {}, "web");
    assert.equal(summary.ok && (summary.data as { recommended: number }).recommended, 4);
    const runtime = await operations.execute("runtime.status", {}, "web");
    assert.equal(runtime.ok && (runtime.data as { embedding: { recommendations: number } }).embedding.recommendations, 4);
  } finally { database.close(); }
});

test("embedding failures remain retryable without blocking interest updates", async () => {
  const database = openDatabase(":memory:");
  try {
    insertItem(database, 1, "Offline embeddings");
    const config = loadConfig({ NEWSZNAC_EMBEDDING_MODEL: "embed-model" });
    const recommendations = new RecommendationService(database, config);
    recommendations.ensureEmbeddingQueued(1);
    const client = new LmStudioClient(config.lmStudioUrl, async () => { throw new Error("offline"); });
    await new EnrichmentWorker(database, client, "offline-embedding", recommendations)
      .runOne("qwen", "v1", new Date("2026-08-16T00:00:00Z"));
    assert.equal(database.prepare("SELECT status FROM jobs WHERE type = 'embedding'").get()?.status, "retry_wait");
    const reading = new ReadingService(database);
    reading.setInterest(1, "interested");
    assert.equal(reading.list()[0]?.interest, "interested");
  } finally { database.close(); }
});
