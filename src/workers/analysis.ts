import { loadConfig, type AppConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { runAnalysisCycle } from "./services.js";
import { createOperationalLogger, formatDuration, shortenLogText, type OperationalLogger } from "../logging.js";
import type { ArticleAnalysisCompletedEvent } from "../enrichment/service.js";

const WATCH_INTERVAL_MS = 2_000;

export async function startAnalysisWorker(config: AppConfig, watch = false): Promise<void> {
  const database = openDatabase(config.databasePath);
  const logger = createOperationalLogger();
  process.stdout.write(`${JSON.stringify({ service: "analysis-worker", status: "ready", watch })}\n`);
  try {
    do {
      await runAnalysisCycle(database, config, globalThis.fetch, 25, (event) => logAnalysisCompleted(logger, event));
      if (watch) await delay(WATCH_INTERVAL_MS);
    } while (watch);
  } finally {
    database.close();
  }
}

export function logAnalysisCompleted(logger: OperationalLogger, event: ArticleAnalysisCompletedEvent): void {
  logger.info("analysis.complete", {
    article: event.articleId,
    title: shortenLogText(event.title, 80),
    duration: formatDuration(event.durationMs),
    ...(event.tokensPerSecond === undefined ? {} : { "tok/s": Number(event.tokensPerSecond.toFixed(1)) }),
    score: event.priority,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.filename === process.argv[1]) {
  startAnalysisWorker(loadConfig(), process.argv.includes("--watch")).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
