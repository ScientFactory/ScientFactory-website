// FILE: release-handoff.ts
// Purpose: Builds trusted website release metadata from Scient's attested release handoff.
// Layer: Shared marketing and Cloudflare utility

import type { Release, ReleaseAsset } from "./release-schema";
import {
  DESKTOP_BETA_RELEASE_REPOSITORY,
  DESKTOP_RELEASE_REPOSITORY,
  desktopMirrorUrl,
  isOfficialDesktopProvenanceRepository,
} from "./release-source";

export interface ReleaseHandoffAsset {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** The validated facts the website relies on from a release handoff. */
export interface ReleaseHandoff {
  readonly version: string;
  readonly tag: string;
  readonly assets: readonly ReleaseHandoffAsset[];
}

/** Where installer downloads point: GitHub, or ScientFactory's verified copy. */
export type ReleaseDownloadHost = "github" | "mirror";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePublishedAt(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function parseAsset(value: unknown): ReleaseHandoffAsset {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value.name) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    throw new Error("Release handoff contains an invalid asset.");
  }
  return { name: value.name, size: value.size, sha256: value.sha256 };
}

export function releaseAssetContentType(name: string): string {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".yml")) return "text/yaml";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".tgz")) return "application/gzip";
  if (name.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

/** The installers every Stable release must carry, one per download card. */
export function requiredInstallerNames(version: string): readonly string[] {
  return [
    `Scient-${version}-arm64.dmg`,
    `Scient-${version}-x64.dmg`,
    `Scient-${version}-x64.exe`,
    `Scient-${version}-x86_64.AppImage`,
  ];
}

export function githubReleaseDownloadUrl(
  tag: string,
  name: string,
  repository: string = DESKTOP_RELEASE_REPOSITORY,
): string {
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

function parseHandoffAssets(value: unknown): readonly ReleaseHandoffAsset[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error("Release handoff is invalid.");
  }
  const assets = value.map(parseAsset);
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new Error("Release handoff contains duplicate assets.");
  }
  return assets;
}

const BETA_VERSION = /^\d+\.\d+\.\d+-beta\.\d{8}\.[1-9]\d*$/u;

/**
 * A handoff for one update channel: Stable's x.y.z or Beta's x.y.z-beta.YYYYMMDD.N, from the
 * official source repository, and, when it names its distribution, distributed on that channel
 * from that channel's repository. Unlike {@link parseReleaseHandoff} it requires no website
 * installers; the update feed checks the electron-updater manifests instead.
 */
export function parseChannelHandoff(value: unknown, channel: "stable" | "beta"): ReleaseHandoff {
  const versionShape = channel === "stable" ? /^\d+\.\d+\.\d+$/u : BETA_VERSION;
  const repository =
    channel === "stable" ? DESKTOP_RELEASE_REPOSITORY : DESKTOP_BETA_RELEASE_REPOSITORY;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.product !== "Scient" ||
    typeof value.version !== "string" ||
    !versionShape.test(value.version) ||
    value.tag !== `v${value.version}` ||
    !isRecord(value.source) ||
    typeof value.source.repository !== "string" ||
    !isOfficialDesktopProvenanceRepository(value.source.repository) ||
    typeof value.source.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source.commit)
  ) {
    throw new Error(`The ${channel} release handoff is invalid.`);
  }
  // Older Stable handoffs predate the distribution record; every Beta handoff carries it.
  if (value.distribution !== undefined || channel === "beta") {
    const distribution = value.distribution;
    if (
      !isRecord(distribution) ||
      distribution.repository !== repository ||
      distribution.channel !== channel
    ) {
      throw new Error(`The ${channel} release handoff names another distribution.`);
    }
  }
  return {
    version: value.version,
    tag: `v${value.version}`,
    assets: parseHandoffAssets(value.assets),
  };
}

export function parseReleaseHandoff(value: unknown): ReleaseHandoff {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.product !== "Scient" ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.version) ||
    value.tag !== `v${value.version}` ||
    !isRecord(value.source) ||
    typeof value.source.repository !== "string" ||
    !isOfficialDesktopProvenanceRepository(value.source.repository) ||
    typeof value.source.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source.commit) ||
    typeof value.source.tree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source.tree)
  ) {
    throw new Error("Release handoff is invalid.");
  }

  const assets = parseHandoffAssets(value.assets);

  const names = new Set(assets.map((asset) => asset.name));
  if (!requiredInstallerNames(value.version).every((name) => names.has(name))) {
    throw new Error("Release handoff is missing a required installer.");
  }

  return { version: value.version, tag: `v${value.version}`, assets };
}

export function releaseFromHandoff(
  value: unknown,
  lastModified: string | null,
  downloads: ReleaseDownloadHost = "github",
): Release {
  const { version, tag, assets } = parseReleaseHandoff(value);
  // Only the installers are mirrored; every other asset stays on GitHub.
  const mirrored = new Set(downloads === "mirror" ? requiredInstallerNames(version) : []);
  const checksumSize = assets.reduce(
    (size, asset) => size + asset.sha256.length + 2 + asset.name.length + 1,
    0,
  );
  const checksumAsset: ReleaseAsset = {
    name: "SHA256SUMS.txt",
    browser_download_url: githubReleaseDownloadUrl(tag, "SHA256SUMS.txt"),
    content_type: "text/plain",
    size: checksumSize,
  };

  return {
    tag_name: tag,
    name: `Scient ${tag}`,
    html_url: `https://github.com/${DESKTOP_RELEASE_REPOSITORY}/releases/tag/${tag}`,
    published_at: parsePublishedAt(lastModified),
    prerelease: false,
    assets: [
      ...assets.map((asset): ReleaseAsset => ({
        name: asset.name,
        browser_download_url: mirrored.has(asset.name)
          ? desktopMirrorUrl(tag, asset.name)
          : githubReleaseDownloadUrl(tag, asset.name),
        content_type: releaseAssetContentType(asset.name),
        size: asset.size,
        digest: `sha256:${asset.sha256}`,
      })),
      checksumAsset,
    ],
  };
}
