import type { DatabaseSync } from "node:sqlite";
import type { CollectionAdapter, CollectionSource } from "./types.js";
import type { CollectedItem } from "./types.js";

interface SourceRow {
  id: number;
  kind: CollectionSource["kind"];
  canonical_url: string;
  fetch_interval_minutes: number;
  cursor: string | null;
  etag: string | null;
  last_modified: string | null;
  failure_count: number;
}

export interface CollectionOutcome {
  readonly sourceId: number;
  readonly collected: number;
  readonly error?: string;
}

export class CollectionCoordinator {
  constructor(
    private readonly database: DatabaseSync,
    private readonly adapters: readonly CollectionAdapter[],
    private readonly clock = () => new Date(),
    private readonly storeItems: (sourceId: number, items: readonly CollectedItem[]) => void | Promise<void> = () => {},
  ) {}

  async collectDue(): Promise<readonly CollectionOutcome[]> {
    const timestamp = this.clock();
    const rows = this.database.prepare(`
      SELECT id, kind, canonical_url, fetch_interval_minutes, cursor, etag,
        last_modified, failure_count
      FROM sources
      WHERE status = 'active' AND (next_fetch_at IS NULL OR next_fetch_at <= ?)
      ORDER BY id
    `).all(timestamp.toISOString()) as unknown as SourceRow[];

    const outcomes: CollectionOutcome[] = [];
    for (const row of rows) {
      const adapter = this.adapters.find((candidate) => candidate.kinds.includes(row.kind));
      if (!adapter) {
        outcomes.push({ sourceId: row.id, collected: 0, error: `No adapter for ${row.kind}` });
        continue;
      }
      try {
        const result = await adapter.collect({
          id: row.id,
          kind: row.kind,
          canonicalUrl: row.canonical_url,
          fetchIntervalMinutes: row.fetch_interval_minutes,
        }, {
          cursor: row.cursor ?? undefined,
          etag: row.etag ?? undefined,
          lastModified: row.last_modified ?? undefined,
        });
        await this.storeItems(row.id, result.items);
        this.database.prepare(`
          UPDATE sources SET cursor = ?, etag = ?, last_modified = ?, last_checked_at = ?,
            next_fetch_at = ?, failure_count = 0, last_error = NULL, updated_at = ? WHERE id = ?
        `).run(result.cursor ?? row.cursor, result.etag ?? row.etag, result.lastModified ?? row.last_modified,
          result.checkedAt, result.nextFetchAt, timestamp.toISOString(), row.id);
        outcomes.push({ sourceId: row.id, collected: result.items.length });
      } catch (error) {
        const failures = row.failure_count + 1;
        const backoffMinutes = Math.min(24 * 60, 2 ** Math.min(failures, 10));
        const retryAt = new Date(timestamp.getTime() + backoffMinutes * 60_000).toISOString();
        const message = error instanceof Error ? error.message : String(error);
        this.database.prepare(`
          UPDATE sources SET failure_count = ?, last_error = ?, next_fetch_at = ?, updated_at = ? WHERE id = ?
        `).run(failures, message, retryAt, timestamp.toISOString(), row.id);
        outcomes.push({ sourceId: row.id, collected: 0, error: message });
      }
    }
    return outcomes;
  }
}
