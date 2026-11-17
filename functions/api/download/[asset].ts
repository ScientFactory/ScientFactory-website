// FILE: [asset].ts
// Purpose: Counts a download intent, then redirects to the matching official installer.
// Layer: Cloudflare Pages Function

import { findDownloadAsset, type DownloadAssetKey } from "../../../src/lib/download-assets";
import type { Release, ReleaseAsset } from "../../../src/lib/release-schema";
import {
  DESKTOP_LATEST_RELEASE_PAGE_URL,
  isOfficialDesktopReleaseDownload,
} from "../../../src/lib/release-source";
import { cleanPath, queueSiteEvent } from "../../_lib/events";
import { cleanReferrerHost, visitSourceFrom, type VisitSource } from "../../_lib/visitSource";
import {
  LatestReleaseResolutionError,
  resolveLatestDesktopRelease,
  type UpstreamFailure,
} from "../../_lib/latest-release";

const DOWNLOAD_ASSET_KEYS = new Set<DownloadAssetKey>([
  "macArm64",
  "macX64",
  "windowsX64",
  "linuxX64",
]);

class DownloadResolutionError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: string,
    readonly upstream: UpstreamFailure | null = null,
  ) {
    super(reason);
  }
}

function assetKeyFromContext(context: EventContext<Cloudflare.Env, "asset", unknown>) {
  const value = context.params.asset;
  if (typeof value !== "string" || !DOWNLOAD_ASSET_KEYS.has(value as DownloadAssetKey)) {
    return null;
  }
  return value as DownloadAssetKey;
}

async function resolveDownload(
  key: DownloadAssetKey,
  context: Parameters<typeof resolveLatestDesktopRelease>[0],
): Promise<{ readonly release: Release; readonly asset: ReleaseAsset }> {
  let release: Release;
  try {
    release = await resolveLatestDesktopRelease(context);
  } catch (error) {
    if (error instanceof LatestReleaseResolutionError) {
      throw new DownloadResolutionError(error.stage, error.reason, error.upstream);
    }
    throw new DownloadResolutionError("release_fetch", "upstream_request_failed");
  }

  const asset = findDownloadAsset(release, key);
  if (!asset) {
    throw new DownloadResolutionError("asset_resolution", "installer_not_found");
  }
  if (!isOfficialDesktopReleaseDownload(asset.browser_download_url)) {
    throw new DownloadResolutionError("destination_validation", "installer_url_rejected");
  }

  return { release, asset };
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: location,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * The site's download links carry the page they were clicked on and where the visit came from
 * (`page`, `referrer_host`, `landing_path` and the `utm_*` tags). Links from elsewhere have none.
 */
function downloadOrigin(request: Request): { pagePath: string; source: VisitSource } {
  const url = new URL(request.url);
  const source = visitSourceFrom((name) => url.searchParams.get(name), url.hostname);
  let linkingHost: string | null = null;
  try {
    // A download link on another site sends that site as the Referer.
    linkingHost = cleanReferrerHost(
      new URL(request.headers.get("Referer") ?? "").hostname,
      url.hostname,
    );
  } catch {
    /* optional */
  }
  return {
    pagePath: cleanPath(url.searchParams.get("page")) ?? "/download",
    source: { ...source, referrerHost: source.referrerHost ?? linkingHost },
  };
}

async function handleDownload(
  context: EventContext<Cloudflare.Env, "asset", unknown>,
  track: boolean,
): Promise<Response> {
  const key = assetKeyFromContext(context);
  if (!key) return new Response("Not found", { status: 404 });
  const { pagePath, source } = downloadOrigin(context.request);

  try {
    const { release, asset } = await resolveDownload(key, context);
    if (track) {
      const destination = new URL(asset.browser_download_url);
      queueSiteEvent(context, {
        eventName: "download_clicked",
        pagePath,
        ...source,
        assetKey: key,
        releaseTag: release.tag_name,
        assetName: asset.name,
        destinationHost: destination.hostname,
        destinationPath: destination.pathname,
      });
    }
    return redirectResponse(asset.browser_download_url);
  } catch (error) {
    const failure =
      error instanceof DownloadResolutionError
        ? error
        : new DownloadResolutionError("download_resolution", "unexpected_failure");

    if (track) {
      queueSiteEvent(context, {
        eventName: "download_failed",
        pagePath,
        ...source,
        assetKey: key,
        failureStage: failure.stage,
        failureReason: failure.reason,
        upstreamStatus: failure.upstream?.status ?? null,
        upstreamError: failure.upstream?.error ?? null,
        upstreamElapsedMs: failure.upstream?.elapsedMs ?? null,
        upstreamAttempts: failure.upstream?.attempts ?? null,
        fallback: "release_page",
      });
    }

    console.error(
      JSON.stringify({
        message: "Download redirect could not be resolved; sent to the release page",
        assetKey: key,
        stage: failure.stage,
        reason: failure.reason,
        upstream: failure.upstream,
      }),
    );
    // The release page lists every installer, so a visitor still reaches a download.
    return redirectResponse(DESKTOP_LATEST_RELEASE_PAGE_URL);
  }
}

export const onRequestGet: PagesFunction<Cloudflare.Env, "asset"> = (context) =>
  handleDownload(context, true);

// Monitoring can verify the redirect target without adding a click to the product count.
export const onRequestHead: PagesFunction<Cloudflare.Env, "asset"> = (context) =>
  handleDownload(context, false);
