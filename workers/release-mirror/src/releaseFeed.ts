// FILE: releaseFeed.ts
// Purpose: Reads a desktop repository's GitHub releases Atom feed: the same feed electron-updater's
//          GitHub provider reads for prerelease discovery, release names and release notes.
// Layer: Cloudflare Worker (scheduled)

import { fetchFromGitHub } from "./github";

const FEED_TIMEOUT_MS = 30_000;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
/** Notes larger than this are left out of the feed copy rather than truncated mid-markup. */
export const MAX_RELEASE_NOTES_BYTES = 256 * 1024;

export interface ReleaseFeedEntry {
  readonly tag: string;
  /** The entry title, which electron-updater's GitHub provider reports as `releaseName`. */
  readonly title: string;
  /** The rendered release body (HTML), which that provider reports as `releaseNotes`. */
  readonly content: string;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/gu, (entity, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name] ?? entity;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Entries whose release link points into `repository`; anything else in the feed is ignored. */
export function parseReleaseFeed(xml: string, repository: string): ReleaseFeedEntry[] {
  const link = new RegExp(
    `<link\\b[^>]*\\bhref="https://github\\.com/${escapeRegExp(repository)}/releases/tag/([^"/?#]+)"`,
    "u",
  );
  const entries: ReleaseFeedEntry[] = [];
  for (const [, entry = ""] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gu)) {
    const tag = link.exec(entry)?.[1];
    if (tag === undefined) continue;
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/u.exec(entry)?.[1] ?? "";
    const content = /<content\b[^>]*>([\s\S]*?)<\/content>/u.exec(entry)?.[1] ?? "";
    entries.push({
      tag: decodeURIComponent(tag),
      title: decodeXml(title).trim(),
      content: decodeXml(content),
    });
  }
  return entries;
}

export async function fetchReleaseFeed(
  repository: string,
  userAgent: string,
): Promise<ReleaseFeedEntry[]> {
  const response = await fetchFromGitHub(
    `https://github.com/${repository}/releases.atom`,
    { Accept: "application/atom+xml, application/xml", "User-Agent": userAgent },
    FEED_TIMEOUT_MS,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub returned ${response.status} for the ${repository} release feed.`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_FEED_BYTES) {
    throw new Error(`The ${repository} release feed is too large.`);
  }
  return parseReleaseFeed(new TextDecoder().decode(body), repository);
}
