import type { DatabaseSync } from "node:sqlite";
import type { KeyPoint } from "../enrichment/schema.js";

export type SortOrder = "newest" | "recommended" | "source" | "oldest";
export type Interest = "interested" | "not_interested" | null;
export type ProcessingState = "ready" | "pending" | "failed" | "analysis_failed";

const processingStateSql = `CASE
  WHEN i.extraction_status = 'failed' THEN 'failed'
  WHEN EXISTS(SELECT 1 FROM item_analyses state_analysis WHERE state_analysis.item_id = i.id AND state_analysis.kind = 'analysis') THEN 'ready'
  WHEN EXISTS(SELECT 1 FROM jobs state_job WHERE state_job.item_id = i.id AND state_job.type = 'analysis' AND state_job.status IN ('pending', 'running', 'retry_wait')) THEN 'pending'
  WHEN EXISTS(SELECT 1 FROM jobs state_job WHERE state_job.item_id = i.id AND state_job.type = 'analysis' AND state_job.status = 'failed') THEN 'analysis_failed'
  ELSE 'pending'
END`;

export interface ArticleListItem {
  readonly id: number;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly isRead: boolean;
  readonly isSaved: boolean;
  readonly interest: Interest;
  readonly priority: number | null;
  readonly estimatedReadingMinutes: number;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly content: string | null;
  readonly summary: string | null;
  readonly labels: readonly string[];
  readonly keyPoints: readonly KeyPoint[];
  readonly source: string | null;
  readonly extractionStatus: string;
  readonly processingState: ProcessingState;
  readonly translationStatus: "ready" | "pending" | null;
  readonly url: string;
  readonly recommendation: { readonly sourceItemId: number; readonly sourceTitle: string; readonly score: number } | null;
}

interface ArticleRow {
  id: number;
  title: string;
  canonical_url: string;
  is_read: number | null;
  is_saved: number | null;
  interest: Interest;
  priority: number | null;
  estimated_reading_minutes: number | null;
  author: string | null;
  published_at: string | null;
  content: string | null;
  summary: string | null;
  labels_json: string | null;
  key_points_json: string;
  source: string | null;
  extraction_status: string;
  processing_state: ProcessingState;
  translation_status: "ready" | "pending" | null;
  recommendation_source_id: number | null;
  recommendation_source_title: string | null;
  recommendation_score: number | null;
}

function timestamp(date = new Date()): string { return date.toISOString(); }

function stringArray(value: string | null): readonly string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function keyPointArray(value: string): readonly KeyPoint[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
    const point = entry as Record<string, unknown>;
    return Object.keys(point).length !== 2 ||
      typeof point.headline !== "string" || !point.headline.trim() ||
      typeof point.detail !== "string";
  })) throw new Error("Stored key points are invalid");
  return parsed as KeyPoint[];
}

function mapArticle(row: ArticleRow): ArticleListItem {
  return {
    id: row.id, title: row.title, canonicalUrl: row.canonical_url,
    isRead: Boolean(row.is_read), isSaved: Boolean(row.is_saved), interest: row.interest, priority: row.priority,
    estimatedReadingMinutes: row.estimated_reading_minutes ?? 5,
    author: row.author, publishedAt: row.published_at,
    content: row.content,
    summary: row.summary,
    labels: stringArray(row.labels_json),
    keyPoints: keyPointArray(row.key_points_json),
    source: row.source,
    extractionStatus: row.extraction_status,
    processingState: row.processing_state,
    translationStatus: row.translation_status,
    url: row.canonical_url,
    recommendation: row.recommendation_source_id === null || row.recommendation_score === null ? null : {
      sourceItemId: row.recommendation_source_id,
      sourceTitle: row.recommendation_source_title ?? "関心記事",
      score: row.recommendation_score,
    },
  };
}

export class ReadingService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly recommendationModel = "__disabled__",
    private readonly embeddingInputVersion = "__disabled__",
    private readonly recommendationSimilarityThreshold = 0.86,
  ) {}

  setRead(itemId: number, read: boolean, now = new Date()): void {
    this.upsertState(itemId, { isRead: read, readAt: read ? timestamp(now) : null });
  }

  setSaved(itemId: number, saved: boolean, now = new Date()): void {
    this.upsertState(itemId, { isSaved: saved, savedAt: saved ? timestamp(now) : null });
  }

  setInterest(itemId: number, interest: Interest): void { this.upsertState(itemId, { interest }); }

  list(options: { sort?: SortOrder; baselineAt?: Date; timeBudgetMinutes?: number; sourceId?: number; saved?: boolean; interested?: boolean; recommended?: boolean; unread?: boolean; processingState?: ProcessingState } = {}): readonly ArticleListItem[] {
    const sort = options.sort ?? "newest";
    const order = {
      newest: "i.published_at DESC, i.id DESC",
      recommended: "coalesce(a.priority, 0) DESC, i.published_at DESC, i.id DESC",
      source: "coalesce(min(s.display_name), ''), i.published_at DESC, i.id DESC",
      oldest: "i.published_at ASC, i.id ASC",
    }[sort];
    const conditions = ["(? IS NULL OR i.discovered_at <= ?)", "(? IS NULL OR si.source_id = ?)", "(? = 0 OR coalesce(u.is_saved, 0) = 1)", "(? = 0 OR u.interest = 'interested')", "(? = 0 OR r.target_item_id IS NOT NULL)", "(? = 0 OR coalesce(u.is_read, 0) = 0)", `${processingStateSql} = ?`];
    const baseline = options.baselineAt?.toISOString() ?? null;
    const sourceId = options.sourceId ?? null;
    const rows = this.database.prepare(`
      SELECT i.id, i.title, i.canonical_url, u.is_read, u.is_saved, u.interest,
        max(a.priority) AS priority, i.estimated_reading_minutes, i.author, i.published_at,
        coalesce(i.extracted_content, i.feed_content) AS content,
        max(a.summary_ja) AS summary, max(a.labels_json) AS labels_json,
        coalesce(max(a.key_points_json), '[]') AS key_points_json, min(s.display_name) AS source,
        i.extraction_status,
        ${processingStateSql} AS processing_state,
        CASE
          WHEN EXISTS(SELECT 1 FROM item_analyses t WHERE t.item_id=i.id AND t.kind='translation') THEN 'ready'
          WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.item_id=i.id AND j.type='translation' AND j.status IN ('pending','running','retry_wait')) THEN 'pending'
          ELSE NULL
        END AS translation_status
        ,r.source_item_id AS recommendation_source_id, ri.title AS recommendation_source_title,
        r.score AS recommendation_score
      FROM items i
      LEFT JOIN item_user_states u ON u.item_id = i.id
      LEFT JOIN item_analyses a ON a.item_id = i.id AND a.kind = 'analysis'
      LEFT JOIN source_items si ON si.item_id = i.id
      LEFT JOIN sources s ON s.id = si.source_id
      LEFT JOIN item_recommendations r ON r.target_item_id = i.id AND r.model_id = ? AND r.input_version = ?
        AND r.score >= ?
        AND coalesce(u.is_read, 0) = 0 AND u.interest IS NULL
      LEFT JOIN items ri ON ri.id = r.source_item_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY i.id
      ORDER BY ${options.recommended ? "r.score DESC, i.published_at DESC, i.id DESC" : order}
    `).all(this.recommendationModel, this.embeddingInputVersion, this.recommendationSimilarityThreshold,
      baseline, baseline, sourceId, sourceId,
      Number(options.saved ?? false), Number(options.interested ?? false), Number(options.recommended ?? false), Number(options.unread ?? false),
      options.processingState ?? "ready") as unknown as ArticleRow[];
    const articles = rows.map(mapArticle);
    if (options.timeBudgetMinutes === undefined) return articles;
    let remaining = options.timeBudgetMinutes;
    return articles.filter((article) => {
      if (article.estimatedReadingMinutes > remaining) return false;
      remaining -= article.estimatedReadingMinutes;
      return true;
    });
  }

  search(query: string, options: { unread?: boolean; processingState?: ProcessingState } = {}): readonly ArticleListItem[] {
    if (!query.trim()) return [];
    const rows = this.database.prepare(`
      WITH matches AS (
        SELECT rowid
        FROM item_search WHERE item_search MATCH ?
      )
      SELECT i.id, i.title, i.canonical_url, u.is_read, u.is_saved, u.interest,
        max(a.priority) AS priority, i.estimated_reading_minutes, i.author, i.published_at,
        coalesce(i.extracted_content, i.feed_content) AS content,
        max(a.summary_ja) AS summary, max(a.labels_json) AS labels_json,
        coalesce(max(a.key_points_json), '[]') AS key_points_json, min(s.display_name) AS source,
        i.extraction_status,
        ${processingStateSql} AS processing_state,
        CASE
          WHEN EXISTS(SELECT 1 FROM item_analyses t WHERE t.item_id=i.id AND t.kind='translation') THEN 'ready'
          WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.item_id=i.id AND j.type='translation' AND j.status IN ('pending','running','retry_wait')) THEN 'pending'
          ELSE NULL
        END AS translation_status
        ,r.source_item_id AS recommendation_source_id, ri.title AS recommendation_source_title,
        r.score AS recommendation_score
      FROM matches m
      JOIN items i ON i.id = m.rowid
      LEFT JOIN item_user_states u ON u.item_id = i.id
      LEFT JOIN item_analyses a ON a.item_id = i.id AND a.kind = 'analysis'
      LEFT JOIN source_items si ON si.item_id = i.id
      LEFT JOIN sources s ON s.id = si.source_id
      LEFT JOIN item_recommendations r ON r.target_item_id = i.id AND r.model_id = ? AND r.input_version = ?
        AND r.score >= ?
        AND coalesce(u.is_read, 0) = 0 AND u.interest IS NULL
      LEFT JOIN items ri ON ri.id = r.source_item_id
      WHERE (? = 0 OR coalesce(u.is_read, 0) = 0)
        AND ${processingStateSql} = ?
      GROUP BY i.id ORDER BY i.id DESC
    `).all(query, this.recommendationModel, this.embeddingInputVersion,
      this.recommendationSimilarityThreshold, Number(options.unread ?? false), options.processingState ?? "ready") as unknown as ArticleRow[];
    return rows.map(mapArticle);
  }

  saveSmartView(name: string, query: string, sort: SortOrder, filters: unknown = {}): number {
    const now = timestamp();
    this.database.prepare(`
      INSERT INTO smart_views(name, query, filters_json, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET query=excluded.query, filters_json=excluded.filters_json,
        sort_order=excluded.sort_order, updated_at=excluded.updated_at
    `).run(name, query, JSON.stringify(filters), sort, now, now);
    return Number(this.database.prepare("SELECT id FROM smart_views WHERE name = ?").get(name)?.id);
  }

  runSmartView(id: number): readonly ArticleListItem[] {
    const view = this.database.prepare("SELECT query, sort_order FROM smart_views WHERE id = ?").get(id);
    if (!view) throw new Error("Smart view not found");
    return String(view.query).trim() ? this.search(String(view.query)) : this.list({ sort: view.sort_order as SortOrder });
  }

  createSession(query: unknown, sort: SortOrder, baselineAt = new Date()): number {
    const now = timestamp();
    return Number(this.database.prepare(`
      INSERT INTO reading_sessions(query_json, sort_order, baseline_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(JSON.stringify(query), sort, baselineAt.toISOString(), now, now).lastInsertRowid);
  }

  updateSession(id: number, currentItemId: number | null, scrollOffset: number): void {
    const result = this.database.prepare(`
      UPDATE reading_sessions SET current_item_id = ?, scroll_offset = ?, updated_at = ? WHERE id = ?
    `).run(currentItemId, scrollOffset, timestamp(), id);
    if (result.changes !== 1) throw new Error("Reading session not found");
  }

  resumeSession(id: number): { articles: readonly ArticleListItem[]; currentItemId: number | null; scrollOffset: number } {
    const session = this.database.prepare("SELECT * FROM reading_sessions WHERE id = ?").get(id);
    if (!session) throw new Error("Reading session not found");
    return {
      articles: this.list({ sort: session.sort_order as SortOrder, baselineAt: new Date(String(session.baseline_at)) }),
      currentItemId: session.current_item_id === null ? null : Number(session.current_item_id),
      scrollOffset: Number(session.scroll_offset),
    };
  }

  advanceFrom(itemId: number): void { this.setRead(itemId, true); }
  recordScrollOnly(_itemId: number): void { /* Scrolling alone intentionally changes no state. */ }

  private upsertState(itemId: number, change: { isRead?: boolean; readAt?: string | null; isSaved?: boolean; savedAt?: string | null; interest?: Interest }): void {
    const existing = this.database.prepare("SELECT * FROM item_user_states WHERE item_id = ?").get(itemId);
    const now = timestamp();
    this.database.prepare(`
      INSERT INTO item_user_states(item_id, is_read, is_saved, interest, read_at, saved_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET is_read=excluded.is_read, is_saved=excluded.is_saved,
        interest=excluded.interest, read_at=excluded.read_at, saved_at=excluded.saved_at, updated_at=excluded.updated_at
    `).run(itemId, Number(change.isRead ?? Boolean(existing?.is_read)), Number(change.isSaved ?? Boolean(existing?.is_saved)),
      change.interest === undefined ? existing?.interest ?? null : change.interest,
      change.readAt === undefined ? existing?.read_at ?? null : change.readAt,
      change.savedAt === undefined ? existing?.saved_at ?? null : change.savedAt, now);
  }
}
