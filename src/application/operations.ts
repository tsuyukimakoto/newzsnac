import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";
import { DiscoveryService } from "../discovery/service.js";
import { EnrichmentService } from "../enrichment/service.js";
import { listLocalModels, selectLoadedModel } from "../enrichment/models.js";
import { ReadingService, type ProcessingState } from "../reading/service.js";
import { SourceResolver, type Fetch } from "../sources/resolver.js";
import { SourceService, type SourceSettings } from "../sources/service.js";
import { RecommendationService } from "../recommendation/service.js";
import { ArticleChatService } from "../chat/service.js";
import { LmStudioClient } from "../enrichment/client.js";
import { ArticleRecoveryService } from "../collection/recovery.js";

export const operationNames = [
  "source.resolve", "source.preview", "source.add", "source.pause", "source.resume",
  "source.list", "candidate.list", "candidate.dismiss", "article.list", "article.search", "article.save", "article.read", "article.interest", "article.translate", "article.retry",
  "article.chat.list", "article.chat.ask", "article.chat.handoff",
  "dashboard.summary", "runtime.status",
] as const;

export type OperationName = typeof operationNames[number];
export type OperationCaller = "web" | "cli" | "openclaw";

export type OperationResult =
  | { readonly ok: true; readonly operation: OperationName; readonly data: unknown }
  | { readonly ok: false; readonly operation: string; readonly error: { readonly code: string; readonly message: string } };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("input must be a JSON object");
  return value as Record<string, unknown>;
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function integer(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${key} must be a positive integer`);
  return Number(value);
}

const mutatingOperations = new Set<OperationName>([
  "source.add", "source.pause", "source.resume", "candidate.dismiss",
  "article.save", "article.read", "article.translate",
  "article.interest",
  "article.retry",
  "article.chat.ask",
]);

export class ApplicationOperations {
  constructor(
    private readonly database: DatabaseSync,
    private readonly resolver: SourceResolver,
    private readonly sources: SourceService,
    private readonly discovery: DiscoveryService,
    private readonly reading: ReadingService,
    private readonly enrichment: EnrichmentService,
    private readonly recommendations: RecommendationService,
    private readonly recovery: ArticleRecoveryService,
    private readonly chat: ArticleChatService,
    private readonly config: AppConfig,
    private readonly fetcher: Fetch,
  ) {}

  async execute(operation: string, rawInput: unknown, caller: OperationCaller): Promise<OperationResult> {
    if (!operationNames.includes(operation as OperationName)) {
      return { ok: false, operation, error: { code: "unknown_operation", message: `Unknown operation: ${operation}` } };
    }
    const name = operation as OperationName;
    try {
      const input = record(rawInput);
      const data = await this.perform(name, input, caller);
      return { ok: true, operation: name, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mutatingOperations.has(name)) this.audit(name, targetFor(name, rawInput), caller, "error", { message });
      return { ok: false, operation: name, error: { code: "invalid_operation", message } };
    }
  }

  private async perform(name: OperationName, input: Record<string, unknown>, caller: OperationCaller): Promise<unknown> {
    switch (name) {
      case "source.resolve": return this.resolver.resolve(text(input, "input"));
      case "source.preview": return this.sources.resolveAndPreview(text(input, "input"));
      case "source.add": {
        const resolved = await this.resolver.resolve(text(input, "input"));
        return this.mutate(name, resolved.canonicalUrl, caller, () => this.sources.add(resolved, settings(input.settings)));
      }
      case "source.pause": {
        const id = integer(input, "sourceId");
        return this.mutate(name, String(id), caller, () => { this.sources.pause(id); return { sourceId: id, status: "paused" }; });
      }
      case "source.resume": {
        const id = integer(input, "sourceId");
        return this.mutate(name, String(id), caller, () => { this.sources.resume(id); return { sourceId: id, status: "active" }; });
      }
      case "source.list": return this.listSources();
      case "candidate.dismiss": {
        const id = integer(input, "candidateId");
        return this.mutate(name, String(id), caller, () => { this.discovery.dismiss(id); return { candidateId: id, status: "dismissed" }; });
      }
      case "candidate.list": return this.discovery.visible();
      case "article.list": {
        const sourceId = optionalInteger(input, "sourceId");
        const saved = optionalBoolean(input, "saved");
        const interested = optionalBoolean(input, "interested");
        const recommended = optionalBoolean(input, "recommended");
        const unread = optionalBoolean(input, "unread");
        const processingState = optionalProcessingState(input, "processingState");
        return this.reading.list({
          ...(sourceId === undefined ? {} : { sourceId }),
          ...(saved === undefined ? {} : { saved }),
          ...(interested === undefined ? {} : { interested }),
          ...(recommended === undefined ? {} : { recommended }),
          ...(unread === undefined ? {} : { unread }),
          ...(processingState === undefined ? {} : { processingState }),
        });
      }
      case "article.search": {
        const unread = optionalBoolean(input, "unread");
        const processingState = optionalProcessingState(input, "processingState");
        return this.reading.search(text(input, "query"), {
          ...(unread === undefined ? {} : { unread }),
          ...(processingState === undefined ? {} : { processingState }),
        });
      }
      case "article.save": {
        const id = integer(input, "articleId"); const saved = boolean(input, "saved");
        return this.mutate(name, String(id), caller, () => { this.reading.setSaved(id, saved); return { articleId: id, saved }; });
      }
      case "article.read": {
        const id = integer(input, "articleId"); const read = boolean(input, "read");
        return this.mutate(name, String(id), caller, () => { this.reading.setRead(id, read); return { articleId: id, read }; });
      }
      case "article.interest": {
        const id = integer(input, "articleId"); const interested = boolean(input, "interested");
        return this.mutate(name, String(id), caller, () => {
          const interest = interested ? "interested" : null;
          this.reading.setInterest(id, interest);
          this.recommendations.onInterestChanged(id, interest);
          return { articleId: id, interested };
        });
      }
      case "article.translate": {
        const id = integer(input, "articleId");
        const modelId = optionalText(input, "modelId") ?? await this.activeModelId();
        const promptVersion = optionalText(input, "promptVersion") ?? this.config.translationPromptVersion;
        return this.mutate(name, String(id), caller, () => this.enrichment.requestTranslation(id, modelId, promptVersion));
      }
      case "article.retry": {
        const id = integer(input, "articleId");
        const result = await this.recovery.retry(id);
        this.audit(name, String(id), caller, "success", result);
        return result;
      }
      case "article.chat.list": return this.chat.list(integer(input, "articleId"));
      case "article.chat.ask": {
        const id = integer(input, "articleId");
        const modelId = optionalText(input, "modelId") ?? await this.activeModelId();
        const result = await this.chat.ask(id, text(input, "question"), modelId);
        this.audit(name, String(id), caller, "success", { articleId: id, modelId, messageCount: result.messages.length });
        return result;
      }
      case "article.chat.handoff": return { text: this.chat.handoff(integer(input, "articleId")) };
      case "dashboard.summary": return this.dashboardSummary();
      case "runtime.status": return this.runtimeStatus();
    }
  }

  private dashboardSummary(): { total: number; unread: number; saved: number; interested: number; recommended: number; pending: number; failed: number; readingMinutes: number } {
    const row = this.database.prepare(`
      SELECT
        sum(CASE WHEN i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') THEN 1 ELSE 0 END) AS total,
        sum(CASE WHEN i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') AND coalesce(u.is_read, 0) = 0 THEN 1 ELSE 0 END) AS unread,
        sum(CASE WHEN i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') AND coalesce(u.is_saved, 0) = 1 THEN 1 ELSE 0 END) AS saved,
        sum(CASE WHEN i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') AND u.interest = 'interested' THEN 1 ELSE 0 END) AS interested,
        sum(CASE WHEN i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') AND r.target_item_id IS NOT NULL AND coalesce(u.is_read, 0) = 0 AND u.interest IS NULL THEN 1 ELSE 0 END) AS recommended,
        sum(CASE WHEN i.extraction_status != 'failed' AND NOT EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN i.extraction_status = 'failed' THEN 1 ELSE 0 END) AS failed,
        sum(CASE WHEN i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') AND coalesce(u.is_read, 0) = 0 THEN coalesce(i.estimated_reading_minutes, 5) ELSE 0 END) AS reading_minutes
      FROM items i LEFT JOIN item_user_states u ON u.item_id = i.id
      LEFT JOIN item_recommendations r ON r.target_item_id = i.id AND r.model_id = ? AND r.input_version = ?
        AND r.score >= ?
    `).get(this.config.embeddingModel ?? "__disabled__", this.config.embeddingInputVersion,
      this.config.recommendationSimilarityThreshold);
    return {
      total: Number(row?.total ?? 0),
      unread: Number(row?.unread ?? 0),
      saved: Number(row?.saved ?? 0),
      interested: Number(row?.interested ?? 0),
      recommended: Number(row?.recommended ?? 0),
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      readingMinutes: Number(row?.reading_minutes ?? 0),
    };
  }

  private listSources(): readonly unknown[] {
    return this.database.prepare(`
      SELECT s.id, s.kind, s.display_name AS displayName, s.status,
        sum(CASE WHEN si.item_id IS NOT NULL AND i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') THEN 1 ELSE 0 END) AS total,
        sum(CASE WHEN si.item_id IS NOT NULL AND i.extraction_status != 'failed' AND EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id=i.id AND a.kind='analysis') AND coalesce(u.is_read, 0) = 0 THEN 1 ELSE 0 END) AS unread,
        s.last_checked_at AS lastCheckedAt, s.next_fetch_at AS nextFetchAt,
        s.failure_count AS failureCount, s.last_error AS lastError
      FROM sources s
      LEFT JOIN source_items si ON si.source_id = s.id
      LEFT JOIN items i ON i.id = si.item_id
      LEFT JOIN item_user_states u ON u.item_id = si.item_id
      GROUP BY s.id ORDER BY lower(s.display_name), s.id
    `).all().map((row) => ({ ...row, id: Number(row.id), total: Number(row.total), unread: Number(row.unread) }));
  }

  private async runtimeStatus(): Promise<unknown> {
    const embeddingCounts = this.database.prepare(`
      SELECT count(*) AS embedded,
        (SELECT count(*) FROM jobs WHERE type = 'embedding' AND status IN ('pending','running','retry_wait')) AS pending,
        (SELECT count(*) FROM item_recommendations r
          JOIN items i ON i.id = r.target_item_id
          LEFT JOIN item_user_states u ON u.item_id = i.id
          WHERE r.model_id = ? AND r.input_version = ? AND r.score >= ?
            AND coalesce(u.is_read, 0) = 0 AND u.interest IS NULL) AS recommendations
      FROM item_embeddings WHERE model_id = ? AND input_version = ?
    `).get(this.config.embeddingModel ?? "__disabled__", this.config.embeddingInputVersion,
      this.config.recommendationSimilarityThreshold,
      this.config.embeddingModel ?? "__disabled__", this.config.embeddingInputVersion);
    try {
      const models = await listLocalModels(this.config.lmStudioUrl, this.fetcher);
      return {
        sqlite: "connected", lmStudio: "connected", configuredModel: this.config.lmStudioModel,
        activeModel: selectLoadedModel(this.config.lmStudioModel, models), models,
        embedding: { configured: Boolean(this.config.embeddingModel), model: this.config.embeddingModel,
          embedded: Number(embeddingCounts?.embedded ?? 0), pending: Number(embeddingCounts?.pending ?? 0), recommendations: Number(embeddingCounts?.recommendations ?? 0) },
      };
    } catch (error) {
      return {
        sqlite: "connected", lmStudio: "unavailable", configuredModel: this.config.lmStudioModel,
        message: error instanceof Error ? error.message : String(error),
        embedding: { configured: Boolean(this.config.embeddingModel), model: this.config.embeddingModel,
          embedded: Number(embeddingCounts?.embedded ?? 0), pending: Number(embeddingCounts?.pending ?? 0), recommendations: Number(embeddingCounts?.recommendations ?? 0) },
      };
    }
  }

  private async activeModelId(): Promise<string> {
    try {
      return selectLoadedModel(this.config.lmStudioModel, await listLocalModels(this.config.lmStudioUrl, this.fetcher));
    } catch {
      return this.config.lmStudioModel;
    }
  }

  private mutate<T>(operation: OperationName, target: string, caller: OperationCaller, action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.audit(operation, target, caller, "success", result);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private audit(operation: string, target: string, caller: OperationCaller, result: string, details: unknown): void {
    this.database.prepare(`
      INSERT INTO action_history(action, target_type, target_id, caller, occurred_at, result, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(operation, operation.split(".")[0]!, target, caller, new Date().toISOString(), result, JSON.stringify(details));
  }
}

function boolean(input: Record<string, unknown>, key: string): boolean {
  if (typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  return input[key];
}

function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  if (input[key] === undefined) return undefined;
  return integer(input, key);
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  if (input[key] === undefined) return undefined;
  return boolean(input, key);
}

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
  if (input[key] === undefined) return undefined;
  return text(input, key);
}

function optionalProcessingState(input: Record<string, unknown>, key: string): ProcessingState | undefined {
  if (input[key] === undefined) return undefined;
  if (input[key] === "ready" || input[key] === "pending" || input[key] === "failed") return input[key];
  throw new Error(`${key} must be ready, pending, or failed`);
}

function settings(value: unknown): SourceSettings {
  if (value === undefined) return {};
  return record(value) as SourceSettings;
}

function targetFor(operation: OperationName, rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== "object") return "unknown";
  const input = rawInput as Record<string, unknown>;
  return String(input.sourceId ?? input.candidateId ?? input.articleId ?? input.input ?? "unknown");
}

export function createApplicationOperations(database: DatabaseSync, config: AppConfig, fetcher: Fetch = globalThis.fetch): ApplicationOperations {
  const resolver = new SourceResolver(fetcher);
  const sources = new SourceService(database, resolver);
  const recommendations = new RecommendationService(database, config);
  const chat = new ArticleChatService(database, new LmStudioClient(config.lmStudioUrl, fetcher), config.chatContextMaxCharacters);
  return new ApplicationOperations(
    database, resolver, sources, new DiscoveryService(database, resolver, sources),
    new ReadingService(database, config.embeddingModel ?? "__disabled__", config.embeddingInputVersion,
      config.recommendationSimilarityThreshold),
    new EnrichmentService(database), recommendations, new ArticleRecoveryService(database, config, fetcher),
    chat, config, fetcher,
  );
}
