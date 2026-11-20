-- What GitHub reports for each release file, one row per file per day. GitHub keeps only a
-- running total and counts every fetch: Mac installers (.dmg) are installs only, but Windows
-- (.exe) and Linux (.AppImage) files are also what an update fetches when the update mirror
-- falls back to GitHub, and Mac updates fetch the .zip. Nothing personal is stored.
CREATE TABLE github_release_downloads (
  day TEXT NOT NULL,
  repository TEXT NOT NULL,
  release_tag TEXT NOT NULL,
  release_published_at TEXT,
  asset_name TEXT NOT NULL,
  download_count INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (day, repository, asset_name)
);
CREATE INDEX github_release_downloads_release
  ON github_release_downloads (repository, release_tag, day);
