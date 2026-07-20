// FILE: releases.ts
// Purpose: Resolves trustworthy desktop download assets from the public GitHub release feed.
// Layer: Marketing utility

import { parseRelease, type Release, type ReleaseAsset } from "./release-schema";

export { parseRelease } from "./release-schema";
export type { Release, ReleaseAsset } from "./release-schema";

const REPO = "ScientFactory/scient-desktop";
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const SITE_API_URL = "/api/releases/latest";
const CACHE_KEY = "scient-latest-release-v2";
const CACHE_TTL_MS = 15 * 60 * 1000;
let inFlightRelease: Promise<Release> | null = null;

export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

export const DOWNLOAD_ASSETS = {
  macArm64: { suffix: "-arm64.dmg", label: "macOS Apple Silicon" },
  macX64: { suffix: "-x64.dmg", label: "macOS Intel" },
  windowsX64: { suffix: "-x64.exe", label: "Windows x64" },
  linuxX64: { suffix: "-x86_64.AppImage", label: "Linux x64" },
} as const;

export type DownloadAssetKey = keyof typeof DOWNLOAD_ASSETS;

interface CachedRelease {
  readonly cachedAt: number;
  readonly release: Release;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readCachedRelease(now: number): Release | null {
  if (typeof sessionStorage === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.cachedAt !== "number") return null;
    if (now - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parseRelease(parsed.release);
  } catch {
    return null;
  }
}

function cacheRelease(release: Release, now: number): void {
  if (typeof sessionStorage === "undefined") return;

  try {
    const cached: CachedRelease = { cachedAt: now, release };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Downloads still work when storage is blocked or full.
  }
}

export async function fetchLatestRelease(options?: {
  readonly signal?: AbortSignal;
  readonly force?: boolean;
}): Promise<Release> {
  const now = Date.now();
  const cached = options?.force ? null : readCachedRelease(now);
  if (cached) return cached;
  if (!options?.force && inFlightRelease) return inFlightRelease;

  const request = fetchReleaseFromNetwork(options?.signal, now);
  if (!options?.force) inFlightRelease = request;

  try {
    return await request;
  } finally {
    if (inFlightRelease === request) inFlightRelease = null;
  }
}

async function fetchReleaseFromNetwork(
  signal: AbortSignal | undefined,
  now: number,
): Promise<Release> {
  const isLocalPreview =
    typeof location !== "undefined" &&
    (location.hostname === "127.0.0.1" || location.hostname === "localhost");
  const endpoints = isLocalPreview ? [GITHUB_API_URL] : [SITE_API_URL, GITHUB_API_URL];

  let lastStatus: number | null = null;
  for (const endpoint of endpoints) {
    try {
      const requestInit: RequestInit = {
        headers: { Accept: "application/vnd.github+json" },
        ...(signal ? { signal } : {}),
      };
      const response = await fetch(endpoint, requestInit);
      lastStatus = response.status;
      if (!response.ok) continue;

      const release = parseRelease(await response.json());
      cacheRelease(release, now);
      return release;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  throw new Error(
    lastStatus === null
      ? "Release request failed before receiving a response."
      : `Release request failed (${lastStatus}).`,
  );
}

export function findDownloadAsset(release: Release, key: DownloadAssetKey): ReleaseAsset | null {
  const expected = DOWNLOAD_ASSETS[key];
  return release.assets.find((asset) => asset.name.endsWith(expected.suffix)) ?? null;
}

export function findChecksumAsset(release: Release): ReleaseAsset | null {
  return release.assets.find((asset) => asset.name === "SHA256SUMS.txt") ?? null;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];

  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
