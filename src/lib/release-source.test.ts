import { describe, expect, it } from "vitest";

import { isOfficialDesktopReleaseDownload, isOfficialDesktopReleasePage } from "./release-source";

describe("Scient Desktop release source", () => {
  it.each([
    "https://github.com/ScientFactory/scient-desktop-next/releases/download/v0.6.5/Scient.dmg",
    "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
  ])("accepts an exact transitional release path: %s", (url) => {
    expect(isOfficialDesktopReleaseDownload(url)).toBe(true);
  });

  it.each([
    "http://github.com/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "https://github.com:444/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "https://github.com/Other/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "https://github.com/ScientFactory/scient-desktop-evil/releases/download/v0.6.6/Scient.dmg",
    "https://example.com/ScientFactory/scient-desktop/releases/download/v0.6.6/Scient.dmg",
    "not a URL",
  ])("rejects an untrusted release path: %s", (url) => {
    expect(isOfficialDesktopReleaseDownload(url)).toBe(false);
  });

  it.each([
    "https://github.com/ScientFactory/scient-desktop-next/releases/tag/v0.6.5",
    "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.6",
  ])("accepts an exact transitional release page: %s", (url) => {
    expect(isOfficialDesktopReleasePage(url)).toBe(true);
  });

  it.each([
    "https://github.com/ScientFactory/scient-desktop/releases/latest",
    "https://github.com/Other/scient-desktop/releases/tag/v0.6.6",
    "https://github.com/ScientFactory/scient-desktop/releases/tag/",
  ])("rejects an untrusted release page: %s", (url) => {
    expect(isOfficialDesktopReleasePage(url)).toBe(false);
  });
});
