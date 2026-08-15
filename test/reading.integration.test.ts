import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { ReadingService } from "../src/reading/service.js";

function insertItem(database: ReturnType<typeof openDatabase>, id: number, discoveredAt: string, minutes: number): void {
  database.prepare(`
    INSERT INTO items(id, canonical_url, title, published_at, discovered_at, feed_content,
      extraction_status, estimated_reading_minutes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
  `).run(id, `https://example.com/${id}`, `Article ${id}`, discoveredAt, discoveredAt,
    `searchable body ${id}`, minutes, discoveredAt, discoveredAt);
}

test("reading sessions retain order and position when newer items arrive", () => {
  const database = openDatabase(":memory:");
  try {
    insertItem(database, 1, "2026-08-14T22:00:00Z", 4);
    insertItem(database, 2, "2026-08-14T23:00:00Z", 6);
    const reading = new ReadingService(database);
    const baseline = new Date("2026-08-15T00:00:00Z");
    const sessionId = reading.createSession({}, "newest", baseline);
    reading.updateSession(sessionId, 1, 240);
    const before = reading.resumeSession(sessionId);
    assert.deepEqual(before.articles.map((item) => item.id), [2, 1]);

    insertItem(database, 3, "2026-08-15T01:00:00Z", 2);
    const resumed = reading.resumeSession(sessionId);
    assert.deepEqual(resumed.articles.map((item) => item.id), [2, 1]);
    assert.equal(resumed.currentItemId, 1);
    assert.equal(resumed.scrollOffset, 240);
    assert.deepEqual(reading.list({ sort: "newest" }).map((item) => item.id), [3, 2, 1]);
  } finally { database.close(); }
});

test("scrolling alone stays unread while defined actions update state", () => {
  const database = openDatabase(":memory:");
  try {
    insertItem(database, 1, "2026-08-14T22:00:00Z", 4);
    const reading = new ReadingService(database);
    reading.recordScrollOnly(1);
    assert.equal(reading.list()[0]?.isRead, false);
    reading.advanceFrom(1);
    assert.equal(reading.list()[0]?.isRead, true);
    reading.setSaved(1, true);
    reading.setInterest(1, "interested");
    assert.equal(reading.list()[0]?.isSaved, true);
  } finally { database.close(); }
});

test("search, smart views, and time budgets work without LM Studio or external network", () => {
  const database = openDatabase(":memory:");
  try {
    insertItem(database, 1, "2026-08-14T22:00:00Z", 4);
    insertItem(database, 2, "2026-08-14T23:00:00Z", 6);
    const reading = new ReadingService(database);
    assert.deepEqual(reading.search("searchable").map((item) => item.id).sort(), [1, 2]);
    const viewId = reading.saveSmartView("local", "body", "newest");
    assert.equal(reading.runSmartView(viewId).length, 2);
    assert.deepEqual(reading.list({ sort: "newest", timeBudgetMinutes: 6 }).map((item) => item.id), [2]);
    reading.setRead(1, true);
    reading.setSaved(2, true);
    assert.equal(reading.list().find((item) => item.id === 1)?.isRead, true);
    assert.equal(reading.list().find((item) => item.id === 2)?.isSaved, true);
  } finally { database.close(); }
});
