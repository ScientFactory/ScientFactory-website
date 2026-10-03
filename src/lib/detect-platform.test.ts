import { describe, expect, it } from "vitest";

import { detectPlatform } from "./detect-platform";

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const CHROMEOS =
  "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("detectPlatform", () => {
  it("recognises desktop Safari and Chrome on a Mac", () => {
    expect(detectPlatform({ userAgent: MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 0 })).toBe(
      "macos",
    );
    expect(
      detectPlatform({
        userAgent: MAC_CHROME,
        platform: "MacIntel",
        uaDataPlatform: "macOS",
        maxTouchPoints: 0,
      }),
    ).toBe("macos");
  });

  it("treats a Mac that reports a touchscreen as an iPad", () => {
    expect(
      detectPlatform({ userAgent: MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 5 }),
    ).toBeNull();
  });

  it("recognises Windows and Linux desktops", () => {
    expect(
      detectPlatform({ userAgent: WINDOWS_EDGE, platform: "Win32", uaDataPlatform: "Windows" }),
    ).toBe("windows");
    expect(detectPlatform({ userAgent: LINUX_FIREFOX, platform: "Linux x86_64" })).toBe("linux");
  });

  it("highlights nothing on phones, tablets, or ChromeOS", () => {
    expect(detectPlatform({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 })).toBeNull();
    expect(
      detectPlatform({
        userAgent: ANDROID,
        platform: "Linux armv81",
        uaDataPlatform: "Android",
        maxTouchPoints: 5,
      }),
    ).toBeNull();
    expect(
      detectPlatform({
        userAgent: CHROMEOS,
        platform: "Linux x86_64",
        uaDataPlatform: "Chrome OS",
      }),
    ).toBeNull();
  });

  it("highlights nothing when the platform is unknown", () => {
    expect(detectPlatform({ userAgent: "" })).toBeNull();
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (X11; FreeBSD amd64)" })).toBeNull();
  });
});
