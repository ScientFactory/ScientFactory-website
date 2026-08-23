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
