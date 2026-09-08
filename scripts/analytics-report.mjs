import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const analyticsReportQuery = `
  WITH expected_maintenance(name) AS (
    VALUES ('retention'), ('deletion'), ('identity-export'), ('event-export')
  )
  SELECT
    '30_day_identity' AS report_section,
    identity_type AS item,
    COUNT(*) AS event_count,
    MAX(last_seen_at) AS latest_event
  FROM analytics_identities
  WHERE julianday(last_seen_at) >= julianday('now', '-30 days')
  GROUP BY identity_type

  UNION ALL

  SELECT
    '30_day_session' AS report_section,
    source AS item,
    COUNT(DISTINCT session_id) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM analytics_events
  WHERE session_id IS NOT NULL
    AND julianday(occurred_at) >= julianday('now', '-30 days')
  GROUP BY source

  UNION ALL

  SELECT
    '30_day_consent' AS report_section,
    source || ':' || consent_level AS item,
    COUNT(*) AS event_count,
    MAX(recorded_at) AS latest_event
  FROM analytics_consents
  WHERE julianday(recorded_at) >= julianday('now', '-30 days')
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
    'retained_event' AS report_section,
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
    AND julianday(occurred_at) >= julianday('now', '-30 days')
  GROUP BY json_extract(properties_json, '$.asset_key')

  UNION ALL

  SELECT
    'legacy_30_day_download' AS report_section,
    COALESCE(asset_key, 'unknown') AS item,
    COUNT(*) AS event_count,
    MAX(occurred_at) AS latest_event
  FROM site_events
  WHERE event_name = 'download_clicked'
    AND julianday(occurred_at) >= julianday('now', '-30 days')
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
    AND julianday(occurred_at) >= julianday('now', '-30 days')
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
    AND julianday(occurred_at) >= julianday('now', '-30 days')
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
    AND julianday(occurred_at) >= julianday('now', '-30 days')
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
    AND julianday(occurred_at) >= julianday('now', '-30 days')
  GROUP BY failure_stage, failure_reason

  UNION ALL

  SELECT
    'posthog_delivery' AS report_section,
    CASE WHEN source = 'desktop' AND privacy_level = 'diagnostic' THEN 'first-party-only'
         ELSE posthog_state END AS item,
    COUNT(*) AS event_count,
    MAX(received_at) AS latest_event
  FROM analytics_events
  GROUP BY item

  UNION ALL

  SELECT '30_day_desktop_diagnostics',
    event_name || ':' || COALESCE(json_extract(properties_json, '$.deliveryClass'), 'unknown'),
    COUNT(*), MAX(occurred_at)
  FROM analytics_events
  WHERE source = 'desktop' AND privacy_level = 'diagnostic'
    AND julianday(occurred_at) >= julianday('now', '-30 days')
  GROUP BY event_name, json_extract(properties_json, '$.deliveryClass')

  UNION ALL

  SELECT
    'delivery_attention' AS report_section,
    source || ':' || CASE WHEN posthog_last_error = 'contract-rejected' THEN 'contract-rejected'
                         ELSE 'retry-exhausted' END AS item,
    COUNT(*) AS event_count,
    MAX(received_at) AS latest_event
  FROM analytics_events
  WHERE posthog_state = 'pending' AND posthog_attempts >= 20
  GROUP BY item

  UNION ALL

  SELECT 'deletion_state', posthog_state, COUNT(*), MAX(requested_at)
  FROM analytics_deletion_requests
  GROUP BY posthog_state

  UNION ALL

  SELECT 'maintenance', expected.name || ':' ||
    CASE WHEN actual.name IS NULL THEN 'never-run'
         WHEN julianday(actual.completed_at) < julianday('now', '-20 minutes') THEN 'stale-' || actual.outcome
         ELSE actual.outcome END,
    NULL, actual.completed_at
  FROM expected_maintenance AS expected
  LEFT JOIN analytics_maintenance_status AS actual ON actual.name = expected.name

  ORDER BY report_section, event_count DESC, item
`;

/** Cloudflare D1 limits compound SELECT terms more tightly than local SQLite. */
export function analyticsReportQueries(maxTerms = 4) {
  if (!Number.isInteger(maxTerms) || maxTerms < 2) {
    throw new Error("Analytics report chunks require at least two SELECT terms");
  }
  const body = analyticsReportQuery
    .replace(/\n\s*ORDER BY report_section, event_count DESC, item\s*$/, "")
    .trim();
  const terms = body.split(/\n\s*UNION ALL\s*\n/);
  const first = terms.shift();
  const maintenance = terms.pop();
  if (!first || !maintenance || !maintenance.includes("analytics_maintenance_status")) {
    throw new Error("Analytics report query structure is invalid");
  }

  const chunks = [[first, maintenance]];
  while (terms.length > 0) chunks.push(terms.splice(0, maxTerms));
  return chunks.map(
    (chunk) =>
      `${chunk.join("\n\n  UNION ALL\n\n")}\n\n  ORDER BY report_section, event_count DESC, item`,
  );
}

// Importing the query for local fixture tests must never contact production.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const query of analyticsReportQueries()) {
    const result = spawnSync(
      "wrangler",
      ["d1", "execute", "scientfactory-downloads", "--remote", "--command", query],
      { stdio: "inherit", timeout: 60_000 },
    );
    if (result.error || result.status !== 0) {
      console.error("Analytics aggregate report failed or timed out");
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
