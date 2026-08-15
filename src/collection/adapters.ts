import { parseFeed } from "../sources/feed.js";
import type { Fetch } from "../sources/resolver.js";
import type { CollectedItem, CollectionAdapter, CollectionResult, CollectionSource, CollectionState } from "./types.js";

function schedule(source: CollectionSource, now: Date): string {
  return new Date(now.getTime() + source.fetchIntervalMinutes * 60_000).toISOString();
}

export class FeedAdapter implements CollectionAdapter {
  readonly kinds = ["rss", "atom", "zenn"] as const;
  constructor(private readonly fetcher: Fetch = globalThis.fetch, private readonly clock = () => new Date()) {}

  async collect(source: CollectionSource, state: CollectionState): Promise<CollectionResult> {
    const headers = new Headers();
    if (state.etag) headers.set("if-none-match", state.etag);
    if (state.lastModified) headers.set("if-modified-since", state.lastModified);
    const response = await this.fetcher(source.canonicalUrl, { headers });
    const now = this.clock();
    if (response.status === 304) {
      return { items: [], etag: state.etag, lastModified: state.lastModified, checkedAt: now.toISOString(), nextFetchAt: schedule(source, now), notModified: true };
    }
    if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
    const feed = parseFeed(await response.text());
    return {
      items: feed.items.map((item) => ({ externalId: item.url, ...item, publishedAt: item.publishedAt ?? undefined })),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      checkedAt: now.toISOString(),
      nextFetchAt: schedule(source, now),
      notModified: false,
    };
  }
}

export class HackerNewsAdapter implements CollectionAdapter {
  readonly kinds = ["hacker_news"] as const;
  constructor(private readonly fetcher: Fetch = globalThis.fetch, private readonly limit = 30, private readonly clock = () => new Date()) {}

  async collect(source: CollectionSource): Promise<CollectionResult> {
    const response = await this.fetcher(source.canonicalUrl);
    if (!response.ok) throw new Error(`Hacker News returned HTTP ${response.status}`);
    const ids = (await response.json() as number[]).slice(0, this.limit);
    const items = (await Promise.all(ids.map(async (id): Promise<CollectedItem | null> => {
      const itemResponse = await this.fetcher(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!itemResponse.ok) return null;
      const item = await itemResponse.json() as { id: number; title?: string; url?: string; by?: string; time?: number; deleted?: boolean };
      if (item.deleted || !item.title) return null;
      return {
        externalId: String(item.id), title: item.title,
        url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
        author: item.by, publishedAt: item.time ? new Date(item.time * 1000).toISOString() : undefined,
        rawMetadata: item,
      };
    }))).filter((item): item is CollectedItem => item !== null);
    const now = this.clock();
    return { items, cursor: ids[0] ? String(ids[0]) : undefined, checkedAt: now.toISOString(), nextFetchAt: schedule(source, now), notModified: false };
  }
}

export class BlueskyAdapter implements CollectionAdapter {
  readonly kinds = ["bluesky"] as const;
  constructor(private readonly fetcher: Fetch = globalThis.fetch, private readonly clock = () => new Date()) {}

  async collect(source: CollectionSource, state: CollectionState): Promise<CollectionResult> {
    const url = new URL(source.canonicalUrl);
    if (state.cursor) url.searchParams.set("cursor", state.cursor);
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Bluesky returned HTTP ${response.status}`);
    const data = await response.json() as { cursor?: string; feed?: Array<{ post: { uri: string; author?: { handle?: string }; record?: { text?: string; createdAt?: string; embed?: { external?: { uri?: string; title?: string } } } } }> };
    const items = (data.feed ?? []).map(({ post }): CollectedItem => ({
      externalId: post.uri,
      url: post.record?.embed?.external?.uri ?? post.uri,
      title: post.record?.embed?.external?.title ?? post.record?.text?.split("\n")[0] ?? "Bluesky post",
      author: post.author?.handle,
      publishedAt: post.record?.createdAt,
      feedContent: post.record?.text,
      rawMetadata: post,
    }));
    const now = this.clock();
    return { items, cursor: data.cursor, checkedAt: now.toISOString(), nextFetchAt: schedule(source, now), notModified: false };
  }
}
