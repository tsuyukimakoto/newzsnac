import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplicationOperations } from "../src/application/operations.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import type { Fetch } from "../src/sources/resolver.js";

function insertItem(database: ReturnType<typeof openDatabase>, id: number, status: "available" | "failed", content: string | null): void {
  const timestamp = "2026-08-15T00:00:00.000Z";
  database.prepare(`
    INSERT INTO items(id, canonical_url, title, published_at, discovered_at, feed_content,
      extraction_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `https://example.com/${id}`, `Article ${id}`, timestamp, timestamp, content, status, timestamp, timestamp);
}

test("dashboard and operations separate ready, pending, and failed articles", async () => {
  const database = openDatabase(":memory:");
  try {
    insertItem(database, 1, "available", "ready body");
    insertItem(database, 2, "available", "pending body");
    insertItem(database, 3, "failed", null);
    database.prepare(`
      INSERT INTO item_analyses(item_id, kind, model_id, prompt_version, summary_ja,
        labels_json, priority, key_points_json, item_type, original_language, analyzed_at)
      VALUES (1, 'analysis', 'qwen', 'v1', 'Ready', '[]', 50, '[]', 'article', 'en', ?)
    `).run("2026-08-15T00:00:00.000Z");
    const operations = createApplicationOperations(database, loadConfig({}));

    const ready = await operations.execute("article.list", {}, "web");
    const pending = await operations.execute("article.list", { processingState: "pending" }, "web");
    const failed = await operations.execute("article.list", { processingState: "failed" }, "web");
    const summary = await operations.execute("dashboard.summary", {}, "web");
    assert.equal(ready.ok, true);
    assert.equal(pending.ok, true);
    assert.equal(failed.ok, true);
    assert.deepEqual((ready as { data: Array<{ id: number }> }).data.map((item) => item.id), [1]);
    assert.deepEqual((pending as { data: Array<{ id: number }> }).data.map((item) => item.id), [2]);
    assert.deepEqual((failed as { data: Array<{ id: number }> }).data.map((item) => item.id), [3]);
    assert.deepEqual(summary.ok ? summary.data : null, {
      total: 1, unread: 1, saved: 0, interested: 0, recommended: 0,
      pending: 1, failed: 1, readingMinutes: 5,
    });
    assert.equal((await operations.execute("article.list", { processingState: "unknown" }, "web")).ok, false);
  } finally { database.close(); }
});

test("failed article retry stores content and queues follow-up work once", async () => {
  const database = openDatabase(":memory:");
  try {
    insertItem(database, 1, "failed", null);
    let fetchCount = 0;
    const fetcher: Fetch = async () => {
      fetchCount += 1;
      return new Response("<main><h1>Recovered</h1><p>Useful article body.</p></main>");
    };
    const config = loadConfig({ NEWSZNAC_EMBEDDING_MODEL: "embedding-model" });
    const operations = createApplicationOperations(database, config, fetcher);

    const first = await operations.execute("article.retry", { articleId: 1 }, "web");
    assert.deepEqual(first.ok ? first.data : null, { articleId: 1, retried: true, processingState: "pending" });
    assert.equal(database.prepare("SELECT extraction_status FROM items WHERE id=1").get()?.extraction_status, "available");
    assert.match(String(database.prepare("SELECT extracted_content FROM items WHERE id=1").get()?.extracted_content), /Useful article body/);
    assert.deepEqual(database.prepare("SELECT type FROM jobs WHERE item_id=1 ORDER BY type").all().map((row) => row.type), ["analysis", "embedding"]);

    const second = await operations.execute("article.retry", { articleId: 1 }, "openclaw");
    assert.deepEqual(second.ok ? second.data : null, { articleId: 1, retried: false, processingState: "pending" });
    assert.equal(fetchCount, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM jobs WHERE item_id=1").get()?.count, 2);
    assert.deepEqual(database.prepare("SELECT action, caller, result FROM action_history ORDER BY id").all().map((row) => [row.action, row.caller, row.result]), [
      ["article.retry", "web", "success"],
      ["article.retry", "openclaw", "success"],
    ]);
  } finally { database.close(); }
});

test("failed article retry preserves failure for HTTP errors and empty content", async () => {
  for (const response of [new Response("no", { status: 503 }), new Response("<script>empty</script>")]) {
    const database = openDatabase(":memory:");
    try {
      insertItem(database, 1, "failed", null);
      const operations = createApplicationOperations(database, loadConfig({}), async () => response.clone());
      const result = await operations.execute("article.retry", { articleId: 1 }, "web");
      assert.equal(result.ok, false);
      assert.equal(database.prepare("SELECT extraction_status FROM items WHERE id=1").get()?.extraction_status, "failed");
      assert.equal(database.prepare("SELECT count(*) AS count FROM jobs WHERE item_id=1").get()?.count, 0);
    } finally { database.close(); }
  }
});
