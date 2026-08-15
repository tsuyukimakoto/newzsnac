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
          keyPoints: [{ headline: "New", detail: "新しい内容を説明する。" }], itemType: "article", originalLanguage: "en",
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
    assert.deepEqual(dashboard.ok && dashboard.data, { total: 1, unread: 1, saved: 0, interested: 0, recommended: 0, pending: 0, failed: 0, readingMinutes: 1 });
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
    assert.deepEqual(empty.ok && empty.data, { total: 0, unread: 0, saved: 0, interested: 0, recommended: 0, pending: 0, failed: 0, readingMinutes: 0 });

    const runtime = await operations.execute("runtime.status", {}, "web");
    assert.equal(runtime.ok, true);
    assert.deepEqual(runtime.ok && (runtime.data as { embedding: unknown }).embedding, {
      configured: false, model: null, embedded: 0, pending: 0, recommendations: 0,
    });

    const sources = await operations.execute("source.list", {}, "web");
    assert.equal(sources.ok, true);
    assert.deepEqual(sources.ok && sources.data, []);
  } finally {
    database.close();
  }
});

test("collection, local embeddings, explicit interest, recommendation, and removal flow end to end", async () => {
  const database = openDatabase(":memory:");
  try {
    const relatedFeed = `<?xml version="1.0"?><rss><channel><title>Related feed</title>
      <item><title>Local AI design</title><link>https://example.com/ai-design</link><description>Local model architecture</description></item>
      <item><title>Local AI implementation</title><link>https://example.com/ai-code</link><description>Local model implementation</description></item>
    </channel></rss>`;
    const fetcher: Fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://example.com/related.xml") return new Response(relatedFeed, { headers: { "content-type": "application/rss+xml" } });
      if (url.startsWith("https://example.com/ai-")) return new Response(`<article>${url} local AI details</article>`);
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen" }, { id: "embed-model" }] });
      if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summaryJa: "ローカルAIの記事", labels: ["AI"], priority: 80,
        keyPoints: [{ headline: "関心に近い", detail: "関心記事と共通する内容を説明する。" }],
        itemType: "article", originalLanguage: "en",
      }) } }] });
      if (url.endsWith("/embeddings")) {
        const body = JSON.parse(String(init?.body)) as { input: string };
        return Response.json({ data: [{ embedding: body.input.includes("Local AI") ? [1, 0.05] : [0, 1] }] });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const config = loadConfig({ NEWSZNAC_EMBEDDING_MODEL: "embed-model", NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD: "0.8" });
    const operations = createApplicationOperations(database, config, fetcher);
    assert.equal((await operations.execute("source.add", { input: "https://example.com/related.xml" }, "web")).ok, true);
    assert.equal((await runCollectionCycle(database, config, fetcher)).collected, 2);
    await runAnalysisCycle(database, config, fetcher, 50);

    const ids = database.prepare("SELECT id FROM items ORDER BY id").all().map((row) => Number(row.id));
    assert.equal((await operations.execute("article.interest", { articleId: ids[0], interested: true }, "web")).ok, true);
    await runAnalysisCycle(database, config, fetcher, 50);
    const recommended = await operations.execute("article.list", { recommended: true }, "web");
    assert.deepEqual(recommended.ok && (recommended.data as readonly { id: number }[]).map((item) => item.id), [ids[1]]);

    assert.equal((await operations.execute("article.interest", { articleId: ids[0], interested: false }, "web")).ok, true);
    assert.equal(database.prepare("SELECT count(*) AS count FROM item_recommendations").get()?.count, 0);
  } finally { database.close(); }
});
