import type { DatabaseSync } from "node:sqlite";
import { parseOpml } from "./feed.js";
import { SourceResolver } from "./resolver.js";
import type { ResolvedSource, SourcePreview } from "./types.js";

export interface StoredSource {
  readonly id: number;
  readonly status: "active" | "paused";
  readonly created: boolean;
}

export interface SourceSettings {
  readonly displayName?: string;
  readonly groupName?: string | null;
  readonly basePriority?: number;
  readonly fetchIntervalMinutes?: number;
  readonly language?: string | null;
  readonly summaryEnabled?: boolean;
  readonly translateTitle?: boolean;
  readonly fetchFullText?: boolean;
  readonly retentionDays?: number | null;
  readonly excludedKeywords?: readonly string[];
}

function now(): string {
  return new Date().toISOString();
}

export class SourceService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly resolver: SourceResolver,
  ) {}

  async resolveAndPreview(input: string): Promise<SourcePreview> {
    const resolved = await this.resolver.resolve(input);
    const rows = this.database.prepare("SELECT canonical_url FROM items").all();
    const urls = new Set(rows.map((row) => String(row.canonical_url)));
    return this.resolver.preview(resolved, urls);
  }

  add(source: ResolvedSource, settings: SourceSettings = {}): StoredSource {
    const existing = this.database.prepare(
      "SELECT id, status FROM sources WHERE canonical_url = ?",
    ).get(source.canonicalUrl);
    if (existing) {
      return { id: Number(existing.id), status: existing.status as "active" | "paused", created: false };
    }

    const timestamp = now();
    const result = this.database.prepare(`
      INSERT INTO sources(
        kind, canonical_url, display_name, group_name, base_priority,
        fetch_interval_minutes, language, summary_enabled, translate_title,
        fetch_full_text, retention_days, excluded_keywords_json,
        next_fetch_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.kind,
      source.canonicalUrl,
      settings.displayName ?? source.displayName,
      settings.groupName ?? null,
      settings.basePriority ?? 50,
      settings.fetchIntervalMinutes ?? 60,
      settings.language ?? null,
      Number(settings.summaryEnabled ?? true),
      Number(settings.translateTitle ?? false),
      Number(settings.fetchFullText ?? true),
      settings.retentionDays ?? null,
      JSON.stringify(settings.excludedKeywords ?? []),
      timestamp,
      timestamp,
      timestamp,
    );
    return { id: Number(result.lastInsertRowid), status: "active", created: true };
  }

  pause(id: number): void { this.transition(id, "active", "paused"); }
  resume(id: number): void { this.transition(id, "paused", "active"); }

  update(id: number, settings: SourceSettings): void {
    const current = this.database.prepare("SELECT * FROM sources WHERE id = ?").get(id);
    if (!current) throw new Error("Source not found");
    const result = this.database.prepare(`
      UPDATE sources SET display_name = ?, group_name = ?, base_priority = ?,
        fetch_interval_minutes = ?, language = ?, summary_enabled = ?,
        translate_title = ?, fetch_full_text = ?, retention_days = ?,
        excluded_keywords_json = ?, updated_at = ? WHERE id = ?
    `).run(
      settings.displayName ?? String(current.display_name),
      settings.groupName === undefined ? current.group_name ?? null : settings.groupName,
      settings.basePriority ?? Number(current.base_priority),
      settings.fetchIntervalMinutes ?? Number(current.fetch_interval_minutes),
      settings.language === undefined ? current.language ?? null : settings.language,
      Number(settings.summaryEnabled ?? Boolean(current.summary_enabled)),
      Number(settings.translateTitle ?? Boolean(current.translate_title)),
      Number(settings.fetchFullText ?? Boolean(current.fetch_full_text)),
      settings.retentionDays === undefined ? current.retention_days ?? null : settings.retentionDays,
      settings.excludedKeywords ? JSON.stringify(settings.excludedKeywords) : String(current.excluded_keywords_json),
      now(),
      id,
    );
    if (result.changes !== 1) throw new Error("Source update failed");
  }

  remove(id: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM source_items WHERE source_id = ?").run(id);
      const result = this.database.prepare("DELETE FROM sources WHERE id = ?").run(id);
      if (result.changes !== 1) throw new Error("Source not found");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async importOpml(xml: string, register = false): Promise<readonly {
    input: string;
    source?: ResolvedSource;
    duplicate: boolean;
    error?: string;
  }[]> {
    const results = [];
    for (const input of parseOpml(xml)) {
      try {
        const source = await this.resolver.resolve(input);
        const duplicate = Boolean(this.database.prepare(
          "SELECT 1 FROM sources WHERE canonical_url = ?",
        ).get(source.canonicalUrl));
        if (register && !duplicate) this.add(source);
        results.push({ input, source, duplicate });
      } catch (error) {
        results.push({ input, duplicate: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  private transition(id: number, from: "active" | "paused", to: "active" | "paused"): void {
    const result = this.database.prepare(
      "UPDATE sources SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
    ).run(to, now(), id, from);
    if (result.changes !== 1) throw new Error(`Source must be ${from} before changing to ${to}`);
  }
}
