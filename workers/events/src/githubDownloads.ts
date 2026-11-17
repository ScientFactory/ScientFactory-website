// FILE: githubDownloads.ts
// Purpose: Saves GitHub's download totals for each desktop release file once a day.
// Layer: Analytics Worker maintenance

export const GITHUB_RELEASE_REPOSITORIES = [
  "ScientFactory/scient-desktop",
  "ScientFactory/scient-desktop-beta",
] as const;

/** Installers and the Mac update archive; feeds, block maps and checksums are left out. */
const COUNTED_ASSET = /\.(dmg|zip|exe|msi|AppImage|deb|rpm)$/;
const RELEASES_PER_REPOSITORY = 30;

interface GithubRelease {
  readonly tag_name?: unknown;
  readonly published_at?: unknown;
  readonly assets?: ReadonlyArray<{ readonly name?: unknown; readonly download_count?: unknown }>;
}

/**
 * Saves today's totals for each repository not yet saved today. Returns the number of files
 * saved, 0 when today is already done. Throws when GitHub does not answer, so the next run retries.
 */
export async function recordGithubReleaseDownloads(
  db: D1Database,
  options: { readonly now?: Date; readonly token?: string; readonly fetcher?: typeof fetch } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const done = await db
    .prepare("SELECT DISTINCT repository FROM github_release_downloads WHERE day = ?")
    .bind(day)
    .all<{ repository: string }>();
  const saved = new Set(done.results.map((row) => row.repository));
  const pending = GITHUB_RELEASE_REPOSITORIES.filter((repository) => !saved.has(repository));
  if (pending.length === 0) return 0;

  const fetcher = options.fetcher ?? fetch;
  const statements: D1PreparedStatement[] = [];
  for (const repository of pending) {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/releases?per_page=${RELEASES_PER_REPOSITORY}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "scientfactory-events",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub releases for ${repository}: HTTP ${response.status}`);
    const releases = (await response.json()) as ReadonlyArray<GithubRelease>;
    for (const release of Array.isArray(releases) ? releases : []) {
      if (typeof release.tag_name !== "string") continue;
      const publishedAt = typeof release.published_at === "string" ? release.published_at : null;
      for (const asset of release.assets ?? []) {
        if (typeof asset.name !== "string" || !COUNTED_ASSET.test(asset.name)) continue;
        if (typeof asset.download_count !== "number") continue;
        statements.push(
          db
            .prepare(
              `INSERT OR REPLACE INTO github_release_downloads
                (day, repository, release_tag, release_published_at, asset_name, download_count, recorded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              day,
              repository,
              release.tag_name.slice(0, 80),
              publishedAt,
              asset.name.slice(0, 255),
              asset.download_count,
              now.toISOString(),
            ),
        );
      }
    }
  }
  if (statements.length > 0) await db.batch(statements);
  return statements.length;
}
