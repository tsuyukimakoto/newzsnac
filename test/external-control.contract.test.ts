import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createApplicationOperations } from "../src/application/operations.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { createAppServer } from "../src/server.js";

test("web, CLI, and OpenClaw-equivalent CLI share validation, deduplication, transitions, and auditing", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "newzsnac-control-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "reader.sqlite");
  const config = loadConfig({ NEWSZNAC_DATABASE_PATH: databasePath, NEWSZNAC_PORT: "0" });
  const database = openDatabase(databasePath);
  context.after(() => database.close());
  const operations = createApplicationOperations(database, config);
  const server = createAppServer(resolve(process.cwd(), "public"), operations);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const webAdd = await fetch(`http://127.0.0.1:${address.port}/api/operations/source.add`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "https://zenn.dev/example" }),
  }).then((response) => response.json()) as { ok: boolean; data: { id: number; created: boolean } };
  assert.equal(webAdd.ok, true);
  assert.equal(webAdd.data.created, true);

  const cli = (caller: "cli" | "openclaw", operation: string, input: unknown) => spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist/src/cli.js"), operation, JSON.stringify(input), "--caller", caller],
    { encoding: "utf8", env: { ...process.env, NEWSZNAC_DATABASE_PATH: databasePath } },
  );
  const duplicate = cli("cli", "source.add", { input: "https://zenn.dev/example" });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal((JSON.parse(duplicate.stdout) as { data: { created: boolean } }).data.created, false);

  const paused = cli("openclaw", "source.pause", { sourceId: webAdd.data.id });
  assert.equal(paused.status, 0, paused.stderr);
  const invalidTransition = await fetch(`http://127.0.0.1:${address.port}/api/operations/source.pause`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: webAdd.data.id }),
  });
  assert.equal(invalidTransition.status, 400);

  const now = new Date().toISOString();
  const articleId = Number(database.prepare(`
    INSERT INTO items(canonical_url, title, discovered_at, created_at, updated_at)
    VALUES ('https://example.com/interest', 'Interesting', ?, ?, ?)
  `).run(now, now, now).lastInsertRowid);
  const interested = cli("cli", "article.interest", { articleId, interested: true });
  assert.equal(interested.status, 0, interested.stderr);
  assert.equal(database.prepare("SELECT interest FROM item_user_states WHERE item_id = ?").get(articleId)?.interest, "interested");
  const cleared = await fetch(`http://127.0.0.1:${address.port}/api/operations/article.interest`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleId, interested: false }),
  }).then((response) => response.json()) as { ok: boolean };
  assert.equal(cleared.ok, true);
  assert.equal(database.prepare("SELECT interest FROM item_user_states WHERE item_id = ?").get(articleId)?.interest, null);
  const invalidInterest = await operations.execute("article.interest", { articleId, interested: "yes" }, "web");
  assert.equal(invalidInterest.ok, false);

  const history = database.prepare("SELECT action, caller, result FROM action_history ORDER BY id").all();
  assert.deepEqual(history.map((row) => [row.action, row.caller, row.result]), [
    ["source.add", "web", "success"],
    ["source.add", "cli", "success"],
    ["source.pause", "openclaw", "success"],
    ["source.pause", "web", "error"],
    ["article.interest", "cli", "success"],
    ["article.interest", "web", "success"],
    ["article.interest", "web", "error"],
  ]);
});
