import { describe, expect, it } from "vitest";

import { desktopMirrorUrl, desktopUpdateFeedUrl } from "../../../src/lib/release-source";
import { feedUpdateManifest, parseUpdateManifest } from "./updateManifest";

const WINDOWS = `version: 0.6.30
files:
  - url: Scient-0.6.30-x64.exe
    sha512: c2hhNTEyLWV4ZQ==
    size: 123
path: Scient-0.6.30-x64.exe
sha512: c2hhNTEyLWV4ZQ==
releaseDate: '2026-11-16T10:00:00.000Z'
`;

/** How electron-updater 6.8.9's Provider resolves a manifest file URL against a generic feed. */
function resolveAgainstFeed(url: string, feed: string): string {
  return new URL(url, feed.endsWith("/") ? feed : `${feed}/`).href;
}

describe("update manifest feed copy", () => {
  it("points every file at the release's immutable directory without touching its digests", () => {
    const copy = feedUpdateManifest(WINDOWS, "latest.yml", "v0.6.30", null);

    expect(copy).toBe(
      WINDOWS.replace("  - url: Scient", "  - url: ../../v0.6.30/Scient").replace(
        "path: Scient",
        "path: ../../v0.6.30/Scient",
      ),
    );
    const [file] = parseUpdateManifest(copy.replaceAll("../../v0.6.30/", ""), "copy").files;
    expect(file).toEqual({ url: "Scient-0.6.30-x64.exe", sha512: "c2hhNTEyLWV4ZQ==", size: 123 });
    expect(
      resolveAgainstFeed("../../v0.6.30/Scient-0.6.30-x64.exe", desktopUpdateFeedUrl("stable")),
    ).toBe(desktopMirrorUrl("v0.6.30", "Scient-0.6.30-x64.exe"));
    expect(
      resolveAgainstFeed(
        "../../v0.6.31-beta.20261116.2/Scient-0.6.31-beta.20261116.2-x64.exe",
        desktopUpdateFeedUrl("beta"),
      ),
    ).toBe(desktopMirrorUrl("v0.6.31-beta.20261116.2", "Scient-0.6.31-beta.20261116.2-x64.exe"));
  });

  it("adds the GitHub release's name and notes as YAML double-quoted scalars", () => {
    const notes = '<h2>What\'s new</h2>\n<p>"Quoted" \\ and a line\u2028separator</p>';
    const copy = feedUpdateManifest(WINDOWS, "latest.yml", "v0.6.30", {
      name: "Scient v0.6.30",
      notes,
    });

    expect(copy).toContain('releaseName: "Scient v0.6.30"\n');
    const line = copy.split("\n").find((candidate) => candidate.startsWith("releaseNotes: "))!;
    expect(line).toContain("\\u2028");
    expect(JSON.parse(line.slice("releaseNotes: ".length))).toBe(notes);
  });

  it("keeps a manifest's own release notes and omits empty ones", () => {
    const own = `${WINDOWS}releaseNotes: 'From the build'\n`;
    expect(
      feedUpdateManifest(own, "latest.yml", "v0.6.30", { name: "Scient v0.6.30", notes: "x" }),
    ).toContain("releaseNotes: 'From the build'\n");
    expect(
      feedUpdateManifest(WINDOWS, "latest.yml", "v0.6.30", { name: "Scient v0.6.30", notes: "" }),
    ).not.toContain("releaseNotes");
  });

  it.each([
    ["an absolute URL", WINDOWS.replace("url: Scient", "url: https://github.com/x/Scient")],
    ["a nested URL", WINDOWS.replace("url: Scient", "url: ../Scient")],
    ["a block scalar", `${WINDOWS}releaseNotes: |\n  - url: evil.exe\n`],
    ["a file without its digest", WINDOWS.replace("    sha512: c2hhNTEyLWV4ZQ==\n", "")],
    ["a path outside its files", WINDOWS.replace("path: Scient-0.6.30", "path: Other-0.6.30")],
  ])("refuses %s", (_label, text) => {
    expect(() => feedUpdateManifest(text, "latest.yml", "v0.6.30", null)).toThrow();
  });
});
