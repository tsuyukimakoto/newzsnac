import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationalLogger, formatDuration, shortenLogText } from "../src/logging.js";
import { logAnalysisCompleted } from "../src/workers/analysis.js";
import { logCollectionCycle } from "../src/workers/collection.js";

test("operational logger writes a short local timestamp and safe one-line fields", () => {
  const lines: string[] = [];
  const logger = createOperationalLogger(
    (line) => lines.push(line),
    () => new Date(2026, 7, 23, 9, 7, 5),
  );

  logger.info("analysis.complete", { article: 42, title: "one\n  two", speed: undefined, score: 82 });

  assert.deepEqual(lines, [
    "[08-23 09:07:05] INFO analysis.complete article=42 title=\"one two\" score=82\n",
  ]);
  assert.equal(formatDuration(87), "87ms");
  assert.equal(formatDuration(1_234), "1.23s");
  assert.equal(shortenLogText(`  ${"a".repeat(90)}\n`, 20), `${"a".repeat(19)}…`);
});

test("collection logging summarizes work, reports failures, and skips empty polling", () => {
  const lines: string[] = [];
  const logger = createOperationalLogger((line) => lines.push(line), () => new Date(2026, 7, 23, 10, 0, 0));

  logCollectionCycle(logger, {
    outcomes: [
      { sourceId: 1, collected: 12, newItems: 4 },
      { sourceId: 2, collected: 0, newItems: 0, error: "timed\nout" },
    ],
    sourcesChecked: 2,
    collected: 12,
    newArticles: 4,
    failedSources: 1,
    durationMs: 1_234,
  });
  logCollectionCycle(logger, {
    outcomes: [], sourcesChecked: 0, collected: 0, newArticles: 0, failedSources: 0, durationMs: 1,
  });

  assert.deepEqual(lines, [
    "[08-23 10:00:00] WARN collection.source-failed source=2 error=\"timed out\"\n",
    "[08-23 10:00:00] INFO collection.complete sources=2 articles=12 new=4 failed=1 duration=\"1.23s\"\n",
  ]);
});

test("analysis logging includes server speed when present and omits it otherwise", () => {
  const lines: string[] = [];
  const logger = createOperationalLogger((line) => lines.push(line), () => new Date(2026, 7, 23, 11, 0, 0));
  const title = `Long\n${"title ".repeat(20)}`;

  logAnalysisCompleted(logger, { articleId: 7, title, durationMs: 9_876, priority: 91, tokensPerSecond: 32.46 });
  logAnalysisCompleted(logger, { articleId: 8, title: "No stats", durationMs: 500, priority: 40 });

  assert.equal(lines[0], `[08-23 11:00:00] INFO analysis.complete article=7 title=${JSON.stringify(shortenLogText(title, 80))} duration=\"9.88s\" tok/s=32.5 score=91\n`);
  assert.equal(lines[1], "[08-23 11:00:00] INFO analysis.complete article=8 title=\"No stats\" duration=\"500ms\" score=40\n");
});
