import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationalLogger, formatDuration, shortenLogText } from "../src/logging.js";
import { logAnalysisCompleted, logRecommendationCompleted } from "../src/workers/analysis.js";
import { logCollectionCycle } from "../src/workers/collection.js";
import { startCollectionWorker } from "../src/workers/collection.js";
import { startAnalysisWorker, logJobFailed } from "../src/workers/analysis.js";
import { loadConfig } from "../src/config.js";

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

test("operational logger filters by minimum level and separates output streams", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logger = createOperationalLogger({
    minimumLevel: "info",
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    clock: () => new Date(2026, 7, 23, 9, 8, 6),
  });

  logger.debug("worker.poll", { processed: 0 });
  logger.info("worker.ready");
  logger.warn("source.failed");
  logger.error("job.failed");

  assert.deepEqual(stdout, ["[08-23 09:08:06] INFO worker.ready\n"]);
  assert.deepEqual(stderr, [
    "[08-23 09:08:06] WARN source.failed\n",
    "[08-23 09:08:06] ERROR job.failed\n",
  ]);
});

test("operational logger honors debug, warn, and error thresholds", () => {
  for (const [minimumLevel, expected] of [
    ["debug", ["DEBUG", "INFO", "WARN", "ERROR"]],
    ["warn", ["WARN", "ERROR"]],
    ["error", ["ERROR"]],
  ] as const) {
    const lines: string[] = [];
    const logger = createOperationalLogger({
      minimumLevel,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    logger.debug("test"); logger.info("test"); logger.warn("test"); logger.error("test");
    assert.deepEqual(lines.map((line) => line.match(/] (DEBUG|INFO|WARN|ERROR) /)?.[1]), expected);
  }
});

test("workers report readiness at INFO and empty polling at DEBUG", async () => {
  const lines: string[] = [];
  const logger = createOperationalLogger({
    minimumLevel: "debug",
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
  const config = loadConfig({ NEWSZNAC_DATABASE_PATH: ":memory:", NEWSZNAC_LOG_LEVEL: "debug" });

  await startCollectionWorker(config, false, logger);
  await startAnalysisWorker(config, false, logger);

  assert.ok(lines.some((line) => line.includes("INFO collection.ready watch=false")));
  assert.ok(lines.some((line) => line.includes("DEBUG collection.poll sources=0 articles=0 duration=")));
  assert.ok(lines.some((line) => line.includes("INFO analysis.ready watch=false")));
  assert.ok(lines.some((line) => line.includes("DEBUG analysis.poll processed=0 duration=")));
});

test("job failures are ERROR logs with retry context", () => {
  const lines: string[] = [];
  const logger = createOperationalLogger({ stderr: (line) => lines.push(line) });
  logJobFailed(logger, {
    jobType: "analysis", jobId: 9, articleId: 42, attempt: 2, maxAttempts: 5,
    retrying: true, error: "LM Studio unavailable",
  });
  assert.match(lines[0]!, /ERROR job\.failed type="analysis" job=9 article=42 attempt="2\/5" retrying=true error="LM Studio unavailable"/);
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

  assert.equal(lines[0], `[08-23 11:00:00] INFO analysis.complete article=7 title=${JSON.stringify(shortenLogText(title, 80))} duration=\"9.88s\" tok/s=32.5 priority=91\n`);
  assert.equal(lines[1], "[08-23 11:00:00] INFO analysis.complete article=8 title=\"No stats\" duration=\"500ms\" priority=40\n");
});

test("recommendation logging distinguishes target, source, and similarity score", () => {
  const lines: string[] = [];
  const logger = createOperationalLogger((line) => lines.push(line), () => new Date(2026, 7, 23, 12, 0, 0));

  logRecommendationCompleted(logger, {
    articleId: 12, sourceArticleId: 4, durationMs: 12, score: 0.912_34,
  });
  logRecommendationCompleted(logger, {
    articleId: 13, sourceArticleId: 4, durationMs: 8, score: -1,
  });

  assert.deepEqual(lines, [
    "[08-23 12:00:00] INFO recommendation.complete article=12 source=4 duration=\"12ms\" score=0.912\n",
    "[08-23 12:00:00] INFO recommendation.complete article=13 source=4 duration=\"8ms\" score=-1\n",
  ]);
});
