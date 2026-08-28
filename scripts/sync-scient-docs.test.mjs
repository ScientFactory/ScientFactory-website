import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  generateDocs,
  hashMarkdown,
  rewriteHelpLinks,
  validateManifest,
} from "./sync-scient-docs.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fixtureManifest(markdown = "# Getting started\n\nSee [Providers](./providers.md).\n") {
  return {
    schemaVersion: 1,
    channel: "preview",
    source: {
      repository: "ScientFactory/scient-desktop",
      revision: "a".repeat(40),
      reviewedAt: "2026-08-28",
    },
    version: {
      label: "Pilot preview",
      appliesTo: "Unreleased candidate",
      stableReleaseTags: [],
    },
    corpusDefaults: { product: "Scient Desktop", surface: "desktop" },
    publication: {
      releaseTrigger: "Reviewed release manifest update",
      correctionTrigger: "Reviewed Help correction manifest update",
      maximumLagHours: 24,
      failureMode: "Fail closed",
      rollback: "Revert the pin",
    },
    pages: [
      {
        slug: "getting-started",
        title: "Getting started",
        summary: "Start using Scient.",
        topic: "Start",
        sourcePath: "docs/user/getting-started.md",
        sha256: hashMarkdown(markdown),
      },
      {
        slug: "providers",
        title: "Providers",
        summary: "Connect a provider.",
        topic: "Providers",
        sourcePath: "docs/user/providers.md",
        sha256: hashMarkdown("# Providers\n"),
      },
    ],
  };
}

describe("Scient Docs manifest", () => {
  it("serves raw Markdown and the machine index with explicit UTF-8 content types", () => {
    const headers = readFileSync(join(repositoryRoot, "public/_headers"), "utf8");
    assert.match(headers, /\/docs\/raw\/\*\s+Content-Type: text\/markdown; charset=utf-8/);
    assert.match(headers, /\/docs\/index\.json\s+Content-Type: application\/json; charset=utf-8/);
  });

  it("requires immutable revisions, unique pages, and stable release qualification", () => {
    const manifest = fixtureManifest();
    assert.equal(validateManifest(manifest), manifest);
    assert.throws(() => validateManifest({ ...manifest, channel: "stable" }), /release tag/);
    assert.throws(
      () => validateManifest({ ...manifest, source: { ...manifest.source, revision: "main" } }),
      /40-character Git SHA/,
    );
    assert.throws(
      () => validateManifest({ ...manifest, pages: [manifest.pages[0], manifest.pages[0]] }),
      /Duplicate Scient Docs slug/,
    );
    assert.throws(
      () =>
        validateManifest({
          ...manifest,
          pages: [{ ...manifest.pages[0], sourcePath: "docs/user/../../private.md" }],
        }),
      /docs\/user Markdown path/,
    );
  });

  it("rewrites selected Help links to public routes and unselected Help to exact source", () => {
    const manifest = fixtureManifest();
    const page = manifest.pages[0];
    const markdown = [
      "[Providers](./providers.md#setup)",
      "[Other](./other.md)",
      "[External](https://example.com)",
    ].join("\n");
    const rewritten = rewriteHelpLinks(markdown, page, manifest);
    assert.match(rewritten, /\/docs\/providers\/#setup/);
    assert.match(rewritten, /blob\/a{40}\/docs\/user\/other\.md/);
    assert.match(rewritten, /https:\/\/example\.com/);
  });

  it("generates deterministic page, raw, and index artifacts and rejects unsafe or changed source", async () => {
    const markdown = "# Getting started\n\nSee [Providers](./providers.md).\n";
    const manifest = fixtureManifest(markdown);
    const outputRoot = mkdtempSync(join(tmpdir(), "scient-docs-test-"));
    try {
      const sources = new Map([
        ["docs/user/getting-started.md", markdown],
        ["docs/user/providers.md", "# Providers\n"],
      ]);
      const result = await generateDocs({
        manifest,
        loadSource: async (path) => sources.get(path),
        outputRoot,
      });
      assert.equal(result.pages.length, 2);
      assert.match(
        readFileSync(join(outputRoot, "pages/getting-started.md"), "utf8"),
        /\/docs\/providers\//,
      );
      assert.equal(
        JSON.parse(readFileSync(join(outputRoot, "raw.json"), "utf8"))["getting-started"],
        markdown,
      );

      await assert.rejects(
        generateDocs({
          manifest,
          loadSource: async (path) =>
            path === "docs/user/getting-started.md" ? `${markdown}changed` : sources.get(path),
          outputRoot,
        }),
        /SHA-256 mismatch/,
      );
      const unsafe = "# Getting started\n\n<script>alert(1)</script>\n";
      const unsafeManifest = fixtureManifest(unsafe);
      await assert.rejects(
        generateDocs({
          manifest: unsafeManifest,
          loadSource: async (path) =>
            path === "docs/user/getting-started.md" ? unsafe : sources.get(path),
          outputRoot,
        }),
        /unsafe raw Markdown content/,
      );
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
