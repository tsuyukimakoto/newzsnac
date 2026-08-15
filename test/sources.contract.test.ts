import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { SourceResolver } from "../src/sources/resolver.js";
import { SourceService } from "../src/sources/service.js";

const feed = `<?xml version="1.0"?><rss><channel><title>Example Feed</title>
  <item><title>First</title><link>https://example.com/first</link><pubDate>Fri, 15 Aug 2026 00:00:00 GMT</pubDate></item>
  <item><title>Second</title><link>https://example.com/second</link><pubDate>Thu, 14 Aug 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

function fakeFetch(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("resolveHandle")) {
      return Response.json({ did: "did:plc:alice" });
    }
    if (url === "https://example.com/") {
      return new Response('<link rel="alternate" type="application/rss+xml" href="/feed.xml">', {
        headers: { "content-type": "text/html" },
      });
    }
    if (url === "https://example.com/feed.xml") {
      return new Response(feed, { headers: { "content-type": "application/rss+xml" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("source resolution, preview, state transitions, duplicates, removal, and OPML use one contract", async () => {
  const database = openDatabase(":memory:");
  try {
    const resolver = new SourceResolver(fakeFetch());
    const service = new SourceService(database, resolver);

    await assert.rejects(() => resolver.resolve("not a source"), /supported URL/);
    const zenn = await resolver.resolve("https://zenn.dev/topics/typescript");
    assert.equal(zenn.canonicalUrl, "https://zenn.dev/topics/typescript/feed");
    const bluesky = await resolver.resolve("@alice.bsky.social");
    assert.match(bluesky.canonicalUrl, /actor=did%3Aplc%3Aalice/);

    const preview = await service.resolveAndPreview("https://example.com/");
    assert.equal(preview.displayName, "Example Feed");
    assert.equal(preview.recentItems.length, 2);
    assert.equal(preview.estimatedWeeklyCount, 14);
    assert.equal(preview.overlapRatio, 0);

    const added = service.add(preview, { basePriority: 80 });
    assert.equal(added.created, true);
    assert.equal(service.add(preview).created, false);
    service.pause(added.id);
    assert.throws(() => service.pause(added.id), /must be active/);
    service.resume(added.id);
    service.update(added.id, { displayName: "Renamed", excludedKeywords: ["sponsored"] });

    const timestamp = new Date().toISOString();
    const itemId = Number(database.prepare(`
      INSERT INTO items(canonical_url, title, discovered_at, created_at, updated_at)
      VALUES ('https://example.com/kept', 'Kept', ?, ?, ?)
    `).run(timestamp, timestamp, timestamp).lastInsertRowid);
    database.prepare(`
      INSERT INTO source_items(source_id, item_id, source_url, discovered_at)
      VALUES (?, ?, 'https://example.com/kept', ?)
    `).run(added.id, itemId, timestamp);
    service.remove(added.id);
    assert.equal(database.prepare("SELECT count(*) AS count FROM items WHERE id = ?").get(itemId)?.count, 1);

    const opml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="Example" xmlUrl="https://example.com/feed.xml"/>
      <outline text="Duplicate" xmlUrl="https://example.com/feed.xml"/>
    </body></opml>`;
    const imported = await service.importOpml(opml, true);
    assert.equal(imported.length, 1);
    assert.equal(imported[0]?.duplicate, false);
    const duplicateImport = await service.importOpml(opml);
    assert.equal(duplicateImport[0]?.duplicate, true);
  } finally {
    database.close();
  }
});

test("invalid OPML is rejected", async () => {
  const database = openDatabase(":memory:");
  try {
    const service = new SourceService(database, new SourceResolver(fakeFetch()));
    await assert.rejects(() => service.importOpml("<html></html>"), /valid OPML/);
  } finally {
    database.close();
  }
});
