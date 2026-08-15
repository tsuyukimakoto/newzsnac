import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";
import { EnrichmentService } from "../enrichment/service.js";
import { RecommendationService } from "../recommendation/service.js";
import type { ProcessingState } from "../reading/service.js";
import type { Fetch } from "../sources/resolver.js";
import { articleContentMetadata, extractArticle } from "./normalize.js";

interface RecoveryRow {
  readonly canonical_url: string;
  readonly extraction_status: string;
  readonly published_at: string | null;
  readonly base_priority: number;
}

export interface ArticleRecoveryResult {
  readonly articleId: number;
  readonly retried: boolean;
  readonly processingState: ProcessingState;
}

export class ArticleRecoveryService {
  private readonly enrichment: EnrichmentService;
  private readonly recommendations: RecommendationService;

  constructor(
    private readonly database: DatabaseSync,
    config: AppConfig,
    private readonly fetcher: Fetch = globalThis.fetch,
  ) {
    this.enrichment = new EnrichmentService(database);
    this.recommendations = new RecommendationService(database, config);
  }

  async retry(itemId: number, now = new Date()): Promise<ArticleRecoveryResult> {
    const item = this.item(itemId);
    if (item.extraction_status !== "failed") {
      return { articleId: itemId, retried: false, processingState: this.processingState(itemId) };
    }

    const content = await extractArticle(item.canonical_url, this.fetcher);
    if (!content.trim()) throw new Error("Article did not contain extractable text");
    const metadata = articleContentMetadata(content);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.item(itemId);
      if (current.extraction_status !== "failed") {
        this.database.exec("COMMIT");
        return { articleId: itemId, retried: false, processingState: this.processingState(itemId) };
      }
      this.database.prepare(`
        UPDATE items SET extracted_content = ?, content_hash = ?, extraction_status = 'available',
          estimated_reading_minutes = ?, updated_at = ? WHERE id = ? AND extraction_status = 'failed'
      `).run(content, metadata.hash, metadata.readingMinutes, now.toISOString(), itemId);
      this.enrichment.ensureAnalysisQueued(itemId, current.base_priority, current.published_at, now);
      this.recommendations.ensureEmbeddingQueued(itemId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return { articleId: itemId, retried: true, processingState: this.processingState(itemId) };
  }

  private item(itemId: number): RecoveryRow {
    const row = this.database.prepare(`
      SELECT i.canonical_url, i.extraction_status, i.published_at,
        coalesce(max(s.base_priority), 50) AS base_priority
      FROM items i
      LEFT JOIN source_items si ON si.item_id = i.id
      LEFT JOIN sources s ON s.id = si.source_id
      WHERE i.id = ?
      GROUP BY i.id
    `).get(itemId) as unknown as RecoveryRow | undefined;
    if (!row) throw new Error("Article not found");
    return row;
  }

  private processingState(itemId: number): ProcessingState {
    const row = this.database.prepare(`
      SELECT CASE
        WHEN extraction_status = 'failed' THEN 'failed'
        WHEN EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id = items.id AND a.kind = 'analysis') THEN 'ready'
        ELSE 'pending'
      END AS processing_state
      FROM items WHERE id = ?
    `).get(itemId);
    if (!row) throw new Error("Article not found");
    return String(row.processing_state) as ProcessingState;
  }
}
