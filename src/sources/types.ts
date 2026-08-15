export type SourceKind = "rss" | "atom" | "hacker_news" | "bluesky" | "zenn";

export interface ResolvedSource {
  readonly kind: SourceKind;
  readonly canonicalUrl: string;
  readonly displayName: string;
}

export interface PreviewItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly content?: string | undefined;
}

export interface SourcePreview extends ResolvedSource {
  readonly recentItems: readonly PreviewItem[];
  readonly estimatedWeeklyCount: number;
  readonly overlapRatio: number;
}
