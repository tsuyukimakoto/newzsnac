import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { JobQueue } from "../src/db/jobs.js";

test("migrations, WAL, FTS, concurrent connections, leases, and backup restore", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "newzsnac-db-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "newzsnac.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  const first = openDatabase(databasePath);
  const second = openDatabase(databasePath);
  context.after(() => first.close());
  context.after(() => second.close());

  assert.equal(first.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(first.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count, 6);

  const now = "2026-08-15T00:00:00.000Z";
  const sourceId = Number(first.prepare(`
    INSERT INTO sources(kind, canonical_url, display_name, created_at, updated_at)
    VALUES ('rss', 'https://example.com/feed.xml', 'Example', ?, ?)
  `).run(now, now).lastInsertRowid);
  const itemId = Number(second.prepare(`
    INSERT INTO items(canonical_url, title, author, discovered_at, feed_content, created_at, updated_at)
    VALUES ('https://example.com/story', 'SQLite local reader', 'Makoto', ?, 'offline searchable body', ?, ?)
  `).run(now, now, now).lastInsertRowid);
  first.prepare(`
    INSERT INTO source_items(source_id, item_id, source_url, discovered_at)
    VALUES (?, ?, 'https://example.com/story', ?)
  `).run(sourceId, itemId, now);

  const search = first.prepare(
    "SELECT rowid FROM item_search WHERE item_search MATCH 'offline'",
  ).get();
  assert.equal(search?.rowid, itemId);

  const queue = new JobQueue(first);
  queue.enqueue("analysis", { itemId }, { itemId, priority: 100, availableAt: new Date(now) });
  queue.enqueue("collection", { sourceId }, { sourceId, priority: 10, availableAt: new Date(now) });
  const claimed = queue.claim("worker-a", 100, new Date(now));
  assert.equal(claimed?.type, "analysis");
  assert.equal(claimed?.attempts, 1);

  const recovered = queue.claim("worker-b", 100, new Date("2026-08-15T00:00:00.200Z"));
  assert.equal(recovered?.id, claimed?.id);
  assert.equal(recovered?.attempts, 2);
  assert.equal(queue.complete(recovered!.id, "worker-a"), false);
  assert.equal(queue.complete(recovered!.id, "worker-b"), true);

  await backup(first, backupPath);
  const restored = openDatabase(backupPath);
  try {
    assert.equal(restored.prepare("SELECT count(*) AS count FROM sources").get()?.count, 1);
    assert.equal(restored.prepare("SELECT count(*) AS count FROM items").get()?.count, 1);
    assert.equal(restored.prepare("SELECT count(*) AS count FROM jobs").get()?.count, 2);
  } finally {
    restored.close();
  }
});
