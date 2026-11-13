// FILE: latest-release.ts
// Purpose: Resolves and edge-caches the normalized attested Scient Desktop release.
// Layer: Cloudflare Pages utility

import { releaseFromHandoff } from "../../src/lib/release-handoff";
import { parseRelease, type Release } from "../../src/lib/release-schema";
import {
  DESKTOP_RELEASE_REPOSITORY,
  GITHUB_RELEASE_HANDOFF_URL,
} from "../../src/lib/release-source";
import { readMirroredRelease, type MirroredRelease } from "./release-mirror";

const CACHE_CONTROL = "public, max-age=300";
const CACHE_SCHEMA = "handoff-v2";
const MAX_HANDOFF_BYTES = 64 * 1024;
const ATTEMPT_TIMEOUT_MS = 4_000;
const RETRY_DELAY_MS = 250;
const MAX_ATTEMPTS = 2;
// The mirror worker re-checks GitHub every ten minutes. A pointer it has not confirmed for this
// long may be behind a newer release, so GitHub is asked first and the pointer is the fallback.
const MIRROR_FRESH_MS = 6 * 60 * 60 * 1000;

export interface ReleaseResolutionContext {
  readonly request: Request;
  readonly env: { readonly DESKTOP_DOWNLOADS?: R2Bucket };
  waitUntil(promise: Promise<unknown>): void;
}

/** What GitHub did on the last attempt, so a failure says more than "unavailable". */
export interface UpstreamFailure {
  /** HTTP status of the final response; null when no response arrived. */
  readonly status: number | null;
  /** Error name when no usable response arrived, e.g. TimeoutError or TypeError. */
  readonly error: string | null;
  readonly elapsedMs: number;
  readonly attempts: number;
}

export class LatestReleaseResolutionError extends Error {
  constructor(
    readonly stage: "release_fetch" | "release_validation",
    readonly reason: "upstream_unavailable" | "release_metadata_invalid",
    readonly upstream: UpstreamFailure | null = null,
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

/** Reads a handoff body within the size limit; shared with the release mirror worker. */
export async function readHandoff(response: Response): Promise<unknown> {
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 60) : "unknown";
}

type Attempt =
  | { readonly release: Release }
  | { readonly status: number | null; readonly error: string | null };

async function attemptGitHub(): Promise<Attempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const upstream = await fetch(GITHUB_RELEASE_HANDOFF_URL, {
      headers: {
        Accept: "application/octet-stream, application/json",
        "User-Agent": "ScientFactory-download-service",
      },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return { status: upstream.status, error: null };
    }
    const handoff = await readHandoff(upstream);
    try {
      return { release: releaseFromHandoff(handoff, upstream.headers.get("Last-Modified")) };
    } catch {
      throw new LatestReleaseResolutionError("release_validation", "release_metadata_invalid");
    }
  } catch (error) {
    if (error instanceof LatestReleaseResolutionError) throw error;
    return { status: null, error: controller.signal.aborted ? "TimeoutError" : errorName(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One retry for failures that may pass (no response, timeouts, 5xx). A 4xx, including GitHub's
 * 403/429 refusals, is not retried: asking again within a second does not change the answer.
 */
async function fetchGitHubRelease(): Promise<Release> {
  const started = Date.now();
  for (let attempts = 1; ; attempts += 1) {
    const result = await attemptGitHub();
    if ("release" in result) return result.release;
    const transient = result.status === null || result.status >= 500;
    if (!transient || attempts >= MAX_ATTEMPTS) {
      throw new LatestReleaseResolutionError("release_fetch", "upstream_unavailable", {
        ...result,
        elapsedMs: Date.now() - started,
        attempts,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

async function readMirror(context: ReleaseResolutionContext): Promise<MirroredRelease | null> {
  const bucket = context.env.DESKTOP_DOWNLOADS;
  if (!bucket) return null;
  try {
    return await readMirroredRelease(bucket);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Desktop mirror pointer could not be read",
        error: errorName(error),
        detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
      }),
    );
    return null;
  }
}

/**
 * Resolution order: the edge cache, then ScientFactory's verified mirror while it is fresh,
 * then GitHub's latest handoff, then the mirror however old it is. GitHub is only on the
 * download path when the mirror is missing or stale.
 */
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

  const mirror = await readMirror(context);
  const mirrorIsFresh = mirror !== null && Date.now() - mirror.checkedAtMs <= MIRROR_FRESH_MS;
  let release = mirrorIsFresh
    ? null
    : await fetchGitHubRelease().catch((error: unknown) => {
        if (mirror === null) throw error;
        console.error(
          JSON.stringify({
            message: "GitHub release metadata failed; serving the last mirrored release",
            mirroredTag: mirror.handoff.tag,
            checkedAt: mirror.pointer.checkedAt,
            ...(error instanceof LatestReleaseResolutionError
              ? { reason: error.reason, upstream: error.upstream }
              : { error: errorName(error) }),
          }),
        );
        return null;
      });
  // Reaching here without a GitHub release means the mirror exists: GitHub failures without one rethrow.
  release ??= releaseFromHandoff(mirror!.pointer.handoff, mirror!.pointer.publishedAt, "mirror");

  context.waitUntil(caches.default.put(key, cachedResponse(release)));
  return release;
}

export function latestReleaseResponse(release: Release): Response {
  return cachedResponse(release);
}
