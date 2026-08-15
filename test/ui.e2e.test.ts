import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createApplicationOperations } from "../src/application/operations.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { createAppServer } from "../src/server.js";
import type { Fetch } from "../src/sources/resolver.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("database state did not update before timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

test("keyboard-only reading, translation, saving, unread toggle, and search", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const timestamp = "2026-08-15T00:00:00.000Z";
  const insert = database.prepare(`
    INSERT INTO items(id, canonical_url, title, published_at, discovered_at, feed_content,
      extraction_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
  `);
  insert.run(1, "https://example.com/1", "First", "2026-08-15T02:00:00.000Z", timestamp, "First body", timestamp, timestamp);
  insert.run(2, "https://example.com/2", "Second", "2026-08-15T01:00:00.000Z", timestamp, "Second body", timestamp, timestamp);
  const config = loadConfig({ NEWSZNAC_PORT: "0" });
  const feed = `<?xml version="1.0"?><rss><channel><title>New source</title><item><title>Preview article</title><link>https://example.com/preview</link></item></channel></rss>`;
  const fetcher: Fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen" }] });
    if (url === "https://example.com/feed.xml") return new Response(feed, { headers: { "content-type": "application/rss+xml" } });
    throw new Error(`unexpected request: ${url}`);
  };
  const operations = createApplicationOperations(database, config, fetcher);
  const server = createAppServer(resolve(process.cwd(), "public"), operations);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5_000);
  await page.goto(`http://127.0.0.1:${address.port}`);

  assert.equal(await page.locator(".reader-content h1").textContent(), "First");
  assert.equal(await page.locator("#total-count").textContent(), "2");
  assert.equal(await page.locator("#runtime-status").textContent(), "SQLite · LM Studio (qwen)");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/operations/article.read")),
    page.keyboard.press("j"),
  ]);
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  await page.locator("#search").focus();
  await page.keyboard.type("j");
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  await page.locator("#search").fill("Second");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/items?q=Second")),
    page.locator("#search").press("Enter"),
  ]);
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  await page.locator("#article-list").focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#mode").textContent(), "精読モード");
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/operations/article.save")), page.keyboard.press("s")]);
  await page.locator("#article-list").focus();
  await page.keyboard.press("u");
  await waitUntil(() => database.prepare("SELECT is_read FROM item_user_states WHERE item_id=2").get()?.is_read === 1);
  await page.locator("#article-list").focus();
  await page.keyboard.press("t");
  await waitUntil(() => database.prepare("SELECT count(*) count FROM jobs WHERE item_id=2 AND type='translation'").get()?.count === 1);
  assert.equal(await page.locator(".article-card.selected .badge").textContent(), "翻訳中");
  assert.equal(database.prepare("SELECT is_read FROM item_user_states WHERE item_id=1").get()?.is_read, 1);
  const secondState = database.prepare("SELECT is_read,is_saved FROM item_user_states WHERE item_id=2").get();
  assert.equal(secondState?.is_read, 1);
  assert.equal(secondState?.is_saved, 1);
  assert.equal(database.prepare("SELECT count(*) count FROM jobs WHERE item_id=2 AND type='translation'").get()?.count, 1);
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "search");
  await page.locator("#search").fill("First");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/items?q=First")),
    page.locator("#search").press("Enter"),
  ]);
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "First");

  await page.locator(".discover").click();
  await page.locator("#source-input").fill("https://example.com/feed.xml");
  await page.locator("#source-form button[type=submit]").click();
  await page.locator("#confirm-source").click();
  await waitUntil(() => database.prepare("SELECT count(*) count FROM sources").get()?.count === 1);
  await page.waitForFunction(() => document.querySelector("#source-message")?.textContent?.includes("追加しました"));
  assert.match(await page.locator("#source-message").textContent() ?? "", /追加しました/);
  assert.equal(await page.locator("#source-list .source span").textContent(), "New source");
});
