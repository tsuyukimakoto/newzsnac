import type { SourceKind } from "../sources/types.js";

export interface CollectionState {
  readonly cursor?: string | undefined;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
}

export interface CollectedItem {
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly author?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly feedContent?: string | undefined;
  readonly rawMetadata?: unknown | undefined;
}

export interface CollectionResult {
  readonly items: readonly CollectedItem[];
  readonly cursor?: string | undefined;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly checkedAt: string;
  readonly nextFetchAt: string;
  readonly notModified: boolean;
}

export interface CollectionSource {
  readonly id: number;
  readonly kind: SourceKind;
  readonly canonicalUrl: string;
  readonly fetchIntervalMinutes: number;
}

export interface CollectionAdapter {
  readonly kinds: readonly SourceKind[];
  collect(source: CollectionSource, state: CollectionState): Promise<CollectionResult>;
}
