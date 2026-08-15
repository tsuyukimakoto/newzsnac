import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Fetch } from "../sources/resolver.js";
import type { CollectedItem } from "./types.js";

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "ref", "source"]);

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}

export async function extractArticle(url: string, fetcher: Fetch = globalThis.fetch): Promise<string> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Article returned HTTP ${response.status}`);
  const html = await response.text();
  return html
    .replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function articleContentMetadata(content: string): { readonly hash: string; readonly readingMinutes: number } {
  return {
    hash: createHash("sha256").update(content).digest("hex"),
    readingMinutes: Math.max(1, Math.ceil(content.split(/\s+/).length / 220)),
  };
}

export class ItemRepository {
  constructor(private readonly database: DatabaseSync) {}

  save(sourceId: number, collected: CollectedItem, extractedContent?: string): number {
    const url = normalizeUrl(collected.url);
    const timestamp = new Date().toISOString();
    const content = extractedContent ?? collected.feedContent ?? null;
    const metadata = content ? articleContentMetadata(content) : null;
    const hash = metadata?.hash ?? null;
    const readingMinutes = metadata?.readingMinutes ?? null;
    this.database.prepare(`
      INSERT INTO items(canonical_url, title, author, published_at, discovered_at, feed_content,
        extracted_content, content_hash, extraction_status, estimated_reading_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_url) DO UPDATE SET
        title = excluded.title, author = coalesce(excluded.author, items.author),
        feed_content = coalesce(excluded.feed_content, items.feed_content),
        extracted_content = coalesce(excluded.extracted_content, items.extracted_content),
        content_hash = coalesce(excluded.content_hash, items.content_hash),
        estimated_reading_minutes = coalesce(excluded.estimated_reading_minutes, items.estimated_reading_minutes),
        extraction_status = CASE WHEN excluded.extraction_status = 'available' THEN 'available' ELSE items.extraction_status END,
        updated_at = excluded.updated_at
    `).run(url, collected.title, collected.author ?? null, collected.publishedAt ?? null, timestamp,
      collected.feedContent ?? null, extractedContent ?? null, hash, content ? "available" : "pending", readingMinutes, timestamp, timestamp);
    const itemId = Number(this.database.prepare("SELECT id FROM items WHERE canonical_url = ?").get(url)?.id);
    this.database.prepare(`
      INSERT INTO source_items(source_id, item_id, external_id, source_url, source_title, discovered_at, raw_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, item_id) DO UPDATE SET raw_metadata_json = excluded.raw_metadata_json
    `).run(sourceId, itemId, collected.externalId, collected.url, collected.title, timestamp, JSON.stringify(collected.rawMetadata ?? {}));
    return itemId;
  }

  markExtractionFailed(itemId: number): void {
    this.database.prepare(`
      UPDATE items SET extraction_status = 'failed', updated_at = ?
      WHERE id = ? AND extracted_content IS NULL AND feed_content IS NULL
    `).run(new Date().toISOString(), itemId);
  }

  groupRelated(firstItemId: number, secondItemId: number, similarity: number, reason: string): number {
    const timestamp = new Date().toISOString();
    const result = this.database.prepare("INSERT INTO related_item_groups(created_at) VALUES (?)").run(timestamp);
    const groupId = Number(result.lastInsertRowid);
    const add = this.database.prepare("INSERT INTO related_item_members(group_id, item_id, similarity, reason) VALUES (?, ?, ?, ?)");
    add.run(groupId, firstItemId, similarity, reason);
    add.run(groupId, secondItemId, similarity, reason);
    return groupId;
  }
}

export function titleSimilarity(first: string, second: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const a = tokens(first); const b = tokens(second);
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}
