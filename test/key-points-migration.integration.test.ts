import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { migrations } from "../src/db/migrations.js";

test("migration converts legacy reasons into key points without reanalysis", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "newzsnac-key-points-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  const now = "2026-08-15T00:00:00.000Z";

  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const record = legacy.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of migrations.filter(({ version }) => version <= 8)) {
    legacy.exec(migration.sql);
    record.run(migration.version, migration.name, now);
  }
  const itemId = Number(legacy.prepare(`
    INSERT INTO items(canonical_url, title, discovered_at, feed_content, created_at, updated_at)
    VALUES ('https://example.com/legacy', 'Legacy analysis', ?, 'body', ?, ?)
  `).run(now, now, now).lastInsertRowid);
  legacy.prepare(`
    INSERT INTO item_analyses(
      item_id, kind, model_id, prompt_version, summary_ja, labels_json,
      priority, reasons_json, item_type, original_language, analyzed_at
    ) VALUES (?, 'analysis', 'qwen', 'analysis-v1', '要約', '[]', 70,
      '["第一の論点","第二の論点"]', 'article', 'ja', ?)
  `).run(itemId, now);
  legacy.prepare(`
    INSERT INTO jobs(type, item_id, status, priority, available_at, created_at, updated_at)
    VALUES ('analysis', ?, 'completed', 1, ?, ?, ?)
  `).run(itemId, now, now, now);
  legacy.close();

  const migrated = openDatabase(databasePath);
  context.after(() => migrated.close());
  const columns = migrated.prepare("PRAGMA table_info(item_analyses)").all().map((row) => String(row.name));
  assert.equal(columns.includes("reasons_json"), false);
  assert.equal(columns.includes("key_points_json"), true);
  assert.equal(
    migrated.prepare("SELECT key_points_json FROM item_analyses WHERE item_id = ?").get(itemId)?.key_points_json,
    '[{"headline":"第一の論点","detail":""},{"headline":"第二の論点","detail":""}]',
  );
  assert.equal(migrated.prepare("SELECT count(*) AS count FROM jobs").get()?.count, 1);
});
