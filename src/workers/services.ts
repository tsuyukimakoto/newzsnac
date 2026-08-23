import type { DatabaseSync } from "node:sqlite";
import { FeedAdapter, HackerNewsAdapter, BlueskyAdapter } from "../collection/adapters.js";
import { CollectionCoordinator, type CollectionOutcome } from "../collection/coordinator.js";
import { extractArticle, ItemRepository } from "../collection/normalize.js";
import type { CollectedItem } from "../collection/types.js";
import type { AppConfig } from "../config.js";
import { LmStudioClient, type AnalysisLogger } from "../enrichment/client.js";
import { EnrichmentService, EnrichmentWorker, type EnrichmentWorkerObservers } from "../enrichment/service.js";
import { listLocalModels, selectLoadedModel } from "../enrichment/models.js";
import type { Fetch } from "../sources/resolver.js";
import { RecommendationService } from "../recommendation/service.js";
import type { OperationalLogger } from "../logging.js";

interface SourceSettingsRow {
  base_priority: number;
  fetch_full_text: number;
}

export interface CollectionCycleResult {
  readonly outcomes: readonly CollectionOutcome[];
  readonly sourcesChecked: number;
  readonly collected: number;
  readonly newArticles: number;
  readonly failedSources: number;
  readonly durationMs: number;
}

export async function runCollectionCycle(
  database: DatabaseSync,
  _config: AppConfig,
  fetcher: Fetch = globalThis.fetch,
  clock = () => new Date(),
  nowMilliseconds = Date.now,
): Promise<CollectionCycleResult> {
  const startedAt = nowMilliseconds();
  const repository = new ItemRepository(database);
  const enrichment = new EnrichmentService(database);
  const store = async (sourceId: number, items: readonly CollectedItem[]): Promise<number> => {
    const source = database.prepare(
      "SELECT base_priority, fetch_full_text FROM sources WHERE id = ?",
    ).get(sourceId) as unknown as SourceSettingsRow;
    let newItems = 0;
    for (const item of items) {
      let extracted: string | undefined;
      if (source.fetch_full_text && /^https?:/i.test(item.url)) {
        try {
          extracted = await extractArticle(item.url, fetcher);
        } catch {
          // A feed body is still useful offline; the failed state is recorded only when neither body exists.
        }
      }
      const saved = repository.saveWithStatus(sourceId, item, extracted);
      const itemId = saved.itemId;
      if (saved.created) newItems += 1;
      const hasContent = Boolean(extracted ?? item.feedContent);
      if (!hasContent) repository.markExtractionFailed(itemId);
      if (hasContent) {
        enrichment.ensureAnalysisQueued(itemId, source.base_priority, item.publishedAt ?? null, clock());
        new RecommendationService(database, _config).ensureEmbeddingQueued(itemId);
      }
    }
    return newItems;
  };
  const coordinator = new CollectionCoordinator(database, [
    new FeedAdapter(fetcher, clock),
    new HackerNewsAdapter(fetcher, 30, clock),
    new BlueskyAdapter(fetcher, clock),
  ], clock, store);
  const outcomes = await coordinator.collectDue();
  return {
    outcomes,
    sourcesChecked: outcomes.length,
    collected: outcomes.reduce((sum, outcome) => sum + outcome.collected, 0),
    newArticles: outcomes.reduce((sum, outcome) => sum + outcome.newItems, 0),
    failedSources: outcomes.filter((outcome) => outcome.error).length,
    durationMs: Math.max(0, Math.round(nowMilliseconds() - startedAt)),
  };
}

export async function runAnalysisCycle(
  database: DatabaseSync,
  config: AppConfig,
  fetcher: Fetch = globalThis.fetch,
  maxJobs = 25,
  observers: EnrichmentWorkerObservers = {},
  nowMilliseconds = Date.now,
  analysisLogger?: AnalysisLogger,
): Promise<{ readonly processed: number }> {
  let modelId = config.lmStudioModel;
  try {
    modelId = selectLoadedModel(modelId, await listLocalModels(config.lmStudioUrl, fetcher));
  } catch {
    // The queued job remains retryable when LM Studio is unavailable.
  }
  const worker = new EnrichmentWorker(
    database,
    new LmStudioClient(
      config.lmStudioUrl,
      fetcher,
      config.analysisMaxCharacters,
      config.lmStudioReasoningEffort,
      analysisLogger,
    ),
    `analysis-${process.pid}`,
    new RecommendationService(database, config),
    observers,
    nowMilliseconds,
  );
  new RecommendationService(database, config).enqueueMissingEmbeddings(maxJobs);
  let processed = 0;
  while (processed < maxJobs && await worker.runOne(modelId, config.analysisPromptVersion)) {
    processed += 1;
  }
  return { processed };
}

export function createAnalysisLogger(
  enabled: boolean,
  logger: Pick<OperationalLogger, "debug">,
): AnalysisLogger | undefined {
  if (!enabled) return undefined;
  return (event) => logger.debug("analysis.telemetry", {
    effort: event.effort,
    maxOutputTokens: event.maxOutputTokens,
    finishReason: event.finishReason,
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
    reasoningTokens: event.reasoningTokens,
    contentCharacters: event.contentCharacters,
    durationMs: event.durationMs,
    tokensPerSecond: event.tokensPerSecond,
    validation: event.validation,
    failure: event.failure,
  });
}
