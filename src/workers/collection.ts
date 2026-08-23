import { loadConfig, type AppConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { runCollectionCycle } from "./services.js";
import { createOperationalLogger, errorMessage, formatDuration, type OperationalLogger } from "../logging.js";

const WATCH_INTERVAL_MS = 10_000;

export async function startCollectionWorker(
  config: AppConfig,
  watch = false,
  logger: OperationalLogger = createOperationalLogger({ minimumLevel: config.logLevel }),
): Promise<void> {
  const database = openDatabase(config.databasePath);
  logger.info("collection.ready", { watch });
  try {
    do {
      const result = await runCollectionCycle(database, config);
      logger.debug("collection.poll", {
        sources: result.sourcesChecked,
        articles: result.collected,
        duration: formatDuration(result.durationMs),
      });
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
  let logger = createOperationalLogger();
  try {
    const config = loadConfig();
    logger = createOperationalLogger({ minimumLevel: config.logLevel });
    startCollectionWorker(config, process.argv.includes("--watch"), logger).catch((error) => {
      logger.error("collection.fatal", { error: errorMessage(error) });
      process.exitCode = 1;
    });
  } catch (error) {
    logger.error("collection.start-failed", { error: errorMessage(error) });
    process.exitCode = 1;
  }
}
