import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAppServer } from "../src/server.js";

test("keyboard-only reading, translation, saving, unread toggle, and search", async (context) => {
  const server = createAppServer(resolve(process.cwd(), "public"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/api/items*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      items: [
        { id: 1, source: "RSS", title: "First", summary: "Summary", content: "Body", url: "https://example.com/1" },
        { id: 2, source: "Zenn", title: "Second", summary: null, content: "Second body", url: "https://example.com/2" },
      ],
      nextCursor: null,
      newCount: 2,
    }),
  }));
  await page.goto(`http://127.0.0.1:${address.port}`);

  assert.equal(await page.locator(".reader-content h1").textContent(), "First");
  await page.keyboard.press("j");
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  await page.locator("#search").focus();
  await page.keyboard.type("j");
  assert.equal(await page.locator(".article-card.selected h2").textContent(), "Second");
  await page.locator("#search").press("Escape");
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#mode").textContent(), "精読モード");
  await page.keyboard.press("s");
  await page.keyboard.press("u");
  await page.keyboard.press("t");
  assert.equal(await page.locator(".article-card.selected .badge").textContent(), "翻訳中");
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "search");
});
