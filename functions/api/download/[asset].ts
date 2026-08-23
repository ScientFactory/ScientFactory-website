// FILE: [asset].ts
// Purpose: Counts a download intent, then redirects to the matching official GitHub installer.
// Layer: Cloudflare Pages Function

import { findDownloadAsset, type DownloadAssetKey } from "../../../src/lib/download-assets";
import type { Release, ReleaseAsset } from "../../../src/lib/release-schema";
import { isOfficialDesktopReleaseDownload } from "../../../src/lib/release-source";
import { queueSiteEvent } from "../../_lib/events";
import {
  LatestReleaseResolutionError,
  resolveLatestDesktopRelease,
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
      throw new DownloadResolutionError(error.stage, error.reason);
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

function redirectResponse(asset: ReleaseAsset): Response {
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: asset.browser_download_url,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function unavailableResponse(): Response {
  return Response.json(
    {
      error:
        "This installer is temporarily unavailable. Please return to the download page and try again.",
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": "60",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}

async function handleDownload(
  context: EventContext<Cloudflare.Env, "asset", unknown>,
  track: boolean,
): Promise<Response> {
  const key = assetKeyFromContext(context);
  if (!key) return new Response("Not found", { status: 404 });

  try {
    const { release, asset } = await resolveDownload(key, context);
    if (track) {
      const destination = new URL(asset.browser_download_url);
      queueSiteEvent(context, {
        eventName: "download_clicked",
        pagePath: "/download",
        assetKey: key,
        releaseTag: release.tag_name,
        assetName: asset.name,
        destinationHost: destination.hostname,
        destinationPath: destination.pathname,
      });
    }
    return redirectResponse(asset);
  } catch (error) {
    const failure =
      error instanceof DownloadResolutionError
        ? error
        : new DownloadResolutionError("download_resolution", "unexpected_failure");

    if (track) {
      queueSiteEvent(context, {
        eventName: "download_failed",
        pagePath: "/download",
        assetKey: key,
        failureStage: failure.stage,
        failureReason: failure.reason,
      });
    }

    console.error(
      JSON.stringify({
        message: "Download redirect could not be resolved",
        assetKey: key,
        stage: failure.stage,
        reason: failure.reason,
      }),
    );
    return unavailableResponse();
  }
}

export const onRequestGet: PagesFunction<Cloudflare.Env, "asset"> = (context) =>
  handleDownload(context, true);

// Monitoring can verify the redirect target without adding a click to the product count.
export const onRequestHead: PagesFunction<Cloudflare.Env, "asset"> = (context) =>
  handleDownload(context, false);
