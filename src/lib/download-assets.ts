// FILE: download-assets.ts
// Purpose: Defines the supported desktop installer names without browser-only dependencies.
// Layer: Shared marketing and edge utility

import type { Release, ReleaseAsset } from "./release-schema";

export const DOWNLOAD_ASSETS = {
  macArm64: { suffix: "-arm64.dmg", label: "macOS Apple Silicon" },
  macX64: { suffix: "-x64.dmg", label: "macOS Intel" },
  windowsX64: { suffix: "-x64.exe", label: "Windows x64" },
  linuxX64: { suffix: "-x86_64.AppImage", label: "Linux x64" },
} as const;

export type DownloadAssetKey = keyof typeof DOWNLOAD_ASSETS;

export function findDownloadAsset(release: Release, key: DownloadAssetKey): ReleaseAsset | null {
  const expected = DOWNLOAD_ASSETS[key];
  return release.assets.find((asset) => asset.name.endsWith(expected.suffix)) ?? null;
}
