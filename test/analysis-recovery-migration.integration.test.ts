import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { migrations } from "../src/db/migrations.js";

test("migration restores one analysis job per unanalysed article without reanalysing completed articles", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "newzsnac-analysis-recovery-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  const now = "2026-08-15T00:00:00.000Z";
  legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of migrations.filter(({ version }) => version <= 9)) {
    legacy.exec(migration.sql);
    legacy.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(migration.version, migration.name, now);
  }
  const insertItem = legacy.prepare(`
    INSERT INTO items(id, canonical_url, title, discovered_at, feed_content, extraction_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'body', 'available', ?, ?)
  `);
  insertItem.run(1, "https://example.com/1", "Unanalysed", now, now, now);
  insertItem.run(2, "https://example.com/2", "Analysed", now, now, now);
  legacy.prepare(`
    INSERT INTO item_analyses(item_id, kind, model_id, prompt_version, summary_ja, labels_json,
      priority, key_points_json, item_type, original_language, analyzed_at)
    VALUES (2, 'analysis', 'qwen', 'v1', 'done', '[]', 50, '[]', 'article', 'en', ?)
  `).run(now);
  const insertJob = legacy.prepare(`
    INSERT INTO jobs(type, item_id, payload_json, status, attempts, max_attempts, available_at,
      lease_owner, lease_expires_at, last_error, created_at, updated_at)
    VALUES ('analysis', ?, '{}', ?, ?, 5, ?, ?, ?, ?, ?, ?)
  `);
  insertJob.run(1, "failed", 5, now, null, null, "invalid JSON", now, now);
  insertJob.run(1, "running", 3, now, "old-worker", now, null, now, now);
  insertJob.run(2, "failed", 5, now, null, null, "old failure", now, now);
  legacy.close();

  const migrated = openDatabase(databasePath);
  context.after(() => migrated.close());
  assert.equal(migrated.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count, 11);
  assert.equal(migrated.prepare("SELECT count(*) AS count FROM jobs WHERE item_id=1 AND status IN ('pending','running','retry_wait')").get()?.count, 1);
  const restored = migrated.prepare("SELECT status, attempts, lease_owner, lease_expires_at, last_error FROM jobs WHERE item_id=1 ORDER BY id DESC LIMIT 1").get();
  assert.equal(restored?.status, "pending");
  assert.equal(restored?.attempts, 0);
  assert.equal(restored?.lease_owner, null);
  assert.equal(restored?.lease_expires_at, null);
  assert.equal(restored?.last_error, null);
  assert.equal(migrated.prepare("SELECT count(*) AS count FROM jobs WHERE item_id=2 AND status IN ('pending','running','retry_wait')").get()?.count, 0);
});
