// FILE: seo.test.ts
// Purpose: Keep crawler discovery files aligned with the public marketing routes.
// Layer: Marketing tests
// Depends on: static files in public/

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const publicDirectory = new URL("../public/", import.meta.url);
const robots = readFileSync(new URL("robots.txt", publicDirectory), "utf8");
const sitemap = readFileSync(new URL("sitemap.xml", publicDirectory), "utf8");

const publicURLs = [
  "https://scientfactory.com/",
  "https://scientfactory.com/about/",
  "https://scientfactory.com/docs/getting-started/",
  "https://scientfactory.com/privacy/",
] as const;

describe("search discovery files", () => {
  it("redirects retired download URLs to the About download section", () => {
    const redirects = readFileSync(new URL("_redirects", publicDirectory), "utf8");
    expect(redirects).toContain("/download /about/#downloads 301");
    expect(redirects).toContain("/download/ /about/#downloads 301");
  });

  it("redirects the Docs landing page to Getting started", () => {
    const redirects = readFileSync(new URL("_redirects", publicDirectory), "utf8");
    expect(redirects).toContain("/docs /docs/getting-started/ 301");
    expect(redirects).toContain("/docs/ /docs/getting-started/ 301");
    expect(sitemap).not.toContain("<loc>https://scientfactory.com/docs/</loc>");
  });

  it("allows crawling and advertises the canonical sitemap", () => {
    expect(robots).toBe(
      "User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://scientfactory.com/sitemap.xml\n",
    );
  });

  it("publishes every canonical marketing route exactly once", () => {
    for (const url of publicURLs) {
      expect(
        sitemap.match(new RegExp(`<loc>${url.replaceAll("/", "\\/")}</loc>`, "g")),
      ).toHaveLength(1);
    }

    expect(sitemap.match(/<url>/g)).toHaveLength(publicURLs.length);
    expect(sitemap).not.toContain("/404");
    expect(sitemap).not.toContain("/download/");
  });
});
