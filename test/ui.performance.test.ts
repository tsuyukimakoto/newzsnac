import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { moveSelection } from "../src/web/navigation.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { ReadingService } from "../src/reading/service.js";
import { RecommendationService, vectorToBlob } from "../src/recommendation/service.js";

test("100 keyboard moves across 10,000 items stay below 50ms at p95", () => {
  const durations: number[] = [];
  let selected = 0;
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    selected = moveSelection(selected, 1, 10_000);
    durations.push(performance.now() - startedAt);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
  assert.equal(selected, 100);
  assert.ok(p95 < 50, `selection update p95 was ${p95.toFixed(3)}ms`);
});

test("incremental recommendation and a recommended view stay below 50ms with 10,000 items", () => {
  const database = openDatabase(":memory:");
  try {
    const now = "2026-08-15T00:00:00Z";
    const insertItem = database.prepare(`
      INSERT INTO items(id, canonical_url, title, published_at, discovered_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec("BEGIN");
    for (let id = 1; id <= 10_000; id += 1) insertItem.run(id, `https://example.com/${id}`, `Article ${id}`, now, now, now, now);
    const insertState = database.prepare("INSERT INTO item_user_states(item_id, interest, updated_at) VALUES (?, 'interested', ?)");
    const insertEmbedding = database.prepare(`
      INSERT INTO item_embeddings(item_id, model_id, input_version, input_hash, dimensions, vector, l2_norm, embedded_at)
      VALUES (?, 'embed-model', 'embedding-v1', ?, 2, ?, 1, ?)
    `);
    const vector = vectorToBlob(new Float32Array([1, 0]));
    for (let id = 1; id <= 20; id += 1) {
      insertState.run(id, now);
      insertEmbedding.run(id, `hash-${id}`, vector, now);
    }
    insertEmbedding.run(10_000, "hash-10000", vector, now);
    database.exec("COMMIT");

    const config = loadConfig({ NEWSZNAC_EMBEDDING_MODEL: "embed-model" });
    const recommendations = new RecommendationService(database, config);
    const startedRecommendation = performance.now();
    recommendations.processRecommendationJob({ id: 1, type: "recommendation", itemId: 10_000, sourceId: null,
      payload: { targetItemId: 10_000 }, attempts: 1, maxAttempts: 5 });
    const recommendationDuration = performance.now() - startedRecommendation;

    const reading = new ReadingService(database, "embed-model", "embedding-v1");
    const startedList = performance.now();
    const result = reading.list({ recommended: true });
    const listDuration = performance.now() - startedList;
    assert.equal(result[0]?.id, 10_000);
    assert.ok(recommendationDuration < 50, `incremental recommendation took ${recommendationDuration.toFixed(3)}ms`);
    assert.ok(listDuration < 50, `recommended list took ${listDuration.toFixed(3)}ms`);
  } finally { database.close(); }
});
