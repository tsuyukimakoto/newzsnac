import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplicationOperations } from "../src/application/operations.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { runAnalysisCycle, runCollectionCycle } from "../src/workers/services.js";
import type { Fetch } from "../src/sources/resolver.js";

const feed = `<?xml version="1.0"?><rss><channel><title>Actual feed</title>
  <item><title>Collected article</title><link>https://example.com/article</link>
  <description>Saved article body</description><pubDate>Fri, 15 Aug 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

test("runtime workers collect into SQLite, enqueue analysis, and persist LM results", async () => {
  const database = openDatabase(":memory:");
  try {
    const fetcher: Fetch = async (input) => {
      const url = String(input);
      if (url === "https://example.com/feed.xml") {
        return new Response(feed, { headers: { "content-type": "application/rss+xml" } });
      }
      if (url === "https://example.com/article") {
        return new Response("<article><p>Extracted article body</p></article>");
      }
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen/runtime-model" }] });
      if (url.endsWith("/chat/completions")) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          summaryJa: "実際の要約", labels: ["local"], priority: 75,
          reasons: ["new"], itemType: "article", originalLanguage: "en",
        }) } }] });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const config = loadConfig({});
    const operations = createApplicationOperations(database, config, fetcher);
    const added = await operations.execute("source.add", { input: "https://example.com/feed.xml" }, "web");
    assert.equal(added.ok, true);

    const collection = await runCollectionCycle(database, config, fetcher);
    assert.equal(collection.collected, 1);
    assert.equal(database.prepare("SELECT extracted_content FROM items").get()?.extracted_content, "Extracted article body");
    assert.equal(database.prepare("SELECT status FROM jobs WHERE type='analysis'").get()?.status, "pending");

    const analysis = await runAnalysisCycle(database, config, fetcher);
    assert.equal(analysis.processed, 1);
    assert.equal(database.prepare("SELECT summary_ja FROM item_analyses").get()?.summary_ja, "実際の要約");
    const dashboard = await operations.execute("dashboard.summary", {}, "web");
    assert.deepEqual(dashboard.ok && dashboard.data, { total: 1, unread: 1, saved: 0, readingMinutes: 1 });
    const articles = await operations.execute("article.list", {}, "web");
    assert.equal(articles.ok && (articles.data as readonly { summary: string }[])[0]?.summary, "実際の要約");
  } finally {
    database.close();
  }
});

test("dashboard operations return only persisted counts and sources", async () => {
  const database = openDatabase(":memory:");
  try {
    const config = loadConfig({});
    const fetcher: Fetch = async () => { throw new Error("offline"); };
    const operations = createApplicationOperations(database, config, fetcher);
    const empty = await operations.execute("dashboard.summary", {}, "web");
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.ok && empty.data, { total: 0, unread: 0, saved: 0, readingMinutes: 0 });

    const sources = await operations.execute("source.list", {}, "web");
    assert.equal(sources.ok, true);
    assert.deepEqual(sources.ok && sources.data, []);
  } finally {
    database.close();
  }
});
