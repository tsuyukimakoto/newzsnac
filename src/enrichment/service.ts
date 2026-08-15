import type { DatabaseSync } from "node:sqlite";
import { JobQueue } from "../db/jobs.js";
import { LmStudioClient } from "./client.js";
import type { RecommendationService } from "../recommendation/service.js";

export function deterministicPreScore(basePriority: number, publishedAt: string | null, now = new Date()): number {
  const ageHours = publishedAt ? Math.max(0, (now.getTime() - Date.parse(publishedAt)) / 3_600_000) : 168;
  const recency = Math.max(0, 30 - Math.floor(ageHours / 8));
  return Math.max(0, Math.min(100, basePriority + recency));
}

export class EnrichmentService {
  private readonly queue: JobQueue;
  constructor(private readonly database: DatabaseSync) { this.queue = new JobQueue(database); }

  enqueueAnalysis(itemId: number, basePriority: number, publishedAt: string | null, now = new Date()): number {
    return this.queue.enqueue("analysis", { itemId }, {
      itemId,
      priority: deterministicPreScore(basePriority, publishedAt, now),
      availableAt: now,
    });
  }

  ensureAnalysisQueued(itemId: number, basePriority: number, publishedAt: string | null, now = new Date()): number | null {
    const existing = this.database.prepare(`
      SELECT 1 FROM item_analyses WHERE item_id = ? AND kind = 'analysis'
      UNION ALL
      SELECT 1 FROM jobs WHERE item_id = ? AND type = 'analysis'
        AND status IN ('pending', 'running', 'retry_wait') LIMIT 1
    `).get(itemId, itemId);
    return existing ? null : this.enqueueAnalysis(itemId, basePriority, publishedAt, now);
  }

  retryAnalysis(itemId: number, now = new Date()): { articleId: number; retried: boolean; processingState: "ready" | "pending" } {
    const item = this.database.prepare(`
      SELECT extraction_status, coalesce(extracted_content, feed_content) AS content,
        EXISTS(SELECT 1 FROM item_analyses a WHERE a.item_id = items.id AND a.kind = 'analysis') AS analysed
      FROM items WHERE id = ?
    `).get(itemId);
    if (!item) throw new Error("Article not found");
    if (item.extraction_status === "failed" || !String(item.content ?? "").trim()) {
      throw new Error("Article content is unavailable");
    }
    if (item.analysed) return { articleId: itemId, retried: false, processingState: "ready" };

    const active = this.database.prepare(`
      SELECT 1 FROM jobs WHERE item_id = ? AND type = 'analysis'
        AND status IN ('pending', 'running', 'retry_wait') LIMIT 1
    `).get(itemId);
    if (active) return { articleId: itemId, retried: false, processingState: "pending" };

    const failed = this.database.prepare(`
      SELECT id FROM jobs WHERE item_id = ? AND type = 'analysis' AND status = 'failed'
      ORDER BY id DESC LIMIT 1
    `).get(itemId);
    if (failed) {
      this.database.prepare(`
        UPDATE jobs SET status = 'pending', attempts = 0, available_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(now.toISOString(), now.toISOString(), Number(failed.id));
    } else {
      this.enqueueAnalysis(itemId, 50, null, now);
    }
    return { articleId: itemId, retried: true, processingState: "pending" };
  }

  requestTranslation(itemId: number, modelId: string, promptVersion: string): { status: "ready"; content: string } | { status: "queued"; jobId: number } {
    const cached = this.database.prepare(`
      SELECT translated_content FROM item_analyses
      WHERE item_id = ? AND kind = 'translation' AND model_id = ? AND prompt_version = ?
    `).get(itemId, modelId, promptVersion);
    if (cached?.translated_content) return { status: "ready", content: String(cached.translated_content) };
    const existing = this.database.prepare(`
      SELECT id FROM jobs WHERE type = 'translation' AND item_id = ? AND status IN ('pending', 'running', 'retry_wait') LIMIT 1
    `).get(itemId);
    if (existing) return { status: "queued", jobId: Number(existing.id) };
    return { status: "queued", jobId: this.queue.enqueue("translation", { itemId, modelId, promptVersion }, { itemId, priority: 100 }) };
  }
}

export class EnrichmentWorker {
  private readonly queue: JobQueue;
  constructor(
    private readonly database: DatabaseSync,
    private readonly client: LmStudioClient,
    private readonly owner: string,
    private readonly recommendations?: RecommendationService,
  ) { this.queue = new JobQueue(database); }

  async runOne(modelId: string, promptVersion: string, now = new Date()): Promise<boolean> {
    const job = this.queue.claim(this.owner, 5 * 60_000, now);
    if (!job) return false;
    try {
      if (job.type === "embedding") {
        if (!this.recommendations) throw new Error("Recommendation service is unavailable");
        await this.recommendations.processEmbeddingJob(job, this.client, now);
        this.queue.complete(job.id, this.owner, now);
        return true;
      }
      if (job.type === "recommendation") {
        if (!this.recommendations) throw new Error("Recommendation service is unavailable");
        this.recommendations.processRecommendationJob(job, now);
        this.queue.complete(job.id, this.owner, now);
        return true;
      }
      const item = this.database.prepare("SELECT title, coalesce(extracted_content, feed_content) AS content FROM items WHERE id = ?").get(job.itemId);
      if (!item?.content) throw new Error("Item content is unavailable");
      if (job.type === "analysis") {
        const result = await this.client.analyze(modelId, String(item.title), String(item.content));
        this.database.prepare(`
          INSERT INTO item_analyses(item_id, kind, model_id, prompt_version, summary_ja,
            labels_json, priority, key_points_json, item_type, original_language, analyzed_at)
          VALUES (?, 'analysis', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(item_id, kind, model_id, prompt_version) DO UPDATE SET
            summary_ja=excluded.summary_ja, labels_json=excluded.labels_json, priority=excluded.priority,
            key_points_json=excluded.key_points_json, item_type=excluded.item_type,
            original_language=excluded.original_language, analyzed_at=excluded.analyzed_at
        `).run(job.itemId, modelId, promptVersion, result.summaryJa, JSON.stringify(result.labels), result.priority,
          JSON.stringify(result.keyPoints), result.itemType, result.originalLanguage, now.toISOString());
        this.recommendations?.ensureEmbeddingQueued(job.itemId!);
      } else if (job.type === "translation") {
        const payload = job.payload as { modelId?: string; promptVersion?: string };
        const actualModel = payload.modelId ?? modelId; const actualPrompt = payload.promptVersion ?? promptVersion;
        const translated = await this.client.translate(actualModel, String(item.content));
        this.database.prepare(`
          INSERT INTO item_analyses(item_id, kind, model_id, prompt_version, translated_content, analyzed_at)
          VALUES (?, 'translation', ?, ?, ?, ?)
          ON CONFLICT(item_id, kind, model_id, prompt_version) DO UPDATE SET translated_content=excluded.translated_content, analyzed_at=excluded.analyzed_at
        `).run(job.itemId, actualModel, actualPrompt, translated, now.toISOString());
      } else {
        throw new Error(`Unsupported enrichment job: ${job.type}`);
      }
      this.queue.complete(job.id, this.owner, now);
    } catch (error) {
      const delay = Math.min(3_600_000, 2 ** job.attempts * 30_000);
      this.queue.retry(job.id, this.owner, error instanceof Error ? error.message : String(error), new Date(now.getTime() + delay), now);
    }
    return true;
  }
}
