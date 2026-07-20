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
  "https://scientfactory.com/docs/",
  "https://scientfactory.com/download/",
  "https://scientfactory.com/privacy/",
] as const;

describe("search discovery files", () => {
  it("allows crawling and advertises the canonical sitemap", () => {
    expect(robots).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://scientfactory.com/sitemap.xml\n",
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
  });
});
