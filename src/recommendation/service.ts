import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";
import type { Job } from "../db/jobs.js";
import { JobQueue } from "../db/jobs.js";
import type { LmStudioClient } from "../enrichment/client.js";

interface ArticleTextRow {
  readonly title: string;
  readonly summary: string | null;
  readonly content: string | null;
}

interface EmbeddingRow {
  readonly item_id: number;
  readonly model_id: string;
  readonly input_version: string;
  readonly dimensions: number;
  readonly vector: Uint8Array;
  readonly l2_norm: number;
}

export interface StoredEmbedding {
  readonly itemId: number;
  readonly modelId: string;
  readonly inputVersion: string;
  readonly values: Float32Array;
  readonly norm: number;
}

export interface EmbeddingInput {
  readonly text: string;
  readonly hash: string;
}

export function buildEmbeddingInput(
  article: { readonly title: string; readonly summary?: string | null; readonly content?: string | null },
  maximumCharacters: number,
): EmbeddingInput {
  const sections = [
    `TITLE:\n${article.title.trim()}`,
    article.summary?.trim() ? `SUMMARY:\n${article.summary.trim()}` : "",
    article.content?.trim() ? `CONTENT:\n${article.content.trim()}` : "",
  ].filter(Boolean);
  const text = sections.join("\n\n").normalize("NFC").slice(0, maximumCharacters);
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}

export function vectorToBlob(values: Float32Array): Buffer {
  if (values.length === 0 || ![...values].every(Number.isFinite)) throw new Error("Embedding must contain finite values");
  const blob = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT);
  values.forEach((value, index) => blob.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return blob;
}

export function blobToVector(blob: Uint8Array, dimensions: number): Float32Array {
  if (!Number.isInteger(dimensions) || dimensions < 1 || blob.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Embedding BLOB dimensions do not match");
  }
  const buffer = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const values = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) values[index] = buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  if (![...values].every(Number.isFinite)) throw new Error("Embedding BLOB contains non-finite values");
  return values;
}

export function vectorNorm(values: Float32Array): number {
  let squared = 0;
  for (const value of values) squared += value * value;
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("Embedding must have a positive finite norm");
  return norm;
}

export function cosineSimilarity(left: StoredEmbedding, right: StoredEmbedding): number {
  if (left.modelId !== right.modelId || left.inputVersion !== right.inputVersion || left.values.length !== right.values.length) {
    throw new Error("Embedding vectors are not compatible");
  }
  if (!Number.isFinite(left.norm) || left.norm <= 0 || !Number.isFinite(right.norm) || right.norm <= 0) {
    throw new Error("Embedding norm is invalid");
  }
  let dot = 0;
  for (let index = 0; index < left.values.length; index += 1) {
    const a = left.values[index]!; const b = right.values[index]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Embedding contains non-finite values");
    dot += a * b;
  }
  const score = dot / (left.norm * right.norm);
  if (!Number.isFinite(score)) throw new Error("Embedding similarity is not finite");
  return Math.max(-1, Math.min(1, score));
}

export class RecommendationService {
  private readonly queue: JobQueue;

  constructor(private readonly database: DatabaseSync, private readonly config: AppConfig) {
    this.queue = new JobQueue(database);
  }

  ensureEmbeddingQueued(itemId: number): number | null {
    const model = this.config.embeddingModel;
    if (!model) return null;
    const input = this.embeddingInput(itemId);
    if (!input.text) return null;
    const stored = this.database.prepare(`
      SELECT 1 FROM item_embeddings
      WHERE item_id = ? AND model_id = ? AND input_version = ? AND input_hash = ?
    `).get(itemId, model, this.config.embeddingInputVersion, input.hash);
    if (stored) return null;
    const pending = this.database.prepare(`
      SELECT id FROM jobs WHERE type = 'embedding' AND item_id = ?
        AND status IN ('pending', 'running', 'retry_wait') LIMIT 1
    `).get(itemId);
    if (pending) return Number(pending.id);
    return this.queue.enqueue("embedding", { model, inputVersion: this.config.embeddingInputVersion, inputHash: input.hash }, { itemId, priority: 40 });
  }

  enqueueMissingEmbeddings(limit = 100): number {
    if (!this.config.embeddingModel) return 0;
    const rows = this.database.prepare(`
      SELECT i.id FROM items i
      WHERE NOT EXISTS (
        SELECT 1 FROM item_embeddings e
        WHERE e.item_id = i.id AND e.model_id = ? AND e.input_version = ?
      )
      ORDER BY i.published_at DESC, i.id DESC LIMIT ?
    `).all(this.config.embeddingModel, this.config.embeddingInputVersion, limit);
    let queued = 0;
    for (const row of rows) if (this.ensureEmbeddingQueued(Number(row.id)) !== null) queued += 1;
    return queued;
  }

  onInterestChanged(itemId: number, interest: "interested" | "not_interested" | null): void {
    if (interest === "interested") {
      this.database.prepare("DELETE FROM item_recommendations WHERE target_item_id = ?").run(itemId);
      this.ensureEmbeddingQueued(itemId);
      this.enqueueRecommendation({ sourceItemId: itemId }, itemId);
      return;
    }
    this.database.prepare("DELETE FROM item_recommendations WHERE source_item_id = ? OR target_item_id = ?").run(itemId, itemId);
    this.enqueueRecommendation({ recalculateAll: true });
  }

  processEmbeddingJob(job: Job, client: LmStudioClient, now = new Date()): Promise<void> {
    return this.processEmbedding(job, client, now);
  }

  processRecommendationJob(job: Job, now = new Date()): void {
    const payload = job.payload as { sourceItemId?: number; targetItemId?: number; recalculateAll?: boolean };
    if (payload.sourceItemId) this.recalculateFromSource(payload.sourceItemId, now);
    else if (payload.targetItemId) this.recalculateTarget(payload.targetItemId, now);
    else if (payload.recalculateAll) this.recalculateAll(now);
    else throw new Error("Recommendation job payload is invalid");
  }

  private async processEmbedding(job: Job, client: LmStudioClient, now: Date): Promise<void> {
    if (!job.itemId) throw new Error("Embedding job has no item");
    const model = this.config.embeddingModel;
    if (!model) throw new Error("Embedding model is not configured");
    const input = this.embeddingInput(job.itemId);
    if (!input.text) throw new Error("Embedding input is unavailable");
    const payload = job.payload as { model?: string; inputVersion?: string; inputHash?: string };
    if (payload.model !== model || payload.inputVersion !== this.config.embeddingInputVersion || payload.inputHash !== input.hash) {
      const newer = this.database.prepare(`
        SELECT 1 FROM jobs WHERE type = 'embedding' AND item_id = ? AND id <> ?
          AND status IN ('pending', 'running', 'retry_wait') LIMIT 1
      `).get(job.itemId, job.id);
      if (!newer) this.queue.enqueue("embedding", { model, inputVersion: this.config.embeddingInputVersion, inputHash: input.hash }, { itemId: job.itemId, priority: 40 });
      return;
    }
    const cached = this.database.prepare(`
      SELECT 1 FROM item_embeddings WHERE item_id = ? AND model_id = ? AND input_version = ? AND input_hash = ?
    `).get(job.itemId, model, this.config.embeddingInputVersion, input.hash);
    if (!cached) {
      const vector = await client.embed(model, input.text);
      const norm = vectorNorm(vector);
      this.database.prepare(`
        INSERT INTO item_embeddings(item_id, model_id, input_version, input_hash, dimensions, vector, l2_norm, embedded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id, model_id, input_version) DO UPDATE SET
          input_hash=excluded.input_hash, dimensions=excluded.dimensions, vector=excluded.vector,
          l2_norm=excluded.l2_norm, embedded_at=excluded.embedded_at
      `).run(job.itemId, model, this.config.embeddingInputVersion, input.hash, vector.length, vectorToBlob(vector), norm, now.toISOString());
    }
    const interest = this.database.prepare("SELECT interest FROM item_user_states WHERE item_id = ?").get(job.itemId)?.interest;
    this.enqueueRecommendation(interest === "interested" ? { sourceItemId: job.itemId } : { targetItemId: job.itemId }, job.itemId);
  }

  private embeddingInput(itemId: number): EmbeddingInput {
    const row = this.database.prepare(`
      SELECT i.title,
        (SELECT a.summary_ja FROM item_analyses a WHERE a.item_id = i.id AND a.kind = 'analysis' ORDER BY a.analyzed_at DESC, a.id DESC LIMIT 1) AS summary,
        coalesce(i.extracted_content, i.feed_content) AS content
      FROM items i WHERE i.id = ?
    `).get(itemId) as unknown as ArticleTextRow | undefined;
    if (!row) throw new Error("Article not found");
    return buildEmbeddingInput(row, this.config.embeddingMaxCharacters);
  }

  private enqueueRecommendation(payload: object, itemId?: number): number | null {
    const existing = this.database.prepare(`
      SELECT id FROM jobs WHERE type = 'recommendation' AND status IN ('pending', 'running', 'retry_wait')
        AND (? IS NULL OR item_id = ?) AND payload_json = ? LIMIT 1
    `).get(itemId ?? null, itemId ?? null, JSON.stringify(payload));
    return existing ? null : this.queue.enqueue("recommendation", payload, { ...(itemId ? { itemId } : {}), priority: 30 });
  }

  private embedding(itemId: number): StoredEmbedding | null {
    if (!this.config.embeddingModel) return null;
    const row = this.database.prepare(`
      SELECT item_id, model_id, input_version, dimensions, vector, l2_norm FROM item_embeddings
      WHERE item_id = ? AND model_id = ? AND input_version = ?
    `).get(itemId, this.config.embeddingModel, this.config.embeddingInputVersion) as unknown as EmbeddingRow | undefined;
    if (!row) return null;
    const values = blobToVector(row.vector, row.dimensions);
    const actualNorm = vectorNorm(values);
    if (Math.abs(actualNorm - row.l2_norm) > Math.max(1e-5, actualNorm * 1e-5)) throw new Error("Stored embedding norm does not match vector");
    return { itemId: row.item_id, modelId: row.model_id, inputVersion: row.input_version, values, norm: row.l2_norm };
  }

  private eligibleTargetIds(): readonly number[] {
    return this.database.prepare(`
      SELECT i.id FROM items i LEFT JOIN item_user_states u ON u.item_id = i.id
      WHERE coalesce(u.is_read, 0) = 0 AND u.interest IS NULL
      ORDER BY i.id
    `).all().map((row) => Number(row.id));
  }

  private interestedIds(): readonly number[] {
    return this.database.prepare("SELECT item_id FROM item_user_states WHERE interest = 'interested' ORDER BY item_id")
      .all().map((row) => Number(row.item_id));
  }

  private recalculateAll(now: Date): void {
    for (const targetId of this.eligibleTargetIds()) this.recalculateTarget(targetId, now);
    this.database.prepare(`
      DELETE FROM item_recommendations WHERE target_item_id IN (
        SELECT i.id FROM items i LEFT JOIN item_user_states u ON u.item_id = i.id
        WHERE coalesce(u.is_read, 0) = 1 OR u.interest IS NOT NULL
      )
    `).run();
  }

  private recalculateFromSource(sourceId: number, now: Date): void {
    const state = this.database.prepare("SELECT interest FROM item_user_states WHERE item_id = ?").get(sourceId);
    if (state?.interest !== "interested") return;
    for (const targetId of this.eligibleTargetIds()) this.recalculateTarget(targetId, now);
  }

  private recalculateTarget(targetId: number, now: Date): void {
    if (!this.config.embeddingModel) return;
    const eligible = this.database.prepare(`
      SELECT 1 FROM items i LEFT JOIN item_user_states u ON u.item_id = i.id
      WHERE i.id = ? AND coalesce(u.is_read, 0) = 0 AND u.interest IS NULL
    `).get(targetId);
    if (!eligible) { this.database.prepare("DELETE FROM item_recommendations WHERE target_item_id = ?").run(targetId); return; }
    const target = this.embedding(targetId);
    if (!target) return;
    let best: { sourceId: number; score: number } | null = null;
    for (const sourceId of this.interestedIds()) {
      const source = this.embedding(sourceId);
      if (!source) continue;
      const score = cosineSimilarity(source, target);
      if (!best || score > best.score || (score === best.score && sourceId < best.sourceId)) best = { sourceId, score };
    }
    if (!best || best.score < this.config.recommendationSimilarityThreshold) {
      this.database.prepare("DELETE FROM item_recommendations WHERE target_item_id = ?").run(targetId);
      return;
    }
    this.database.prepare(`
      INSERT INTO item_recommendations(target_item_id, source_item_id, score, model_id, input_version, calculated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_item_id) DO UPDATE SET source_item_id=excluded.source_item_id, score=excluded.score,
        model_id=excluded.model_id, input_version=excluded.input_version, calculated_at=excluded.calculated_at
    `).run(targetId, best.sourceId, best.score, this.config.embeddingModel, this.config.embeddingInputVersion, now.toISOString());
  }
}
