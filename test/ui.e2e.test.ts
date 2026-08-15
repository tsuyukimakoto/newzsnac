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
  insert.run(1, "https://example.com/1", "First", "2026-08-15T02:00:00.000Z", timestamp, "First body ".repeat(800), timestamp, timestamp);
  insert.run(2, "https://example.com/2", "Second", "2026-08-15T01:00:00.000Z", timestamp, "Second body ".repeat(800), timestamp, timestamp);
  for (let id = 3; id <= 30; id += 1) {
    const publishedAt = new Date(Date.parse("2026-08-15T00:00:00.000Z") - id * 3_600_000).toISOString();
    insert.run(id, `https://example.com/${id}`, `Article ${id}`, publishedAt, timestamp, `Body ${id}`, timestamp, timestamp);
  }
  const insertAnalysis = database.prepare(`
    INSERT INTO item_analyses(item_id, kind, model_id, prompt_version, summary_ja,
      labels_json, priority, reasons_json, item_type, original_language, analyzed_at)
    VALUES (?, 'analysis', 'qwen', 'v1', ?, ?, 80, ?, 'article', 'en', ?)
  `);
  insertAnalysis.run(1, "First summary", '["AI","Research"]', '["First point","Second point"]', timestamp);
  database.prepare(`
    INSERT INTO item_recommendations(target_item_id, source_item_id, score, model_id, input_version, calculated_at)
    VALUES (2, 1, 0.91, 'embed-model', 'embedding-v1', ?)
  `).run(timestamp);
  const config = loadConfig({ NEWSZNAC_PORT: "0", NEWSZNAC_EMBEDDING_MODEL: "embed-model" });
  let chatShouldFail = false;
  const feed = `<?xml version="1.0"?><rss><channel><title>New source</title><item><title>Preview article</title><link>https://example.com/preview</link></item></channel></rss>`;
  const fetcher: Fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen" }] });
    if (url.endsWith("/chat/completions")) return chatShouldFail
      ? new Response("model unavailable", { status: 503 })
      : Response.json({ choices: [{ message: { content: "この記事の重要点はローカル処理です。" } }] });
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
  assert.equal(await page.locator("#total-count").textContent(), "30");
  assert.equal(await page.locator("#runtime-status").textContent(), "SQLite · LM Studio (qwen) · 推薦 1");
  assert.equal(await page.locator(".reader-summary p").textContent(), "First summary");
  assert.deepEqual(await page.locator(".reader-points li").allTextContents(), ["First point", "Second point"]);
  assert.equal(await page.locator(".article-body").count(), 0);
  assert.equal(await page.locator("#hide-read").isChecked(), true);
  assert.equal(await page.locator("#original-link").getAttribute("target"), "_blank");
  assert.match(await page.locator("#original-link").getAttribute("rel") ?? "", /noopener/);
  assert.match(await page.locator(".article-card.selected .publication").textContent() ?? "", /2026\/08\/15/);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/operations/article.interest")),
    page.locator("#interest-button").click(),
  ]);
  assert.equal(database.prepare("SELECT interest FROM item_user_states WHERE item_id=1").get()?.interest, "interested");
  assert.equal(await page.locator("#interest-button").getAttribute("aria-pressed"), "true");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/items?interested=true")),
    page.locator("#filter-interested").click(),
  ]);
  assert.equal(await page.locator(".article-card h2").textContent(), "First");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/items?unread=true")),
    page.locator("#filter-all").click(),
  ]);
  const readerScrollBefore = await page.locator("#reader").evaluate((element) => element.scrollTop);
  await page.locator("#article-list").evaluate((element) => { element.scrollTop = 500; element.dispatchEvent(new Event("scroll")); });
  assert.ok(await page.locator("#article-list").evaluate((element) => element.scrollTop) > 0);
  assert.equal(await page.locator("#reader").evaluate((element) => element.scrollTop), readerScrollBefore);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/operations/article.read")),
    page.waitForResponse((response) => response.url().includes("/api/items?unread=true")),
    page.keyboard.press("j"),
  ]);
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  assert.equal(await page.locator(".article-card h2", { hasText: "First" }).count(), 0);
  assert.equal(await page.locator("#visible-count").textContent(), "29件を表示");
  assert.equal(await page.evaluate(() => localStorage.getItem("newzsnac.hideRead")), "true");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/items")),
    page.locator("#hide-read").uncheck(),
  ]);
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  assert.match(await page.locator(".recommendation-note").textContent() ?? "", /First.*91%/);
  const chatQuestion = page.locator("#chat-question");
  await chatQuestion.fill("日本語入力中 j k / s i u t o");
  await chatQuestion.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "chat-question");
  await chatQuestion.evaluate((element) => { element.dataset.testIdentity = "stable-chat-editor"; });
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/items?unread=true")),
    page.locator("#hide-read").evaluate((element) => {
      (element as HTMLInputElement).checked = true;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }),
  ]);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "chat-question");
  assert.equal(await page.locator("#chat-question").getAttribute("data-test-identity"), "stable-chat-editor");
  assert.equal(await page.locator("#chat-question").inputValue(), "日本語入力中 j k / s i u t o");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/items")),
    page.locator("#hide-read").evaluate((element) => {
      (element as HTMLInputElement).checked = false;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }),
  ]);
  const titleBeforeComposition = await page.locator(".reader-content h1").textContent();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "j", code: "KeyJ", bubbles: true, isComposing: true,
  })));
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".reader-content h1").textContent(), titleBeforeComposition);
  assert.equal(database.prepare("SELECT is_read FROM item_user_states WHERE item_id=2").get()?.is_read ?? 0, 0);
  await page.locator("#article-list").focus();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/operations/article.interest")),
    page.keyboard.press("i"),
  ]);
  assert.equal(database.prepare("SELECT interest FROM item_user_states WHERE item_id=2").get()?.interest, "interested");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/operations/article.interest")),
    page.locator("#interest-button").click(),
  ]);
  assert.equal(database.prepare("SELECT interest FROM item_user_states WHERE item_id=2").get()?.interest, null);
  const interestState = database.prepare("SELECT is_read,is_saved FROM item_user_states WHERE item_id=2").get();
  assert.equal(interestState?.is_read, 0);
  assert.equal(interestState?.is_saved, 0);
  await page.locator("#search").focus();
  await page.keyboard.type("j");
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  assert.equal(await page.locator(".analysis-pending h2").textContent(), "要約を準備しています");
  insertAnalysis.run(2, "Second summary", '["Business"]', '["Updated point"]', timestamp);
  await page.locator("#search").fill("Second");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/items?q=Second")),
    page.locator("#search").press("Enter"),
  ]);
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  assert.equal(await page.locator(".reader-summary p").textContent(), "Second summary");
  assert.equal(await page.locator(".reader-points li").textContent(), "Updated point");
  await page.locator("#article-list").focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#mode").textContent(), "精読モード");
  assert.equal(await page.locator(".article-body").count(), 1);
  const listScrollBefore = await page.locator("#article-list").evaluate((element) => element.scrollTop);
  await page.locator("#reader").evaluate((element) => { element.scrollTop = 400; });
  assert.ok(await page.locator("#reader").evaluate((element) => element.scrollTop) > 0);
  assert.equal(await page.locator("#article-list").evaluate((element) => element.scrollTop), listScrollBefore);
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

  await page.locator("#chat-question").fill("この記事で最も重要な点は？");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/operations/article.chat.ask")),
    page.locator("#article-chat button[type=submit]").click(),
  ]);
  assert.equal(await page.locator(".chat-message.assistant .chat-content").textContent(), "この記事の重要点はローカル処理です。");
  assert.equal(database.prepare("SELECT count(*) AS count FROM article_chat_messages WHERE item_id=1").get()?.count, 2);
  await page.locator("#handoff-button").click();
  assert.match(await page.locator("#handoff-text").inputValue(), /https:\/\/example\.com\/1/);
  assert.match(await page.locator("#handoff-text").inputValue(), /この記事で最も重要な点は？/);
  await page.reload();
  assert.equal(await page.locator(".chat-message.assistant .chat-content").textContent(), "この記事の重要点はローカル処理です。");
  chatShouldFail = true;
  await page.locator(".article-card", { hasText: "Second" }).click();
  await page.locator("#chat-question").fill("失敗する質問");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/operations/article.chat.ask")),
    page.locator("#article-chat button[type=submit]").click(),
  ]);
  assert.match(await page.locator("#article-chat .chat-error").textContent() ?? "", /HTTP 503/);
  assert.equal(await page.locator(".reader-content h1").textContent(), "Second");
  assert.equal(database.prepare("SELECT count(*) AS count FROM article_chat_messages WHERE item_id=2").get()?.count, 0);

  await page.locator(".discover").click();
  await page.locator("#source-input").fill("https://example.com/feed.xml");
  await page.locator("#source-form button[type=submit]").click();
  await page.locator("#confirm-source").click();
  await waitUntil(() => database.prepare("SELECT count(*) count FROM sources").get()?.count === 1);
  await page.waitForFunction(() => document.querySelector("#source-message")?.textContent?.includes("追加しました"));
  assert.match(await page.locator("#source-message").textContent() ?? "", /追加しました/);
  assert.equal(await page.locator("#source-list .source span").textContent(), "New source");
});
