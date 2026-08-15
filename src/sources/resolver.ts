import { parseFeed } from "./feed.js";
import type { PreviewItem, ResolvedSource, SourcePreview } from "./types.js";

export type Fetch = typeof globalThis.fetch;

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function zennSource(url: URL): ResolvedSource | null {
  if (url.hostname !== "zenn.dev") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 1) {
    return { kind: "zenn", canonicalUrl: `https://zenn.dev/${parts[0]}/feed`, displayName: parts[0]! };
  }
  if (parts.length === 2 && parts[0] === "topics") {
    return { kind: "zenn", canonicalUrl: `https://zenn.dev/topics/${parts[1]}/feed`, displayName: `Zenn topic: ${parts[1]}` };
  }
  if (parts.length === 2 && (parts[0] === "p" || parts[0] === "publications")) {
    return { kind: "zenn", canonicalUrl: `https://zenn.dev/p/${parts[1]}/feed`, displayName: `Zenn publication: ${parts[1]}` };
  }
  return null;
}

function feedLink(html: string, base: URL): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*alternate/i.test(tag)) continue;
    if (!/\btype\s*=\s*["']application\/(?:rss|atom)\+xml/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag)?.[1];
    if (href) return new URL(href, base).href;
  }
  return null;
}

export class SourceResolver {
  constructor(private readonly fetcher: Fetch = globalThis.fetch) {}

  async resolve(input: string): Promise<ResolvedSource> {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("Source input must not be empty");

    const handle = trimmed.startsWith("@") ? trimmed.slice(1) :
      (/^[a-z0-9.-]+\.bsky\.social$/i.test(trimmed) ? trimmed : null);
    if (handle) return this.resolveBluesky(handle);

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("Source input must be a supported URL or Bluesky handle");
    }

    if (url.hostname === "bsky.app") {
      const profile = url.pathname.match(/^\/profile\/([^/]+)/)?.[1];
      if (!profile) throw new Error("Bluesky profile URL is invalid");
      return this.resolveBluesky(profile);
    }
    const zenn = zennSource(url);
    if (zenn) return zenn;
    if (url.hostname === "news.ycombinator.com") {
      return { kind: "hacker_news", canonicalUrl: "https://hacker-news.firebaseio.com/v0/topstories.json", displayName: "Hacker News" };
    }

    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    if (/xml|rss|atom/i.test(contentType) || /^\s*<(?:\?xml|rss|feed|rdf:RDF)/i.test(body)) {
      const feed = parseFeed(body);
      return { kind: body.includes("<feed") ? "atom" : "rss", canonicalUrl: canonicalUrl(url.href), displayName: feed.title || url.hostname };
    }
    const discovered = feedLink(body, url);
    if (!discovered) throw new Error("No RSS or Atom feed was found at this URL");
    const feedResponse = await this.fetcher(discovered);
    if (!feedResponse.ok) throw new Error(`Discovered feed returned HTTP ${feedResponse.status}`);
    const feedBody = await feedResponse.text();
    const feed = parseFeed(feedBody);
    return { kind: feedBody.includes("<feed") ? "atom" : "rss", canonicalUrl: canonicalUrl(feedResponse.url || discovered), displayName: feed.title || url.hostname };
  }

  async preview(source: ResolvedSource, existingItemUrls: ReadonlySet<string>): Promise<SourcePreview> {
    const response = await this.fetcher(source.canonicalUrl);
    if (!response.ok) throw new Error(`Preview returned HTTP ${response.status}`);
    let items: readonly PreviewItem[];
    if (source.kind === "bluesky") {
      const data = await response.json() as { feed?: Array<{ post?: { record?: { text?: string; createdAt?: string }; uri?: string } }> };
      items = (data.feed ?? []).map(({ post }) => ({
        title: post?.record?.text?.split("\n")[0] ?? "Bluesky post",
        url: post?.uri ?? "",
        publishedAt: post?.record?.createdAt ?? null,
      })).filter((item) => item.url);
    } else if (source.kind === "hacker_news") {
      items = [];
    } else {
      items = parseFeed(await response.text()).items;
    }
    const recentItems = items.slice(0, 5);
    const dated = items.map((item) => item.publishedAt ? Date.parse(item.publishedAt) : NaN).filter(Number.isFinite).sort((a, b) => b - a);
    const spanDays = dated.length > 1 ? Math.max(1, (dated[0]! - dated.at(-1)!) / 86_400_000) : 7;
    const estimatedWeeklyCount = Math.round((dated.length / spanDays) * 7);
    const overlapCount = recentItems.filter((item) => existingItemUrls.has(canonicalUrl(item.url))).length;
    return { ...source, recentItems, estimatedWeeklyCount, overlapRatio: recentItems.length ? overlapCount / recentItems.length : 0 };
  }

  private async resolveBluesky(handle: string): Promise<ResolvedSource> {
    const endpoint = new URL("https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle");
    endpoint.searchParams.set("handle", handle);
    const response = await this.fetcher(endpoint);
    if (!response.ok) throw new Error(`Bluesky handle could not be resolved (${response.status})`);
    const data = await response.json() as { did?: string };
    if (!data.did) throw new Error("Bluesky response did not contain a DID");
    const feed = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
    feed.searchParams.set("actor", data.did);
    return { kind: "bluesky", canonicalUrl: feed.href, displayName: handle };
  }
}
