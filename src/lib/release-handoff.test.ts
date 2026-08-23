import { describe, expect, it } from "vitest";

import { releaseFromHandoff } from "./release-handoff";

const handoffFixture = {
  schemaVersion: 1,
  product: "Scient",
  version: "0.6.5",
  tag: "v0.6.5",
  source: {
    repository: "ScientFactory/scient-desktop-next",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  },
  assets: [
    {
      name: "Scient-0.6.5-arm64.dmg",
      size: 125_000_000,
      sha256: "c".repeat(64),
    },
    {
      name: "Scient-0.6.5-x64.dmg",
      size: 129_000_000,
      sha256: "d".repeat(64),
    },
    {
      name: "Scient-0.6.5-x64.exe",
      size: 98_000_000,
      sha256: "e".repeat(64),
    },
    {
      name: "Scient-0.6.5-x86_64.AppImage",
      size: 112_000_000,
      sha256: "f".repeat(64),
    },
  ],
};

describe("Scient release handoff", () => {
  it("builds trusted release metadata without the rate-limited GitHub API", () => {
    const release = releaseFromHandoff(handoffFixture, "Sat, 22 Aug 2026 01:50:58 GMT");

    expect(release).toMatchObject({
      tag_name: "v0.6.5",
      name: "Scient v0.6.5",
      html_url: "https://github.com/ScientFactory/scient-desktop-next/releases/tag/v0.6.5",
      published_at: "2026-08-22T01:50:58.000Z",
      prerelease: false,
    });
    expect(release.assets).toContainEqual(
      expect.objectContaining({
        name: "Scient-0.6.5-arm64.dmg",
        browser_download_url:
          "https://github.com/ScientFactory/scient-desktop-next/releases/download/v0.6.5/Scient-0.6.5-arm64.dmg",
        digest: `sha256:${"c".repeat(64)}`,
      }),
    );
    expect(release.assets).toContainEqual(
      expect.objectContaining({
        name: "SHA256SUMS.txt",
        browser_download_url:
          "https://github.com/ScientFactory/scient-desktop-next/releases/download/v0.6.5/SHA256SUMS.txt",
        size: 358,
      }),
    );
  });

  it.each([
    ["wrong product", { ...handoffFixture, product: "Other" }, "Sat, 22 Aug 2026 01:50:58 GMT"],
    [
      "wrong source",
      { ...handoffFixture, source: { repository: "Other/repo" } },
      "Sat, 22 Aug 2026 01:50:58 GMT",
    ],
    ["tag mismatch", { ...handoffFixture, tag: "v9.9.9" }, "Sat, 22 Aug 2026 01:50:58 GMT"],
    [
      "path traversal",
      { ...handoffFixture, assets: [{ ...handoffFixture.assets[0], name: "../Scient.dmg" }] },
      "Sat, 22 Aug 2026 01:50:58 GMT",
    ],
    [
      "duplicate asset",
      { ...handoffFixture, assets: [handoffFixture.assets[0], handoffFixture.assets[0]] },
      "Sat, 22 Aug 2026 01:50:58 GMT",
    ],
    [
      "missing installer",
      { ...handoffFixture, assets: handoffFixture.assets.slice(0, 3) },
      "Sat, 22 Aug 2026 01:50:58 GMT",
    ],
  ])("rejects %s", (_case, value, lastModified) => {
    expect(() => releaseFromHandoff(value, lastModified)).toThrow();
  });

  it("keeps publication copy optional when the CDN omits its date", () => {
    expect(releaseFromHandoff(handoffFixture, null).published_at).toBeNull();
    expect(releaseFromHandoff(handoffFixture, "not-a-date").published_at).toBeNull();
  });

  it("accepts the final repository in a transitional handoff", () => {
    expect(
      releaseFromHandoff(
        {
          ...handoffFixture,
          source: { ...handoffFixture.source, repository: "ScientFactory/scient-desktop" },
        },
        "Sat, 22 Aug 2026 01:50:58 GMT",
      ).tag_name,
    ).toBe("v0.6.5");
  });

  it("routes old provenance through the configured final delivery repository", () => {
    const release = releaseFromHandoff(
      handoffFixture,
      "Sat, 22 Aug 2026 01:50:58 GMT",
      "ScientFactory/scient-desktop",
    );
    expect(release.html_url).toBe(
      "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.5",
    );
    expect(release.assets[0]?.browser_download_url).toContain(
      "/ScientFactory/scient-desktop/releases/download/v0.6.5/",
    );
  });
});
