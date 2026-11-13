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
export const DESKTOP_LATEST_RELEASE_PAGE_URL = `${DESKTOP_REPOSITORY_URL}/releases/latest`;
export const RELEASE_CACHE_NAMESPACE = `scient-latest-release-v3:${DESKTOP_RELEASE_REPOSITORY}`;

// ScientFactory's own copy of the Stable installers lives in the `scient-downloads` R2 bucket,
// served at downloads.scientfactory.com. The release mirror worker copies each installer to
// `scient-desktop/<tag>/<name>` and only then writes the Stable pointer.
export const DESKTOP_MIRROR_ORIGIN = "https://downloads.scientfactory.com";
export const DESKTOP_MIRROR_PREFIX = "scient-desktop/";
export const DESKTOP_MIRROR_STABLE_KEY = `${DESKTOP_MIRROR_PREFIX}stable.json`;

export function desktopMirrorKey(tag: string, name: string): string {
  return `${DESKTOP_MIRROR_PREFIX}${tag}/${name}`;
}

export function desktopMirrorUrl(tag: string, name: string): string {
  return `${DESKTOP_MIRROR_ORIGIN}/${DESKTOP_MIRROR_PREFIX}${tag}/${encodeURIComponent(name)}`;
}

export function isOfficialDesktopProvenanceRepository(value: string): boolean {
  return TRUSTED_PROVENANCE_REPOSITORIES.has(value);
}

function plainHttpsUrl(value: string, hostname: string): URL | null {
  try {
    const destination = new URL(value);
    return destination.protocol === "https:" &&
      destination.hostname === hostname &&
      destination.port === "" &&
      destination.username === "" &&
      destination.password === ""
      ? destination
      : null;
  } catch {
    return null;
  }
}

function trustedGitHubPath(value: string, segment: "download" | "tag"): boolean {
  const destination = plainHttpsUrl(value, "github.com");
  if (!destination) return false;
  const prefix = `/${DESKTOP_RELEASE_REPOSITORY}/releases/${segment}/`;
  return destination.pathname.startsWith(prefix) && destination.pathname.length > prefix.length;
}

const MIRROR_INSTALLER_PATH = new RegExp(
  `^/${DESKTOP_MIRROR_PREFIX}v\\d+\\.\\d+\\.\\d+/[A-Za-z0-9][A-Za-z0-9._+-]*$`,
  "u",
);

function trustedMirrorPath(value: string): boolean {
  const destination = plainHttpsUrl(value, new URL(DESKTOP_MIRROR_ORIGIN).hostname);
  return (
    destination !== null &&
    destination.search === "" &&
    destination.hash === "" &&
    MIRROR_INSTALLER_PATH.test(destination.pathname)
  );
}

export function isOfficialDesktopReleaseDownload(value: string): boolean {
  return trustedGitHubPath(value, "download") || trustedMirrorPath(value);
}

export function isOfficialDesktopReleasePage(value: string): boolean {
  return trustedGitHubPath(value, "tag");
}
