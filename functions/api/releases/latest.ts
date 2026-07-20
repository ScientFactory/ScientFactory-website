// FILE: latest.ts
// Purpose: Serves cached, validated desktop release metadata to the marketing site.
// Layer: Cloudflare Pages Function

import { parseRelease } from "../../../src/lib/release-schema";

const GITHUB_RELEASE_URL =
  "https://api.github.com/repos/ScientFactory/scient-desktop/releases/latest";
const CACHE_CONTROL = "public, max-age=300";

function jsonError(message: string, status: number): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

export const onRequestGet: PagesFunction<Cloudflare.Env> = async (context) => {
  const cacheKeyUrl = new URL(context.request.url);
  cacheKeyUrl.search = "";
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const upstream = await fetch(GITHUB_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ScientFactory-download-service",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!upstream.ok) {
      console.error(
        JSON.stringify({
          message: "GitHub release request failed",
          status: upstream.status,
        }),
      );
      return jsonError("Release metadata is temporarily unavailable.", 503);
    }

    const release = parseRelease(await upstream.json());
    const response = Response.json(release, {
      headers: {
        "Cache-Control": CACHE_CONTROL,
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });

    context.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Release metadata handler failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonError("Release metadata is temporarily unavailable.", 503);
  }
};
