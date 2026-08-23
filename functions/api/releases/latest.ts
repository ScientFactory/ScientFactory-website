// FILE: latest.ts
// Purpose: Serves cached, validated desktop release metadata to the marketing site.
// Layer: Cloudflare Pages Function

import { latestReleaseResponse, resolveLatestDesktopRelease } from "../../_lib/latest-release";

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
  try {
    return latestReleaseResponse(await resolveLatestDesktopRelease(context));
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
