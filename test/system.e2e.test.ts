import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FeedAdapter, HackerNewsAdapter, BlueskyAdapter } from "../src/collection/adapters.js";
import { CollectionCoordinator } from "../src/collection/coordinator.js";
import { ItemRepository } from "../src/collection/normalize.js";
import { loadConfig } from "../src/config.js";
import { createBackup, restoreBackup } from "../src/db/backup.js";
import { openDatabase } from "../src/db/database.js";
import { LmStudioClient } from "../src/enrichment/client.js";
import { EnrichmentService, EnrichmentWorker } from "../src/enrichment/service.js";
import { ReadingService } from "../src/reading/service.js";
import { SourceResolver, type Fetch } from "../src/sources/resolver.js";
import { SourceService } from "../src/sources/service.js";

const rss = (title: string, url: string) => `<?xml version="1.0"?><rss><channel><title>${title}</title><item><title>${title} article</title><link>${url}</link></item></channel></rss>`;

test("four sources flow through collection, normalization, analysis, reading, degradation, and restore", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "newzsnac-system-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "reader.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  const restoredPath = join(directory, "restored.sqlite");
  const database = openDatabase(databasePath);

  const fetcher: Fetch = async (input) => {
    const url = String(input);
    if (url.includes("resolveHandle")) return Response.json({ did: "did:plc:alice" });
    if (url === "https://feeds.example/rss.xml") return new Response(rss("RSS", "https://articles.example/rss"), { headers: { "content-type": "application/rss+xml" } });
    if (url === "https://zenn.dev/example/feed") return new Response(rss("Zenn", "https://articles.example/zenn"), { headers: { "content-type": "application/rss+xml" } });
    if (url.includes("topstories.json")) return Response.json([101]);
    if (url.includes("/item/101.json")) return Response.json({ id: 101, title: "HN article", url: "https://articles.example/hn", by: "hn-user" });
    if (url.includes("app.bsky.feed.getAuthorFeed")) return Response.json({ cursor: "next", feed: [{ post: { uri: "at://did:plc:alice/post/1", author: { handle: "alice.bsky.social" }, record: { text: "Bluesky article", createdAt: "2026-08-15T00:00:00Z", embed: { external: { uri: "https://articles.example/bluesky", title: "Bluesky article" } } } } }] });
    throw new Error(`unexpected network request: ${url}`);
  };
  const resolver = new SourceResolver(fetcher);
  const sources = new SourceService(database, resolver);
  for (const input of ["https://feeds.example/rss.xml", "https://news.ycombinator.com", "@alice.bsky.social", "https://zenn.dev/example"]) {
    sources.add(await resolver.resolve(input));
  }
  assert.equal(database.prepare("SELECT count(*) count FROM sources").get()?.count, 4);
  database.prepare("UPDATE sources SET next_fetch_at='2026-08-15T00:00:00.000Z'").run();

  const repository = new ItemRepository(database);
  const clock = () => new Date("2026-08-15T01:00:00.000Z");
  const coordinator = new CollectionCoordinator(database, [
    new FeedAdapter(fetcher, clock), new HackerNewsAdapter(fetcher, 1, clock), new BlueskyAdapter(fetcher, clock),
  ], clock, (sourceId, items) => items.forEach((item) => repository.save(sourceId, item, item.feedContent ?? `body: ${item.title}`)));
  const outcomes = await coordinator.collectDue();
  assert.equal(outcomes.length, 4);
  assert.ok(outcomes.every((outcome) => !outcome.error && outcome.collected === 1));
  assert.equal(database.prepare("SELECT count(*) count FROM items").get()?.count, 4);

  const enrichment = new EnrichmentService(database);
  const itemRows = database.prepare("SELECT id FROM items ORDER BY id").all();
  for (const row of itemRows) enrichment.enqueueAnalysis(Number(row.id), 50, null, clock());
  const lm = new LmStudioClient(loadConfig({}).lmStudioUrl, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summaryJa: "要約", labels: ["news"], priority: 70, reasons: ["new"], itemType: "article", originalLanguage: "en" }) } }] }));
  const worker = new EnrichmentWorker(database, lm, "system-test");
  for (let index = 0; index < 4; index += 1) assert.equal(await worker.runOne("qwen", "v1", clock()), true);
  assert.equal(database.prepare("SELECT count(*) count FROM item_analyses").get()?.count, 4);

  const reading = new ReadingService(database);
  assert.equal(reading.list().length, 4);
  reading.setRead(Number(itemRows[0]!.id), true);
  reading.setSaved(Number(itemRows[1]!.id), true);

  const networkStopped: Fetch = async () => { throw new Error("network stopped"); };
  database.prepare("UPDATE sources SET next_fetch_at='2026-08-15T01:30:00.000Z'").run();
  const offlineCollection = new CollectionCoordinator(database, [
    new FeedAdapter(networkStopped, clock), new HackerNewsAdapter(networkStopped, 1, clock),
    new BlueskyAdapter(networkStopped, clock),
  ], () => new Date("2026-08-15T02:00:00.000Z"));
  assert.ok((await offlineCollection.collectDue()).every((outcome) => outcome.error === "network stopped"));
  assert.equal(reading.search("article").length, 4);

  const offlineLm = new LmStudioClient(loadConfig({}).lmStudioUrl, async () => { throw new Error("LM Studio stopped"); });
  enrichment.enqueueAnalysis(Number(itemRows[0]!.id), 100, null, new Date("2026-08-15T02:00:00Z"));
  await new EnrichmentWorker(database, offlineLm, "offline-test").runOne("qwen", "v2", new Date("2026-08-15T02:00:00Z"));
  assert.equal(reading.search("article").length, 4);
  assert.equal(reading.list().find((item) => item.id === Number(itemRows[0]!.id))?.isRead, true);
  assert.equal(reading.list().find((item) => item.id === Number(itemRows[1]!.id))?.isSaved, true);

  await createBackup(database, backupPath);
  database.close();
  restoreBackup(backupPath, restoredPath);
  const restored = openDatabase(restoredPath);
  try {
    assert.equal(restored.prepare("SELECT count(*) count FROM sources").get()?.count, 4);
    assert.equal(restored.prepare("SELECT count(*) count FROM items").get()?.count, 4);
    assert.equal(restored.prepare("SELECT count(*) count FROM item_analyses").get()?.count, 4);
    assert.equal(restored.prepare("SELECT count(*) count FROM item_user_states WHERE is_read=1 OR is_saved=1").get()?.count, 2);
  } finally { restored.close(); }
});
