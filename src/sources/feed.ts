import { XMLParser } from "fast-xml-parser";
import type { PreviewItem } from "./types.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function array<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value as readonly T[] : [value as T];
}

function decodeCharacterReferences(value: string): string {
  return value.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (reference, hexadecimal: string | undefined, decimal: string | undefined) => {
    const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) return reference;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return reference;
    }
  });
}

function text(value: unknown): string {
  if (typeof value === "string") return decodeCharacterReferences(value);
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as { "#text": unknown })["#text"]);
  }
  return "";
}

function atomLink(value: unknown): string {
  for (const link of array(value)) {
    if (typeof link === "string") return link;
    if (link && typeof link === "object") {
      const attributes = link as { "@_href"?: unknown; "@_rel"?: unknown };
      if ((attributes["@_rel"] ?? "alternate") === "alternate") {
        return text(attributes["@_href"]);
      }
    }
  }
  return "";
}

export interface ParsedFeed {
  readonly title: string;
  readonly items: readonly PreviewItem[];
}

export function parseFeed(xml: string): ParsedFeed {
  const document = parser.parse(xml) as Record<string, unknown>;
  const rss = document.rss as { channel?: Record<string, unknown> } | undefined;
  if (rss?.channel) {
    const channel = rss.channel;
    return {
      title: text(channel.title),
      items: array(channel.item).map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          title: text(item.title),
          url: text(item.link) || text(item.guid),
          publishedAt: text(item.pubDate) || text(item.date) || null,
          content: text(item["content:encoded"]) || text(item.description) || undefined,
        };
      }).filter((item) => item.url.length > 0),
    };
  }

  const rdf = document["rdf:RDF"] as Record<string, unknown> | undefined;
  if (rdf) {
    const channel = rdf.channel as Record<string, unknown> | undefined;
    return {
      title: text(channel?.title),
      items: array(rdf.item).map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          title: text(item.title),
          url: text(item.link) || text(item["@_rdf:about"]),
          publishedAt: text(item["dc:date"]) || text(item.date) || null,
          content: text(item["content:encoded"]) || text(item.description) || undefined,
        };
      }).filter((item) => item.url.length > 0),
    };
  }

  const feed = document.feed as Record<string, unknown> | undefined;
  if (feed) {
    return {
      title: text(feed.title),
      items: array(feed.entry).map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          title: text(item.title),
          url: atomLink(item.link) || text(item.id),
          publishedAt: text(item.published) || text(item.updated) || null,
          content: text(item.content) || text(item.summary) || undefined,
        };
      }).filter((item) => item.url.length > 0),
    };
  }

  throw new Error("The response is not an RSS or Atom feed");
}

export function parseOpml(xml: string): readonly string[] {
  const document = parser.parse(xml) as Record<string, unknown>;
  const opml = document.opml as { body?: { outline?: unknown } } | undefined;
  if (!opml?.body) throw new Error("The document is not valid OPML");
  const urls: string[] = [];
  const visit = (value: unknown): void => {
    for (const entry of array(value)) {
      if (!entry || typeof entry !== "object") continue;
      const outline = entry as { "@_xmlUrl"?: unknown; outline?: unknown };
      const url = text(outline["@_xmlUrl"]);
      if (url) urls.push(url);
      visit(outline.outline);
    }
  };
  visit(opml.body.outline);
  return [...new Set(urls)];
}
