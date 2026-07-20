import { spawnSync } from "node:child_process";

const query = `
  SELECT
    '30_day_identity' AS report_section,
    identity_type AS item,
    COUNT(*) AS event_count,
    MAX(last_seen_at) AS latest_event
  FROM analytics_identities
  WHERE last_seen_at >= datetime('now', '-30 days')
  GROUP BY identity_type

  UNION ALL

  SELECT
    '30_day_session' AS report_section,
    source AS item,
    COUNT(DISTINCT session_id) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM analytics_events
  WHERE session_id IS NOT NULL
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY source

  UNION ALL

  SELECT
    '30_day_consent' AS report_section,
    source || ':' || consent_level AS item,
    COUNT(*) AS event_count,
    MAX(recorded_at) AS latest_event
  FROM analytics_consents
  WHERE recorded_at >= datetime('now', '-30 days')
  GROUP BY source, consent_level

  UNION ALL

  SELECT
    'legacy_all_time_event' AS report_section,
    event_name AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM site_events
  GROUP BY event_name

  UNION ALL

  SELECT
    'all_time_event' AS report_section,
    source || ':' || event_name AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM analytics_events
  GROUP BY source, event_name

  UNION ALL

  SELECT
    '30_day_download' AS report_section,
    COALESCE(json_extract(properties_json, '$.asset_key'), 'unknown') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM analytics_events
  WHERE event_name = 'download_clicked'
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY json_extract(properties_json, '$.asset_key')

  UNION ALL

  SELECT
    'legacy_30_day_download' AS report_section,
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
    COALESCE(json_extract(properties_json, '$.destination_host'), 'unknown') ||
      COALESCE(json_extract(properties_json, '$.destination_path'), '/') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM analytics_events
  WHERE event_name = 'outbound_link_clicked'
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY
    json_extract(properties_json, '$.destination_host'),
    json_extract(properties_json, '$.destination_path')

  UNION ALL

  SELECT
    'legacy_30_day_outbound' AS report_section,
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
    COALESCE(json_extract(properties_json, '$.failure_stage'), 'unknown') || ':' ||
      COALESCE(json_extract(properties_json, '$.failure_reason'), 'unknown') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM analytics_events
  WHERE event_name = 'download_failed'
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY
    json_extract(properties_json, '$.failure_stage'),
    json_extract(properties_json, '$.failure_reason')

  UNION ALL

  SELECT
    'legacy_30_day_download_failure' AS report_section,
    COALESCE(failure_stage, 'unknown') || ':' || COALESCE(failure_reason, 'unknown') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM site_events
  WHERE event_name = 'download_failed'
    AND occurred_at >= datetime('now', '-30 days')
  GROUP BY failure_stage, failure_reason

  UNION ALL

  SELECT
    'posthog_delivery' AS report_section,
    posthog_state AS item,
    COUNT(*) AS event_count,
    MAX(received_at) AS latest_event
  FROM analytics_events
  GROUP BY posthog_state

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
