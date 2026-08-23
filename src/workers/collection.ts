import { loadConfig, type AppConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { runCollectionCycle } from "./services.js";
import { createOperationalLogger, formatDuration, type OperationalLogger } from "../logging.js";

const WATCH_INTERVAL_MS = 10_000;

export async function startCollectionWorker(config: AppConfig, watch = false): Promise<void> {
  const database = openDatabase(config.databasePath);
  const logger = createOperationalLogger();
  process.stdout.write(`${JSON.stringify({ service: "collection-worker", status: "ready", watch })}\n`);
  try {
    do {
      const result = await runCollectionCycle(database, config);
      logCollectionCycle(logger, result);
      if (watch) await delay(WATCH_INTERVAL_MS);
    } while (watch);
  } finally {
    database.close();
  }
}

export function logCollectionCycle(logger: OperationalLogger, result: Awaited<ReturnType<typeof runCollectionCycle>>): void {
  if (result.sourcesChecked === 0) return;
  for (const outcome of result.outcomes) {
    if (outcome.error) logger.warn("collection.source-failed", { source: outcome.sourceId, error: outcome.error });
  }
  logger.info("collection.complete", {
    sources: result.sourcesChecked,
    articles: result.collected,
    new: result.newArticles,
    failed: result.failedSources,
    duration: formatDuration(result.durationMs),
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.filename === process.argv[1]) {
  startCollectionWorker(loadConfig(), process.argv.includes("--watch")).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
