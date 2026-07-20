// FILE: [asset].ts
// Purpose: Counts a download intent, then redirects to the matching official GitHub installer.
// Layer: Cloudflare Pages Function

import { findDownloadAsset, type DownloadAssetKey } from "../../../src/lib/download-assets";
import { parseRelease, type Release, type ReleaseAsset } from "../../../src/lib/release-schema";
import { queueSiteEvent } from "../../_lib/events";

const GITHUB_RELEASE_URL =
  "https://api.github.com/repos/ScientFactory/scient-desktop/releases/latest";
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

function isOfficialDownload(asset: ReleaseAsset): boolean {
  try {
    const destination = new URL(asset.browser_download_url);
    return (
      destination.protocol === "https:" &&
      destination.hostname === "github.com" &&
      destination.pathname.startsWith("/ScientFactory/scient-desktop/releases/download/")
    );
  } catch {
    return false;
  }
}

async function resolveDownload(key: DownloadAssetKey): Promise<{
  readonly release: Release;
  readonly asset: ReleaseAsset;
}> {
  let upstream: Response;
  try {
    upstream = await fetch(GITHUB_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ScientFactory-download-service",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new DownloadResolutionError("release_fetch", "upstream_request_failed");
  }

  if (!upstream.ok) {
    throw new DownloadResolutionError("release_fetch", "upstream_unavailable");
  }

  let release: Release;
  try {
    release = parseRelease(await upstream.json());
  } catch {
    throw new DownloadResolutionError("release_validation", "release_metadata_invalid");
  }

  const asset = findDownloadAsset(release, key);
  if (!asset) {
    throw new DownloadResolutionError("asset_resolution", "installer_not_found");
  }
  if (!isOfficialDownload(asset)) {
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
    const { release, asset } = await resolveDownload(key);
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
