import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { hashMarkdown } from "./sync-scient-docs.mjs";
import { liveLag, repinManifest } from "./update-scient-docs-pin.mjs";

const pinned = { "docs/user/a.md": "# A\n", "docs/user/b.md": "# B\n" };

function manifest() {
  return {
    schemaVersion: 1,
    channel: "stable",
    source: {
      repository: "ScientFactory/scient-desktop",
      revision: "a".repeat(40),
      reviewedAt: "2026-11-10",
    },
    version: {
      label: "Scient v1.0.0",
      appliesTo: "Scient Desktop v1.0.0",
      stableReleaseTags: ["v1.0.0"],
    },
    corpusDefaults: { product: "Scient Desktop" },
    publication: {
      releaseTrigger: "Release",
      correctionTrigger: "Correction",
      maximumLagHours: 24,
      failureMode: "Fail closed",
      rollback: "Revert the pin",
    },
    pages: Object.entries(pinned).map(([sourcePath, markdown]) => ({
      slug: sourcePath.slice(10, -3),
      title: sourcePath,
      summary: "Summary.",
      topic: "Topic",
      sourcePath,
      sha256: hashMarkdown(markdown),
    })),
  };
}

const release = { tag: "v1.1.0", revision: "b".repeat(40), publishedAt: "2026-11-25T00:00:00Z" };

describe("repinManifest", () => {
  it("moves the pin to the release, keeping the selection and recording changed pages", async () => {
    const source = { ...pinned, "docs/user/b.md": "# B\n\nNew text.\n" };
    const result = await repinManifest({
      manifest: manifest(),
      release,
      loadSource: async (path) => source[path] ?? null,
      reviewedAt: "2026-11-26",
    });
    assert.deepEqual(result.changed, ["docs/user/b.md"]);
    assert.deepEqual(result.missing, []);
    assert.equal(result.manifest.source.revision, release.revision);
    assert.deepEqual(result.manifest.version, {
      label: "Scient v1.1.0",
      appliesTo: "Scient Desktop v1.1.0",
      stableReleaseTags: ["v1.1.0"],
    });
    assert.deepEqual(
      result.manifest.pages.map((page) => [page.slug, page.sha256]),
      [
        ["a", hashMarkdown(pinned["docs/user/a.md"])],
        ["b", hashMarkdown(source["docs/user/b.md"])],
      ],
    );
  });

  it("reports a selected page the release no longer has instead of dropping it", async () => {
    const result = await repinManifest({
      manifest: manifest(),
      release,
      loadSource: async (path) => (path === "docs/user/a.md" ? pinned[path] : null),
      reviewedAt: "2026-11-26",
    });
    assert.deepEqual(result.missing, ["docs/user/b.md"]);
    assert.equal(result.manifest.pages.length, 2);
  });
});

describe("liveLag", () => {
  const index = {
    source: { revision: "a".repeat(40) },
    version: { label: "Scient v1.0.0", stableReleaseTags: ["v1.0.0"] },
    publication: { maximumLagHours: 24 },
    pages: [
      { slug: "a", sourcePath: "docs/user/a.md" },
      { slug: "b", sourcePath: "docs/user/b.md" },
    ],
  };
  const live = { a: pinned["docs/user/a.md"], b: pinned["docs/user/b.md"] };
  const check = (releaseSource, hoursAfterRelease, served = index) =>
    liveLag({
      index: served,
      release,
      loadReleaseSource: async (path) => releaseSource[path] ?? null,
      loadLiveRaw: async (slug) => live[slug] ?? null,
      now: Date.parse(release.publishedAt) + hoursAfterRelease * 3_600_000,
    });

  it("does not count an older label as lag when the served text matches the release", async () => {
    const result = await check(pinned, 72);
    assert.deepEqual(result.stalePages, []);
    assert.equal(result.overdue, false);
  });

  it("is overdue only once differing text outlives the allowed lag", async () => {
    const changed = { ...pinned, "docs/user/a.md": "# A\n\nChanged.\n" };
    assert.equal((await check(changed, 23)).overdue, false);
    const late = await check(changed, 25);
    assert.deepEqual(late.stalePages, ["docs/user/a.md"]);
    assert.equal(late.overdue, true);
  });

  it("counts a page the release removed as stale", async () => {
    const result = await check({ "docs/user/a.md": pinned["docs/user/a.md"] }, 25);
    assert.deepEqual(result.stalePages, ["docs/user/b.md"]);
    assert.equal(result.overdue, true);
  });

  it("treats a live pin naming the release as current, even with corrected text", async () => {
    const corrected = { ...pinned, "docs/user/a.md": "# A\n\nBefore the correction.\n" };
    const covering = {
      ...index,
      version: { label: "Scient v1.1.0", stableReleaseTags: ["v1.1.0"] },
    };
    const result = await check(corrected, 72, covering);
    assert.deepEqual(result.stalePages, []);
    assert.equal(result.overdue, false);
  });
});
