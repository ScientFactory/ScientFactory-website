import { describe, expect, it } from "vitest";

import { isOfficialDesktopReleaseDownload } from "./release-source";

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
});
