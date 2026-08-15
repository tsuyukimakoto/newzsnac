import type { DatabaseSync } from "node:sqlite";

export interface Job {
  readonly id: number;
  readonly type: string;
  readonly itemId: number | null;
  readonly sourceId: number | null;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

interface JobRow {
  id: number;
  type: string;
  item_id: number | null;
  source_id: number | null;
  payload_json: string;
  attempts: number;
  max_attempts: number;
}

function iso(date: Date): string {
  return date.toISOString();
}

export class JobQueue {
  constructor(private readonly database: DatabaseSync) {}

  enqueue(type: string, payload: unknown, options: {
    itemId?: number;
    sourceId?: number;
    priority?: number;
    availableAt?: Date;
    maxAttempts?: number;
  } = {}): number {
    const now = new Date();
    const result = this.database.prepare(`
      INSERT INTO jobs(
        type, item_id, source_id, payload_json, priority, max_attempts,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      type,
      options.itemId ?? null,
      options.sourceId ?? null,
      JSON.stringify(payload),
      options.priority ?? 0,
      options.maxAttempts ?? 5,
      iso(options.availableAt ?? now),
      iso(now),
      iso(now),
    );
    return Number(result.lastInsertRowid);
  }

  claim(owner: string, leaseDurationMs: number, now = new Date()): Job | null {
    const nowIso = iso(now);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
            lease_owner = NULL, lease_expires_at = NULL, available_at = ?,
            last_error = 'worker lease expired', updated_at = ?
        WHERE status = 'running' AND lease_expires_at <= ?
      `).run(nowIso, nowIso, nowIso);

      const row = this.database.prepare(`
        SELECT id, type, item_id, source_id, payload_json, attempts, max_attempts
        FROM jobs
        WHERE status IN ('pending', 'retry_wait')
          AND available_at <= ? AND attempts < max_attempts
        ORDER BY priority DESC, available_at ASC, id ASC
        LIMIT 1
      `).get(nowIso) as unknown as JobRow | undefined;

      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }

      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
      this.database.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1,
          lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?
      `).run(owner, iso(leaseExpiresAt), nowIso, row.id);
      this.database.exec("COMMIT");
      return {
        id: row.id,
        type: row.type,
        itemId: row.item_id,
        sourceId: row.source_id,
        payload: JSON.parse(row.payload_json) as unknown,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(id: number, owner: string, now = new Date()): boolean {
    const result = this.database.prepare(`
      UPDATE jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
        updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(iso(now), id, owner);
    return result.changes === 1;
  }

  retry(id: number, owner: string, error: string, availableAt: Date, now = new Date()): boolean {
    const result = this.database.prepare(`
      UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
        lease_owner = NULL, lease_expires_at = NULL, last_error = ?, available_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(error, iso(availableAt), iso(now), id, owner);
    return result.changes === 1;
  }
}
