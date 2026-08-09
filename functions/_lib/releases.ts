// Purpose: Resolves the new Scient release, falling back to legacy only while no new release exists.

import {
  githubLatestReleaseApiUrl,
  LEGACY_RELEASE_REPOSITORY,
  PRIMARY_RELEASE_REPOSITORY,
} from "../../src/lib/release-sources";

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "ScientFactory-download-service",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

export async function fetchAuthoritativeRelease(): Promise<Response> {
  const primary = await fetch(githubLatestReleaseApiUrl(PRIMARY_RELEASE_REPOSITORY), {
    headers: GITHUB_HEADERS,
  });
  if (primary.status !== 404) return primary;

  return fetch(githubLatestReleaseApiUrl(LEGACY_RELEASE_REPOSITORY), {
    headers: GITHUB_HEADERS,
  });
}
