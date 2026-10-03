// FILE: detect-platform.ts
// Purpose: Picks the desktop platform whose download card the home page highlights.
// Layer: Browser-safe marketing utility

export type DesktopPlatform = "macos" | "windows" | "linux";

export interface PlatformHints {
  readonly userAgent: string;
  /** `navigator.platform`, deprecated but still reported by every browser. */
  readonly platform?: string;
  /** `navigator.userAgentData.platform`, reported by Chromium browsers. */
  readonly uaDataPlatform?: string;
  readonly maxTouchPoints?: number;
}

/**
 * Returns the visitor's desktop platform, or null for phones, tablets, and anything unrecognised.
 * iPadOS presents itself as a Mac, so a Mac that reports a touchscreen is treated as an iPad.
 */
export function detectPlatform(hints: PlatformHints): DesktopPlatform | null {
  const source =
    `${hints.uaDataPlatform ?? ""} ${hints.platform ?? ""} ${hints.userAgent}`.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(source)) return null;
  if (source.includes("mac")) return (hints.maxTouchPoints ?? 0) > 1 ? null : "macos";
  if (source.includes("win")) return "windows";
  if (source.includes("linux") && !source.includes("cros")) return "linux";
  return null;
}
