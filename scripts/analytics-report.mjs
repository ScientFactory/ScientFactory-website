import { spawnSync } from "node:child_process";

const query = `
  SELECT
    'all_time_event' AS report_section,
    event_name AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM site_events
  GROUP BY event_name

  UNION ALL

  SELECT
    '30_day_download' AS report_section,
    COALESCE(asset_key, 'unknown') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM site_events
  WHERE event_name = 'download_clicked'
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY asset_key

  UNION ALL

  SELECT
    '30_day_outbound' AS report_section,
    COALESCE(destination_host, 'unknown') || COALESCE(destination_path, '/') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM site_events
  WHERE event_name = 'outbound_link_clicked'
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY destination_host, destination_path

  UNION ALL

  SELECT
    '30_day_download_failure' AS report_section,
    COALESCE(failure_stage, 'unknown') || ':' || COALESCE(failure_reason, 'unknown') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM site_events
  WHERE event_name = 'download_failed'
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY failure_stage, failure_reason

  ORDER BY report_section, event_count DESC, item
`;

const result = spawnSync(
  "wrangler",
  ["d1", "execute", "scientfactory-downloads", "--remote", "--command", query],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
