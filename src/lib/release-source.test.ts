import { describe, expect, it } from "vitest";

import {
  DESKTOP_RELEASE_REPOSITORY,
  isOfficialDesktopReleaseDownload,
  isOfficialDesktopReleasePage,
} from "./release-source";

describe("Scient Desktop release source", () => {
  it("uses the final repository as the canonical delivery source", () => {
    expect(DESKTOP_RELEASE_REPOSITORY).toBe("ScientFactory/scient-desktop");
  });

  it("accepts the exact canonical release path", () => {
    expect(
      isOfficialDesktopReleaseDownload(
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
      ),
    ).toBe(true);
  });

  it.each([
    "http://github.com/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "https://github.com:444/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "https://user:password@github.com/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "https://github.com/Other/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "https://github.com/ScientFactory/scient-desktop-evil/releases/download/v0.6.6/Scient.dmg",
    "https://github.com/ScientFactory/scient-desktop-next/releases/download/v0.6.5/Scient.dmg",
    "https://example.com/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "not a URL",
  ])("rejects an untrusted release path: %s", (url) => {
    expect(isOfficialDesktopReleaseDownload(url)).toBe(false);
  });

  it("accepts ScientFactory's mirrored installer path", () => {
    expect(
      isOfficialDesktopReleaseDownload(
        "https://downloads.scientfactory.com/scient-desktop/v0.6.28/Scient-0.6.28-arm64.dmg",
      ),
    ).toBe(true);
  });

  it.each([
    "http://downloads.scientfactory.com/scient-desktop/v0.6.28/Scient-0.6.28-arm64.dmg",
    "https://downloads.scientfactory.com/scient-agent/v0.1.5/scient-agent-darwin-arm64",
    "https://downloads.scientfactory.com/scient-desktop/stable.json",
    "https://downloads.scientfactory.com/scient-desktop/v0.6.28/../stable.json",
    "https://downloads.scientfactory.com/scient-desktop/v0.6.28/Scient.dmg?x=1",
    "https://downloads.scientfactory.com.evil.test/scient-desktop/v0.6.28/Scient.dmg",
  ])("rejects an untrusted mirror path: %s", (url) => {
    expect(isOfficialDesktopReleaseDownload(url)).toBe(false);
  });

  it("accepts the exact canonical release page", () => {
    expect(
      isOfficialDesktopReleasePage(
        "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.6",
      ),
    ).toBe(true);
  });

  it.each([
    "https://github.com/ScientFactory/scient-desktop/releases/latest",
    "https://github.com/Other/scient-desktop/releases/tag/v0.6.6",
    "https://github.com/ScientFactory/scient-desktop/releases/tag/",
    "https://github.com/ScientFactory/scient-desktop-next/releases/tag/v0.6.5",
  ])("rejects an untrusted release page: %s", (url) => {
    expect(isOfficialDesktopReleasePage(url)).toBe(false);
  });
});
