// FILE: latest-release.ts
// Purpose: Resolves and edge-caches the normalized attested Scient Desktop release.
// Layer: Cloudflare Pages utility

import { releaseFromHandoff } from "../../src/lib/release-handoff";
import { parseRelease, type Release } from "../../src/lib/release-schema";
import {
  DESKTOP_RELEASE_REPOSITORY,
  GITHUB_RELEASE_HANDOFF_URL,
} from "../../src/lib/release-source";

const CACHE_CONTROL = "public, max-age=300";
const CACHE_SCHEMA = "handoff-v1";
const MAX_HANDOFF_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 8_000;

interface ReleaseResolutionContext {
  readonly request: Request;
  waitUntil(promise: Promise<unknown>): void;
}

export class LatestReleaseResolutionError extends Error {
  constructor(
    readonly stage: "release_fetch" | "release_validation",
    readonly reason: "upstream_unavailable" | "release_metadata_invalid",
  ) {
    super(reason);
  }
}

function cacheKey(request: Request): Request {
  const url = new URL("/api/releases/latest", request.url);
  url.searchParams.set("source", DESKTOP_RELEASE_REPOSITORY);
  url.searchParams.set("schema", CACHE_SCHEMA);
  return new Request(url, { method: "GET" });
}

function cachedResponse(release: Release): Response {
  return Response.json(release, {
    headers: {
      "Cache-Control": CACHE_CONTROL,
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readHandoff(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HANDOFF_BYTES) {
      throw new LatestReleaseResolutionError("release_validation", "release_metadata_invalid");
    }
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_HANDOFF_BYTES) {
    throw new LatestReleaseResolutionError("release_validation", "release_metadata_invalid");
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new LatestReleaseResolutionError("release_validation", "release_metadata_invalid");
  }
}

export async function resolveLatestDesktopRelease(
  context: ReleaseResolutionContext,
): Promise<Release> {
  const key = cacheKey(context.request);
  const cached = await caches.default.match(key);
  if (cached) {
    try {
      return parseRelease(await cached.json());
    } catch {
      context.waitUntil(caches.default.delete(key));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(GITHUB_RELEASE_HANDOFF_URL, {
      headers: {
        Accept: "application/octet-stream, application/json",
        "User-Agent": "ScientFactory-download-service",
      },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new LatestReleaseResolutionError("release_fetch", "upstream_unavailable");
  }

  if (!upstream.ok) {
    clearTimeout(timeout);
    throw new LatestReleaseResolutionError("release_fetch", "upstream_unavailable");
  }

  try {
    const release = releaseFromHandoff(
      await readHandoff(upstream),
      upstream.headers.get("Last-Modified"),
    );
    context.waitUntil(caches.default.put(key, cachedResponse(release)));
    return release;
  } catch (error) {
    if (error instanceof LatestReleaseResolutionError) throw error;
    if (controller.signal.aborted) {
      throw new LatestReleaseResolutionError("release_fetch", "upstream_unavailable");
    }
    throw new LatestReleaseResolutionError("release_validation", "release_metadata_invalid");
  } finally {
    clearTimeout(timeout);
  }
}

export function latestReleaseResponse(release: Release): Response {
  return cachedResponse(release);
}
