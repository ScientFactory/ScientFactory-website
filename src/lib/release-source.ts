// FILE: release-source.ts
// Purpose: Centralizes the public Scient Desktop release source and trusted download boundary.
// Layer: Shared marketing and Cloudflare utility

export const DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop";
const TRANSITIONAL_DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop-next";

const TRUSTED_PROVENANCE_REPOSITORIES = new Set([
  DESKTOP_RELEASE_REPOSITORY,
  TRANSITIONAL_DESKTOP_RELEASE_REPOSITORY,
]);

export const GITHUB_RELEASE_API_URL = `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/latest`;
export const GITHUB_RELEASE_HANDOFF_URL = `https://github.com/${DESKTOP_RELEASE_REPOSITORY}/releases/latest/download/scient-release-handoff.json`;
export const DESKTOP_REPOSITORY_URL = `https://github.com/${DESKTOP_RELEASE_REPOSITORY}`;
export const RELEASE_CACHE_NAMESPACE = `scient-latest-release-v3:${DESKTOP_RELEASE_REPOSITORY}`;

export function isOfficialDesktopProvenanceRepository(value: string): boolean {
  return TRUSTED_PROVENANCE_REPOSITORIES.has(value);
}

function trustedGitHubPath(value: string, segment: "download" | "tag"): boolean {
  try {
    const destination = new URL(value);
    if (
      destination.protocol !== "https:" ||
      destination.hostname !== "github.com" ||
      destination.port !== "" ||
      destination.username !== "" ||
      destination.password !== ""
    ) {
      return false;
    }
    const prefix = `/${DESKTOP_RELEASE_REPOSITORY}/releases/${segment}/`;
    return destination.pathname.startsWith(prefix) && destination.pathname.length > prefix.length;
  } catch {
    return false;
  }
}

export function isOfficialDesktopReleaseDownload(value: string): boolean {
  return trustedGitHubPath(value, "download");
}

export function isOfficialDesktopReleasePage(value: string): boolean {
  return trustedGitHubPath(value, "tag");
}
