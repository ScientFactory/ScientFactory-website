// Purpose: Defines the authoritative new-app release feed and the temporary pre-cutover fallback.

export const PRIMARY_RELEASE_REPOSITORY = "ScientFactory/scient-desktop-next";
export const LEGACY_RELEASE_REPOSITORY = "ScientFactory/scient-desktop";

export const RELEASE_REPOSITORIES = [
  PRIMARY_RELEASE_REPOSITORY,
  LEGACY_RELEASE_REPOSITORY,
] as const;

export function githubLatestReleaseApiUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/releases/latest`;
}

export function isOfficialReleaseDownloadUrl(value: string): boolean {
  try {
    const destination = new URL(value);
    return (
      destination.protocol === "https:" &&
      destination.hostname === "github.com" &&
      RELEASE_REPOSITORIES.some((repository) =>
        destination.pathname.startsWith(`/${repository}/releases/download/`),
      )
    );
  } catch {
    return false;
  }
}
