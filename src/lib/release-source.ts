// FILE: release-source.ts
// Purpose: Centralizes the public Scient Desktop release source and trusted download boundary.
// Layer: Shared marketing and Cloudflare utility

export const DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop-next";
export const FINAL_DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop";

const TRUSTED_DOWNLOAD_REPOSITORIES = new Set([
  DESKTOP_RELEASE_REPOSITORY,
  FINAL_DESKTOP_RELEASE_REPOSITORY,
]);

export const GITHUB_RELEASE_API_URL = `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/latest`;
export const DESKTOP_REPOSITORY_URL = `https://github.com/${DESKTOP_RELEASE_REPOSITORY}`;
export const RELEASE_CACHE_NAMESPACE = `scient-latest-release-v3:${DESKTOP_RELEASE_REPOSITORY}`;

export function isOfficialDesktopReleaseDownload(value: string): boolean {
  try {
    const destination = new URL(value);
    if (
      destination.protocol !== "https:" ||
      destination.hostname !== "github.com" ||
      destination.port !== ""
    ) {
      return false;
    }
    return [...TRUSTED_DOWNLOAD_REPOSITORIES].some((repository) =>
      destination.pathname.startsWith(`/${repository}/releases/download/`),
    );
  } catch {
    return false;
  }
}
