import type { DatabaseSync } from "node:sqlite";

export type SortOrder = "newest" | "recommended" | "source" | "oldest";
export type Interest = "interested" | "not_interested" | null;

export interface ArticleListItem {
  readonly id: number;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly isRead: boolean;
  readonly isSaved: boolean;
  readonly priority: number | null;
  readonly estimatedReadingMinutes: number;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly content: string | null;
  readonly summary: string | null;
  readonly labels: readonly string[];
  readonly reasons: readonly string[];
  readonly source: string | null;
  readonly extractionStatus: string;
  readonly translationStatus: "ready" | "pending" | null;
  readonly url: string;
}

interface ArticleRow {
  id: number;
  title: string;
  canonical_url: string;
  is_read: number | null;
  is_saved: number | null;
  priority: number | null;
  estimated_reading_minutes: number | null;
  author: string | null;
  published_at: string | null;
  content: string | null;
  summary: string | null;
  labels_json: string | null;
  reasons_json: string | null;
  source: string | null;
  extraction_status: string;
  translation_status: "ready" | "pending" | null;
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

function mapArticle(row: ArticleRow): ArticleListItem {
  return {
    id: row.id, title: row.title, canonicalUrl: row.canonical_url,
    isRead: Boolean(row.is_read), isSaved: Boolean(row.is_saved), priority: row.priority,
    estimatedReadingMinutes: row.estimated_reading_minutes ?? 5,
    author: row.author, publishedAt: row.published_at,
    content: row.content,
    summary: row.summary,
    labels: stringArray(row.labels_json),
    reasons: stringArray(row.reasons_json),
    source: row.source,
    extractionStatus: row.extraction_status,
    translationStatus: row.translation_status,
    url: row.canonical_url,
  };
}

export class ReadingService {
  constructor(private readonly database: DatabaseSync) {}

  setRead(itemId: number, read: boolean, now = new Date()): void {
    this.upsertState(itemId, { isRead: read, readAt: read ? timestamp(now) : null });
  }

  setSaved(itemId: number, saved: boolean, now = new Date()): void {
    this.upsertState(itemId, { isSaved: saved, savedAt: saved ? timestamp(now) : null });
  }

  setInterest(itemId: number, interest: Interest): void { this.upsertState(itemId, { interest }); }

  list(options: { sort?: SortOrder; baselineAt?: Date; timeBudgetMinutes?: number; sourceId?: number; saved?: boolean } = {}): readonly ArticleListItem[] {
    const sort = options.sort ?? "newest";
    const order = {
      newest: "i.published_at DESC, i.id DESC",
      recommended: "coalesce(a.priority, 0) DESC, i.published_at DESC, i.id DESC",
      source: "coalesce(min(s.display_name), ''), i.published_at DESC, i.id DESC",
      oldest: "i.published_at ASC, i.id ASC",
    }[sort];
    const conditions = ["(? IS NULL OR i.discovered_at <= ?)", "(? IS NULL OR si.source_id = ?)", "(? = 0 OR coalesce(u.is_saved, 0) = 1)"];
    const baseline = options.baselineAt?.toISOString() ?? null;
    const sourceId = options.sourceId ?? null;
    const rows = this.database.prepare(`
      SELECT i.id, i.title, i.canonical_url, u.is_read, u.is_saved,
        max(a.priority) AS priority, i.estimated_reading_minutes, i.author, i.published_at,
        coalesce(i.extracted_content, i.feed_content) AS content,
        max(a.summary_ja) AS summary, max(a.labels_json) AS labels_json,
        max(a.reasons_json) AS reasons_json, min(s.display_name) AS source,
        i.extraction_status,
        CASE
          WHEN EXISTS(SELECT 1 FROM item_analyses t WHERE t.item_id=i.id AND t.kind='translation') THEN 'ready'
          WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.item_id=i.id AND j.type='translation' AND j.status IN ('pending','running','retry_wait')) THEN 'pending'
          ELSE NULL
        END AS translation_status
      FROM items i
      LEFT JOIN item_user_states u ON u.item_id = i.id
      LEFT JOIN item_analyses a ON a.item_id = i.id AND a.kind = 'analysis'
      LEFT JOIN source_items si ON si.item_id = i.id
      LEFT JOIN sources s ON s.id = si.source_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY i.id
      ORDER BY ${order}
    `).all(baseline, baseline, sourceId, sourceId, Number(options.saved ?? false)) as unknown as ArticleRow[];
    const articles = rows.map(mapArticle);
    if (options.timeBudgetMinutes === undefined) return articles;
    let remaining = options.timeBudgetMinutes;
    return articles.filter((article) => {
      if (article.estimatedReadingMinutes > remaining) return false;
      remaining -= article.estimatedReadingMinutes;
      return true;
    });
  }

  search(query: string): readonly ArticleListItem[] {
    if (!query.trim()) return [];
    const rows = this.database.prepare(`
      WITH matches AS (
        SELECT rowid
        FROM item_search WHERE item_search MATCH ?
      )
      SELECT i.id, i.title, i.canonical_url, u.is_read, u.is_saved,
        max(a.priority) AS priority, i.estimated_reading_minutes, i.author, i.published_at,
        coalesce(i.extracted_content, i.feed_content) AS content,
        max(a.summary_ja) AS summary, max(a.labels_json) AS labels_json,
        max(a.reasons_json) AS reasons_json, min(s.display_name) AS source,
        i.extraction_status,
        CASE
          WHEN EXISTS(SELECT 1 FROM item_analyses t WHERE t.item_id=i.id AND t.kind='translation') THEN 'ready'
          WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.item_id=i.id AND j.type='translation' AND j.status IN ('pending','running','retry_wait')) THEN 'pending'
          ELSE NULL
        END AS translation_status
      FROM matches m
      JOIN items i ON i.id = m.rowid
      LEFT JOIN item_user_states u ON u.item_id = i.id
      LEFT JOIN item_analyses a ON a.item_id = i.id AND a.kind = 'analysis'
      LEFT JOIN source_items si ON si.item_id = i.id
      LEFT JOIN sources s ON s.id = si.source_id
      GROUP BY i.id ORDER BY i.id DESC
    `).all(query) as unknown as ArticleRow[];
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
