import type { DatabaseSync } from "node:sqlite";
import { SourceResolver } from "../sources/resolver.js";
import { SourceService } from "../sources/service.js";

export interface CandidateInput { readonly itemId: number; readonly value: string; readonly evidenceType: "link" | "author" | "topic" | "mention" | "quote" | "repost"; }

export function extractCandidateInputs(itemId: number, content: string, author?: string, topics: readonly string[] = []): readonly CandidateInput[] {
  const results: CandidateInput[] = [];
  for (const match of content.matchAll(/https?:\/\/[^\s<>"')]+/g)) results.push({ itemId, value: match[0], evidenceType: "link" });
  if (author?.endsWith(".bsky.social")) results.push({ itemId, value: author, evidenceType: "author" });
  for (const topic of topics) results.push({ itemId, value: `https://zenn.dev/topics/${encodeURIComponent(topic)}`, evidenceType: "topic" });
  return results;
}

export class DiscoveryService {
  constructor(private readonly database: DatabaseSync, private readonly resolver: SourceResolver, private readonly sources: SourceService) {}

  async verifyAndSave(input: CandidateInput, reason: string): Promise<number | null> {
    let source;
    try { source = await this.resolver.resolve(input.value); } catch { return null; }
    const preview = await this.sources.resolveAndPreview(input.value);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO source_candidates(kind, canonical_url, display_name, reason,
      estimated_weekly_count, overlap_ratio, recent_items_json, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_url) DO UPDATE SET reason=excluded.reason,
        estimated_weekly_count=excluded.estimated_weekly_count, overlap_ratio=excluded.overlap_ratio,
        recent_items_json=excluded.recent_items_json, verified_at=excluded.verified_at, updated_at=excluded.updated_at
    `).run(source.kind, source.canonicalUrl, source.displayName, reason, preview.estimatedWeeklyCount,
      preview.overlapRatio, JSON.stringify(preview.recentItems), now, now, now);
    const id = Number(this.database.prepare("SELECT id FROM source_candidates WHERE canonical_url=?").get(source.canonicalUrl)?.id);
    this.database.prepare(`INSERT OR IGNORE INTO source_candidate_evidence(candidate_id,item_id,evidence_type,evidence_value,created_at)
      VALUES(?,?,?,?,?)`).run(id, input.itemId, input.evidenceType, input.value, now);
    return id;
  }

  hide(id: number, days = 30): void { const until = new Date(Date.now() + days * 86_400_000).toISOString(); this.database.prepare("UPDATE source_candidates SET status='hidden',hidden_until=?,updated_at=? WHERE id=?").run(until,new Date().toISOString(),id); }
  dismiss(id: number): void { this.database.prepare("UPDATE source_candidates SET status='dismissed',hidden_until=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),id); }
  subscribe(id: number): number { const row=this.database.prepare("SELECT kind,canonical_url,display_name FROM source_candidates WHERE id=? AND status='candidate'").get(id);if(!row)throw new Error("Candidate is not subscribable");const result=this.sources.add({kind:row.kind as never,canonicalUrl:String(row.canonical_url),displayName:String(row.display_name)});this.database.prepare("UPDATE source_candidates SET status='subscribed',updated_at=? WHERE id=?").run(new Date().toISOString(),id);return result.id; }
  visible(): readonly Record<string, unknown>[] { return this.database.prepare("SELECT * FROM source_candidates WHERE status='candidate' OR (status='hidden' AND hidden_until<=?) ORDER BY updated_at DESC").all(new Date().toISOString()) as Record<string,unknown>[]; }
}
