import type { DatabaseSync } from "node:sqlite";
import { FeedAdapter, HackerNewsAdapter, BlueskyAdapter } from "../collection/adapters.js";
import { CollectionCoordinator, type CollectionOutcome } from "../collection/coordinator.js";
import { extractArticle, ItemRepository } from "../collection/normalize.js";
import type { CollectedItem } from "../collection/types.js";
import type { AppConfig } from "../config.js";
import { LmStudioClient } from "../enrichment/client.js";
import { EnrichmentService, EnrichmentWorker } from "../enrichment/service.js";
import { listLocalModels, selectLoadedModel } from "../enrichment/models.js";
import type { Fetch } from "../sources/resolver.js";
import { RecommendationService } from "../recommendation/service.js";

interface SourceSettingsRow {
  base_priority: number;
  fetch_full_text: number;
}

export interface CollectionCycleResult {
  readonly outcomes: readonly CollectionOutcome[];
  readonly collected: number;
  readonly failedSources: number;
}

export async function runCollectionCycle(
  database: DatabaseSync,
  _config: AppConfig,
  fetcher: Fetch = globalThis.fetch,
  clock = () => new Date(),
): Promise<CollectionCycleResult> {
  const repository = new ItemRepository(database);
  const enrichment = new EnrichmentService(database);
  const store = async (sourceId: number, items: readonly CollectedItem[]): Promise<void> => {
    const source = database.prepare(
      "SELECT base_priority, fetch_full_text FROM sources WHERE id = ?",
    ).get(sourceId) as unknown as SourceSettingsRow;
    for (const item of items) {
      let extracted: string | undefined;
      if (source.fetch_full_text && /^https?:/i.test(item.url)) {
        try {
          extracted = await extractArticle(item.url, fetcher);
        } catch {
          // A feed body is still useful offline; the failed state is recorded only when neither body exists.
        }
      }
      const itemId = repository.save(sourceId, item, extracted);
      const hasContent = Boolean(extracted ?? item.feedContent);
      if (!hasContent) repository.markExtractionFailed(itemId);
      if (hasContent) {
        enrichment.ensureAnalysisQueued(itemId, source.base_priority, item.publishedAt ?? null, clock());
        new RecommendationService(database, _config).ensureEmbeddingQueued(itemId);
      }
    }
  };
  const coordinator = new CollectionCoordinator(database, [
    new FeedAdapter(fetcher, clock),
    new HackerNewsAdapter(fetcher, 30, clock),
    new BlueskyAdapter(fetcher, clock),
  ], clock, store);
  const outcomes = await coordinator.collectDue();
  return {
    outcomes,
    collected: outcomes.reduce((sum, outcome) => sum + outcome.collected, 0),
    failedSources: outcomes.filter((outcome) => outcome.error).length,
  };
}

export async function runAnalysisCycle(
  database: DatabaseSync,
  config: AppConfig,
  fetcher: Fetch = globalThis.fetch,
  maxJobs = 25,
): Promise<{ readonly processed: number }> {
  let modelId = config.lmStudioModel;
  try {
    modelId = selectLoadedModel(modelId, await listLocalModels(config.lmStudioUrl, fetcher));
  } catch {
    // The queued job remains retryable when LM Studio is unavailable.
  }
  const worker = new EnrichmentWorker(
    database,
    new LmStudioClient(config.lmStudioUrl, fetcher, config.analysisMaxCharacters),
    `analysis-${process.pid}`,
    new RecommendationService(database, config),
  );
  new RecommendationService(database, config).enqueueMissingEmbeddings(maxJobs);
  let processed = 0;
  while (processed < maxJobs && await worker.runOne(modelId, config.analysisPromptVersion)) {
    processed += 1;
  }
  return { processed };
}
