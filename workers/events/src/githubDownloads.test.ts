import { expect, it, vi } from "vitest";

import { GITHUB_RELEASE_REPOSITORIES, recordGithubReleaseDownloads } from "./githubDownloads";
import { testDatabase } from "./sqlite.testSupport";

const releases = [
  {
    tag_name: "v0.6.30",
    published_at: "2026-11-15T10:00:00Z",
    assets: [
      { name: "Scient-0.6.30-arm64.dmg", download_count: 3 },
      { name: "Scient-0.6.30-arm64.zip", download_count: 4 },
      { name: "Scient-0.6.30-x64.exe", download_count: 3 },
      { name: "Scient-0.6.30-x64.exe.blockmap", download_count: 3 },
      { name: "latest-mac.yml", download_count: 141 },
    ],
  },
];

it("saves each installer's GitHub total once a day", async () => {
  const store = testDatabase();
  try {
    const fetcher = vi.fn(async () => Response.json(releases));
    const now = new Date("2026-11-17T00:01:00Z");

    const saved = await recordGithubReleaseDownloads(store.database, { now, fetcher });
    expect(saved).toBe(3 * GITHUB_RELEASE_REPOSITORIES.length);
    expect(fetcher).toHaveBeenCalledTimes(GITHUB_RELEASE_REPOSITORIES.length);
    expect(await recordGithubReleaseDownloads(store.database, { now, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(GITHUB_RELEASE_REPOSITORIES.length);

    const rows = store.sqlite
      .prepare(
        "SELECT asset_name, download_count FROM github_release_downloads WHERE repository = ? ORDER BY asset_name",
      )
      .all(GITHUB_RELEASE_REPOSITORIES[0]);
    expect(rows).toEqual([
      { asset_name: "Scient-0.6.30-arm64.dmg", download_count: 3 },
      { asset_name: "Scient-0.6.30-arm64.zip", download_count: 4 },
      { asset_name: "Scient-0.6.30-x64.exe", download_count: 3 },
    ]);
  } finally {
    store.close();
  }
});

it("fails so the next run retries when GitHub does not answer", async () => {
  const store = testDatabase();
  try {
    const fetcher = vi.fn(async () => new Response("rate limited", { status: 403 }));
    await expect(
      recordGithubReleaseDownloads(store.database, { now: new Date(), fetcher }),
    ).rejects.toThrow("HTTP 403");
    expect(
      store.sqlite.prepare("SELECT COUNT(*) AS n FROM github_release_downloads").get(),
    ).toEqual({ n: 0 });
  } finally {
    store.close();
  }
});
