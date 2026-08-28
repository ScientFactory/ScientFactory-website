import type { APIRoute } from "astro";

import docsIndex from "../../../generated/scient-docs/index.json";
import rawPages from "../../../generated/scient-docs/raw.json";

export const prerender = true;

export function getStaticPaths() {
  return docsIndex.pages.map((page) => ({ params: { slug: page.slug } }));
}

export const GET: APIRoute = ({ params }) => {
  const slug = params.slug ?? "";
  const markdown = rawPages[slug as keyof typeof rawPages];
  if (typeof markdown !== "string") return new Response("Not found\n", { status: 404 });
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Scient-Docs-Source": docsIndex.source.revision,
    },
  });
};
