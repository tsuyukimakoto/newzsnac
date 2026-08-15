import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { SourceResolver } from "../src/sources/resolver.js";
import { SourceService } from "../src/sources/service.js";

const feed = `<?xml version="1.0"?><rss><channel><title>Example Feed</title>
  <item><title>First</title><link>https://example.com/first</link><pubDate>Fri, 15 Aug 2026 00:00:00 GMT</pubDate></item>
  <item><title>Second</title><link>https://example.com/second</link><pubDate>Thu, 14 Aug 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

const rdfFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel rdf:about="https://b.hatena.ne.jp/hotentry/it.rss">
    <title>&#x306F;&#x3066;&#x306A;ブックマーク - テクノロジー</title>
    <link>https://b.hatena.ne.jp/hotentry/it</link>
  </channel>
  <item rdf:about="https://example.com/rdf-item">
    <title>RSS 1.0 &#x8A18;&#x4E8B;</title>
    <link>https://example.com/rdf-item</link>
    <dc:date>2026-08-14T19:21:13Z</dc:date>
    <content:encoded>&lt;p&gt;RDF content&lt;/p&gt;</content:encoded>
  </item>
</rdf:RDF>`;

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
    if (url === "https://b.hatena.ne.jp/hotentry/it") {
      return new Response('<link rel="alternate" type="application/rss+xml" href="/hotentry/it.rss">', {
        headers: { "content-type": "text/html" },
      });
    }
    if (url === "https://b.hatena.ne.jp/hotentry/it.rss") {
      return new Response(rdfFeed, {
        headers: { "content-type": "application/xml" },
      });
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

test("RSS 1.0 sources resolve from direct and webpage URLs with namespaced fields", async () => {
  const resolver = new SourceResolver(fakeFetch());

  for (const input of ["https://b.hatena.ne.jp/hotentry/it.rss", "https://b.hatena.ne.jp/hotentry/it"]) {
    const source = await resolver.resolve(input);
    assert.equal(source.kind, "rss");
    assert.equal(source.canonicalUrl, "https://b.hatena.ne.jp/hotentry/it.rss");
    assert.equal(source.displayName, "はてなブックマーク - テクノロジー");

    const preview = await resolver.preview(source, new Set());
    assert.deepEqual(preview.recentItems[0], {
      title: "RSS 1.0 記事",
      url: "https://example.com/rdf-item",
      publishedAt: "2026-08-14T19:21:13Z",
      content: "<p>RDF content</p>",
    });
  }
});
