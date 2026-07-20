CREATE TABLE site_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL CHECK (
    event_name IN (
      'page_viewed',
      'download_clicked',
      'download_failed',
      'outbound_link_clicked'
    )
  ),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  page_path TEXT,
  asset_key TEXT,
  release_tag TEXT,
  asset_name TEXT,
  destination_host TEXT,
  destination_path TEXT,
  failure_stage TEXT,
  failure_reason TEXT
);

CREATE INDEX site_events_name_occurred_at
  ON site_events (event_name, occurred_at);

CREATE INDEX site_events_asset_occurred_at
  ON site_events (asset_key, occurred_at);
