// FILE: updateFeed.ts
// Purpose: Publishes the desktop app's Stable and Beta electron-updater feeds from verified copies
//          of the GitHub releases.
// Layer: Cloudflare Worker (scheduled)

import { readHandoff } from "../../../functions/_lib/latest-release";
import {
  githubReleaseDownloadUrl,
  parseChannelHandoff,
  type ReleaseHandoff,
  type ReleaseHandoffAsset,
} from "../../../src/lib/release-handoff";
import {
  DESKTOP_BETA_RELEASE_REPOSITORY,
  DESKTOP_RELEASE_REPOSITORY,
  desktopUpdateFeedKey,
  DESKTOP_UPDATE_FEED_PREFIX,
  type DesktopUpdateFeedChannel,
} from "../../../src/lib/release-source";
import { mirrorReleaseAsset, USER_AGENT } from "./mirror";
import { fetchReleaseFeed, MAX_RELEASE_NOTES_BYTES, type ReleaseFeedEntry } from "./releaseFeed";
import { feedUpdateManifest, parseUpdateManifest } from "./updateManifest";

const HANDOFF_TIMEOUT_MS = 30_000;
const MANIFEST_TIMEOUT_MS = 30_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/**
 * Channel metadata moves on every release, so nothing may keep a copy; clients also add a
 * random `noCache` query to each check. Only the versioned objects it names are cacheable.
 */
export const FEED_CACHE_CONTROL = "no-store";

interface ChannelSource {
  readonly repository: string;
  /** electron-updater's channel file prefix: `latest` for Stable, `beta` for Beta. */
  readonly manifestPrefix: "latest" | "beta";
}

const CHANNELS: Readonly<Record<DesktopUpdateFeedChannel, ChannelSource>> = {
  stable: { repository: DESKTOP_RELEASE_REPOSITORY, manifestPrefix: "latest" },
  beta: { repository: DESKTOP_BETA_RELEASE_REPOSITORY, manifestPrefix: "beta" },
};

/** The manifests every release carries: macOS, Windows and Linux x64. */
function requiredManifestNames(prefix: string): readonly string[] {
  return [`${prefix}-mac.yml`, `${prefix}.yml`, `${prefix}-linux.yml`];
}

function isChannelManifest(name: string, prefix: string): boolean {
  return new RegExp(`^${prefix}(?:-mac|-linux(?:-[a-z0-9]+)?)?\\.yml$`, "u").test(name);
}

export interface UpdateFeedSyncResult {
  readonly channel: DesktopUpdateFeedChannel;
  /** Null only when the channel has no published release yet. */
  readonly tag: string | null;
  /** Versioned objects copied this run; empty when the bucket already held every one. */
  readonly copied: readonly string[];
  /** Channel manifests this run moved to `tag`. */
  readonly promoted: readonly string[];
  /** Channel manifests another run wrote first, so this run left them alone. */
  readonly superseded: readonly string[];
}

const BETA_TAG = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d{8})\.([1-9]\d*)$/u;

function betaOrder(tag: string): readonly number[] | null {
  const match = BETA_TAG.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compareOrder(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** The newest Beta in the feed, by version rather than by the feed's order. */
export function newestBetaEntry(entries: readonly ReleaseFeedEntry[]): ReleaseFeedEntry | null {
  let newest: { entry: ReleaseFeedEntry; order: readonly number[] } | null = null;
  for (const entry of entries) {
    const order = betaOrder(entry.tag);
    if (order !== null && (newest === null || compareOrder(order, newest.order) > 0)) {
      newest = { entry, order };
    }
  }
  return newest?.entry ?? null;
}

async function fetchHandoff(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/octet-stream, application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub returned ${response.status} for the release handoff.`);
  }
  return readHandoff(response);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A release manifest's text, only if it is exactly the bytes the handoff attests. */
async function fetchManifest(
  repository: string,
  tag: string,
  asset: ReleaseHandoffAsset,
): Promise<string> {
  if (asset.size > MAX_MANIFEST_BYTES) throw new Error(`${asset.name} is too large.`);
  const response = await fetch(githubReleaseDownloadUrl(tag, asset.name, repository), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub returned ${response.status} for ${asset.name}.`);
  }
  const body = await response.arrayBuffer();
  const digest = hex(await crypto.subtle.digest("SHA-256", body));
  if (body.byteLength !== asset.size || digest !== asset.sha256) {
    throw new Error(`${asset.name} does not match the release handoff.`);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
}

interface VerifiedManifest {
  readonly asset: ReleaseHandoffAsset;
  readonly text: string;
}

/**
 * Everything one release's feed needs, checked against both of the release's own records:
 * each manifest against the handoff's SHA-256, and each file it names against the handoff's
 * size (here) and the manifest's SHA-512 (while copying).
 */
function planFeedObjects(handoff: ReleaseHandoff, manifests: readonly VerifiedManifest[]) {
  const byName = new Map(handoff.assets.map((asset) => [asset.name, asset]));
  const payloads = new Map<string, { asset: ReleaseHandoffAsset; sha512: string }>();
  for (const { asset, text } of manifests) {
    const manifest = parseUpdateManifest(text, asset.name);
    if (manifest.version !== handoff.version) {
      throw new Error(
        `${asset.name} is for ${manifest.version}; the handoff is ${handoff.version}.`,
      );
    }
    const required = asset.name.endsWith("-mac.yml")
      ? [
          `Scient-${handoff.version}-arm64.dmg`,
          `Scient-${handoff.version}-arm64.zip`,
          `Scient-${handoff.version}-x64.dmg`,
          `Scient-${handoff.version}-x64.zip`,
        ]
      : asset.name === "latest.yml" || asset.name === "beta.yml"
        ? [`Scient-${handoff.version}-x64.exe`]
        : asset.name.endsWith("-linux.yml")
          ? [`Scient-${handoff.version}-x86_64.AppImage`]
          : [];
    for (const name of required) {
      if (!manifest.files.some((file) => file.url === name)) {
        throw new Error(`${asset.name} does not reference required ${name}.`);
      }
    }
    for (const file of manifest.files) {
      const payload = byName.get(file.url);
      if (payload === undefined) {
        throw new Error(`${asset.name} names ${file.url}, which the handoff does not list.`);
      }
      if (payload.size !== file.size) {
        throw new Error(
          `${asset.name} says ${file.url} is ${file.size} bytes; the handoff says ${payload.size}.`,
        );
      }
      const known = payloads.get(file.url);
      if (known !== undefined && known.sha512 !== file.sha512) {
        throw new Error(`The release's manifests disagree about ${file.url}.`);
      }
      payloads.set(file.url, { asset: payload, sha512: file.sha512 });
    }
  }
  const blockmaps: ReleaseHandoffAsset[] = [];
  for (const name of payloads.keys()) {
    const blockmap = byName.get(`${name}.blockmap`);
    if (blockmap !== undefined) blockmaps.push(blockmap);
    else if (/\.(?:zip|exe)$/u.test(name)) {
      throw new Error(`Handoff ${handoff.tag} has no required ${name}.blockmap.`);
    }
  }
  return { payloads: [...payloads.values()], blockmaps };
}

function releaseOf(entry: ReleaseFeedEntry, tag: string) {
  return {
    name: entry.title || tag,
    notes:
      new TextEncoder().encode(entry.content).byteLength > MAX_RELEASE_NOTES_BYTES
        ? ""
        : entry.content,
  };
}

/**
 * Brings one channel's generic update feed up to GitHub's newest release on that channel.
 * Every versioned object the release's manifests need (manifests, payloads, blockmaps) is copied
 * into `scient-desktop/<tag>/` first; the channel manifests under
 * `scient-desktop/updates/<channel>/` move last, each as a compare-and-swap on the version this
 * run saw at its start, so a feed never names bytes that are not there and a slow run cannot
 * undo a newer promotion. Older versions stay in the bucket.
 */
export async function syncUpdateFeed(
  bucket: R2Bucket,
  channel: DesktopUpdateFeedChannel,
): Promise<UpdateFeedSyncResult> {
  const { repository, manifestPrefix } = CHANNELS[channel];
  // Captured before anything this run learns from GitHub, like the Stable pointer.
  const listed = await bucket.list({
    prefix: `${DESKTOP_UPDATE_FEED_PREFIX}${channel}/`,
    include: ["customMetadata"],
  });
  const observed = new Map(listed.objects.map((object) => [object.key, object]));

  let feed: ReleaseFeedEntry[] | null = null;
  let handoff: ReleaseHandoff;
  if (channel === "beta") {
    // Beta releases are prereleases, which GitHub's `latest` never names. electron-updater's
    // GitHub provider finds them the same way, in the releases feed.
    feed = await fetchReleaseFeed(repository, USER_AGENT);
    const newest = newestBetaEntry(feed);
    if (newest === null) {
      return { channel, tag: null, copied: [], promoted: [], superseded: [] };
    }
    handoff = parseChannelHandoff(
      await fetchHandoff(
        githubReleaseDownloadUrl(newest.tag, "scient-release-handoff.json", repository),
      ),
      channel,
    );
    if (handoff.tag !== newest.tag) {
      throw new Error(`The ${newest.tag} release carries the ${handoff.tag} handoff.`);
    }
  } else {
    handoff = parseChannelHandoff(
      await fetchHandoff(
        `https://github.com/${repository}/releases/latest/download/scient-release-handoff.json`,
      ),
      channel,
    );
  }
  const { tag } = handoff;

  const manifestAssets = handoff.assets.filter((asset) =>
    isChannelManifest(asset.name, manifestPrefix),
  );
  for (const required of requiredManifestNames(manifestPrefix)) {
    if (!manifestAssets.some((asset) => asset.name === required)) {
      throw new Error(`Handoff ${tag} has no ${required}.`);
    }
  }

  const candidateOrder =
    channel === "beta" ? betaOrder(handoff.tag)! : handoff.version.split(".").map(Number);
  for (const asset of manifestAssets) {
    const metadata = observed.get(desktopUpdateFeedKey(channel, asset.name))?.customMetadata;
    if (metadata === undefined) continue;
    const version = metadata.version ?? "";
    const previousOrder =
      channel === "beta"
        ? betaOrder(`v${version}`)
        : /^\d+\.\d+\.\d+$/u.test(version)
          ? version.split(".").map(Number)
          : null;
    if (previousOrder === null || compareOrder(candidateOrder, previousOrder) < 0) {
      throw new Error(
        `Refusing to regress ${asset.name} from ${metadata.version ?? "unknown"} to ${handoff.version}.`,
      );
    }
  }

  const current = (asset: ReleaseHandoffAsset) => {
    const metadata = observed.get(desktopUpdateFeedKey(channel, asset.name))?.customMetadata;
    return metadata?.tag === tag && metadata.sourceSha256 === asset.sha256;
  };
  if (manifestAssets.every(current)) {
    return { channel, tag, copied: [], promoted: [], superseded: [] };
  }

  // The release's name and notes, as GitHub's provider showed them to clients.
  feed ??= await fetchReleaseFeed(repository, USER_AGENT);
  const entry = feed.find((candidate) => candidate.tag === tag);
  if (entry === undefined) {
    throw new Error(`The ${repository} release feed does not list ${tag} yet.`);
  }

  const manifests: VerifiedManifest[] = [];
  for (const asset of manifestAssets) {
    manifests.push({ asset, text: await fetchManifest(repository, tag, asset) });
  }
  const { payloads, blockmaps } = planFeedObjects(handoff, manifests);

  const copied: string[] = [];
  const copy = async (asset: ReleaseHandoffAsset, sha512?: string) => {
    const source = { repository, tag, asset, ...(sha512 === undefined ? {} : { sha512 }) };
    if (await mirrorReleaseAsset(bucket, source)) copied.push(asset.name);
  };
  for (const payload of payloads) await copy(payload.asset, payload.sha512);
  for (const blockmap of blockmaps) await copy(blockmap);
  // The release's own manifests, byte for byte, as the record of what each version offered.
  for (const { asset } of manifests) await copy(asset);

  const release = releaseOf(entry, tag);
  const promoted: string[] = [];
  const superseded: string[] = [];
  for (const { asset, text } of manifests.toSorted((a, b) =>
    a.asset.name.localeCompare(b.asset.name),
  )) {
    if (current(asset)) continue;
    const key = desktopUpdateFeedKey(channel, asset.name);
    const seen = observed.get(key);
    const written = await bucket.put(key, feedUpdateManifest(text, asset.name, tag, release), {
      onlyIf:
        seen === undefined ? new Headers({ "If-None-Match": "*" }) : { etagMatches: seen.etag },
      httpMetadata: {
        contentType: "text/yaml; charset=utf-8",
        cacheControl: FEED_CACHE_CONTROL,
      },
      customMetadata: { tag, version: handoff.version, sourceSha256: asset.sha256 },
    });
    (written === null ? superseded : promoted).push(asset.name);
  }
  return { channel, tag, copied, promoted, superseded };
}
