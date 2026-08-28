import type { APIRoute } from "astro";

import docsIndex from "../../generated/scient-docs/index.json";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(docsIndex, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
