import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedAdapter } from "../src/collection/adapters.js";
import { CollectionCoordinator } from "../src/collection/coordinator.js";
import { ItemRepository, extractArticle, normalizeUrl, titleSimilarity } from "../src/collection/normalize.js";
import type { CollectionAdapter } from "../src/collection/types.js";
import { openDatabase } from "../src/db/database.js";

const feedXml = `<?xml version="1.0"?><rss><channel><title>Feed</title>
  <item><title>Local story</title><link>https://example.com/story?utm_source=test#top</link></item>
</channel></rss>`;

test("feed adapter sends cache conditions and skips unchanged feeds", async () => {
  let observedHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    observedHeaders = new Headers(init?.headers);
    return new Response(null, { status: 304 });
  };
  const adapter = new FeedAdapter(fetcher, () => new Date("2026-08-15T00:00:00Z"));
  const result = await adapter.collect({
    id: 1, kind: "rss", canonicalUrl: "https://example.com/feed", fetchIntervalMinutes: 60,
  }, { etag: '"abc"', lastModified: "yesterday" });

  assert.equal(observedHeaders?.get("if-none-match"), '"abc"');
  assert.equal(observedHeaders?.get("if-modified-since"), "yesterday");
  assert.equal(result.notModified, true);
  assert.equal(result.items.length, 0);
});

test("collection isolates adapter failures and increases retry delay", async () => {
  const database = openDatabase(":memory:");
  try {
    const timestamp = "2026-08-15T00:00:00.000Z";
    const insert = database.prepare(`
      INSERT INTO sources(kind, canonical_url, display_name, next_fetch_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const failingId = Number(insert.run("rss", "https://bad.example/feed", "Bad", timestamp, timestamp, timestamp).lastInsertRowid);
    const healthyId = Number(insert.run("rss", "https://good.example/feed", "Good", timestamp, timestamp, timestamp).lastInsertRowid);
    const adapter: CollectionAdapter = {
      kinds: ["rss"],
      async collect(source) {
        if (source.id === failingId) throw new Error("timeout");
        return {
          items: [{ externalId: "story", url: "https://example.com/story", title: "Story", feedContent: "saved body" }],
          checkedAt: timestamp, nextFetchAt: "2026-08-15T01:00:00.000Z", notModified: false,
        };
      },
    };
    const repository = new ItemRepository(database);
    const coordinator = new CollectionCoordinator(database, [adapter], () => new Date(timestamp),
      (sourceId, items) => items.forEach((item) => repository.save(sourceId, item)));
    const outcomes = await coordinator.collectDue();

    assert.equal(outcomes.find((outcome) => outcome.sourceId === failingId)?.error, "timeout");
    assert.equal(outcomes.find((outcome) => outcome.sourceId === healthyId)?.collected, 1);
    const failure = database.prepare("SELECT failure_count, next_fetch_at FROM sources WHERE id = ?").get(failingId);
    assert.equal(failure?.failure_count, 1);
    assert.equal(failure?.next_fetch_at, "2026-08-15T00:02:00.000Z");
    assert.equal(database.prepare("SELECT feed_content FROM items").get()?.feed_content, "saved body");
  } finally {
    database.close();
  }
});

test("normalization merges canonical URLs while preserving sources and offline content", async () => {
  const database = openDatabase(":memory:");
  try {
    const timestamp = new Date().toISOString();
    const addSource = database.prepare(`
      INSERT INTO sources(kind, canonical_url, display_name, created_at, updated_at)
      VALUES ('rss', ?, ?, ?, ?)
    `);
    const firstSource = Number(addSource.run("https://one.example/feed", "One", timestamp, timestamp).lastInsertRowid);
    const secondSource = Number(addSource.run("https://two.example/feed", "Two", timestamp, timestamp).lastInsertRowid);
    const repository = new ItemRepository(database);
    const firstItem = repository.save(firstSource, {
      externalId: "1", url: "https://EXAMPLE.com/story/?utm_source=one#section", title: "Shared story", feedContent: "offline body",
    });
    const secondItem = repository.save(secondSource, {
      externalId: "2", url: "https://example.com/story", title: "Shared story",
    });
    assert.equal(firstItem, secondItem);
    assert.equal(database.prepare("SELECT count(*) AS count FROM source_items").get()?.count, 2);
    assert.equal(database.prepare("SELECT feed_content FROM items WHERE id = ?").get(firstItem)?.feed_content, "offline body");
    assert.equal(normalizeUrl("https://example.com/a?gclid=x#b"), "https://example.com/a");
    assert.ok(titleSimilarity("SQLite local reader", "A local SQLite reader") > 0.5);
    assert.equal(await extractArticle("https://example.com", async () => new Response("<article><h1>Title</h1><p>Body &amp; text</p></article>")), "Title Body & text");
  } finally {
    database.close();
  }
});
