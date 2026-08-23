import { loadConfig, type AppConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { createAnalysisLogger, runAnalysisCycle } from "./services.js";
import { createOperationalLogger, errorMessage, formatDuration, shortenLogText, type OperationalLogger } from "../logging.js";
import type { ArticleAnalysisCompletedEvent, JobFailedEvent, RecommendationCompletedEvent } from "../enrichment/service.js";

const WATCH_INTERVAL_MS = 2_000;

export async function startAnalysisWorker(
  config: AppConfig,
  watch = false,
  logger: OperationalLogger = createOperationalLogger({ minimumLevel: config.logLevel }),
): Promise<void> {
  const database = openDatabase(config.databasePath);
  logger.info("analysis.ready", { watch });
  try {
    do {
      const startedAt = Date.now();
      const result = await runAnalysisCycle(database, config, globalThis.fetch, 25, {
        analysisCompleted: (event) => logAnalysisCompleted(logger, event),
        recommendationCompleted: (event) => logRecommendationCompleted(logger, event),
        jobFailed: (event) => logJobFailed(logger, event),
      }, Date.now, createAnalysisLogger(config.analysisTelemetryEnabled, logger));
      logger.debug("analysis.poll", {
        processed: result.processed,
        duration: formatDuration(Date.now() - startedAt),
      });
      if (watch) await delay(WATCH_INTERVAL_MS);
    } while (watch);
  } finally {
    database.close();
  }
}

export function logJobFailed(logger: OperationalLogger, event: JobFailedEvent): void {
  logger.error("job.failed", {
    type: event.jobType,
    job: event.jobId,
    article: event.articleId,
    attempt: `${event.attempt}/${event.maxAttempts}`,
    retrying: event.retrying,
    error: event.error,
  });
}

export function logAnalysisCompleted(logger: OperationalLogger, event: ArticleAnalysisCompletedEvent): void {
  logger.info("analysis.complete", {
    article: event.articleId,
    title: shortenLogText(event.title, 80),
    duration: formatDuration(event.durationMs),
    ...(event.tokensPerSecond === undefined ? {} : { "tok/s": Number(event.tokensPerSecond.toFixed(1)) }),
    priority: event.priority,
  });
}

export function logRecommendationCompleted(logger: OperationalLogger, event: RecommendationCompletedEvent): void {
  logger.info("recommendation.complete", {
    article: event.articleId,
    source: event.sourceArticleId,
    duration: formatDuration(event.durationMs),
    score: Number(event.score.toFixed(3)),
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
    startAnalysisWorker(config, process.argv.includes("--watch"), logger).catch((error) => {
      logger.error("analysis.fatal", { error: errorMessage(error) });
      process.exitCode = 1;
    });
  } catch (error) {
    logger.error("analysis.start-failed", { error: errorMessage(error) });
    process.exitCode = 1;
  }
}
