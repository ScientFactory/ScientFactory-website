import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Aggregate-only, occurrence-time report. No identities or free text returned.
// Full UTC days avoid comparing today's partial activity with complete days.
export const productInsightsQuery = `
WITH eligible AS (
  SELECT event_name, distinct_id, date(occurred_at) AS day, properties_json AS p
  FROM analytics_events
  WHERE source = 'desktop' AND consent_level IN ('product', 'diagnostic')
    AND julianday(occurred_at) >= julianday(date('now', '-30 days'))
    AND julianday(occurred_at) < julianday(date('now'))
    AND json_extract(properties_json, '$.contractRevision') = '3'
), views AS (
  SELECT event_name, distinct_id, day,
    CASE event_name
      WHEN 'panel.viewed' THEN json_extract(p, '$.category')
      WHEN 'settings.viewed' THEN json_extract(p, '$.section')
      WHEN 'feature.viewed' THEN json_extract(p, '$.feature')
      WHEN 'usage.viewed' THEN json_extract(p, '$.metric') || ':' || json_extract(p, '$.window') || ':' || json_extract(p, '$.breakdown')
      WHEN 'usage.availability' THEN json_extract(p, '$.state')
      WHEN 'setting.changed' THEN json_extract(p, '$.setting') || ':' || json_extract(p, '$.value')
      WHEN 'scient.operation.completed' THEN json_extract(p, '$.operationKind')
      ELSE event_name END AS category
  FROM eligible WHERE event_name IN ('panel.viewed', 'settings.viewed', 'feature.viewed', 'usage.viewed', 'usage.availability', 'usage.refresh.requested', 'setting.changed', 'scient.operation.completed', 'voice.transcription.completed')
), per_installation AS (
  SELECT event_name, category, distinct_id, count(*) AS observations, count(DISTINCT day) AS days
  FROM views GROUP BY event_name, category, distinct_id
), tokens AS (
  SELECT distinct_id, json_extract(p, '$.provider') AS provider,
    json_extract(p, '$.modelKey') AS model,
    json_extract(p, '$.usageStatus') AS status,
    json_extract(p, '$.inputTokens') AS input_tokens,
    json_extract(p, '$.outputTokens') AS output_tokens
  FROM eligible WHERE event_name = 'provider.turn.usage'
)
SELECT 'feature_observations' AS metric, event_name || ':' || category AS category,
  count(*) AS installations, sum(observations) AS observations,
  sum(days >= 2) AS repeat_installations, NULL AS value
FROM per_installation GROUP BY event_name, category
UNION ALL
SELECT 'provider_model_reported_turns', provider || ':' || model, count(DISTINCT distinct_id), count(*), NULL, NULL
FROM tokens GROUP BY provider, model
UNION ALL
SELECT 'provider_token_coverage', provider || ':' || status, count(DISTINCT distinct_id), count(*), NULL, NULL
FROM tokens GROUP BY provider, status
UNION ALL
SELECT 'reported_input_tokens', provider, count(DISTINCT distinct_id), count(input_tokens), NULL, sum(input_tokens)
FROM tokens GROUP BY provider
UNION ALL
SELECT 'reported_output_tokens', provider, count(DISTINCT distinct_id), count(output_tokens), NULL, sum(output_tokens)
FROM tokens GROUP BY provider
UNION ALL
SELECT 'provider_observed_ready', json_extract(p, '$.provider'), count(DISTINCT distinct_id), count(*), NULL, NULL
FROM eligible
WHERE event_name = 'provider.discovered' AND json_extract(p, '$.state') = 'ready'
   OR event_name = 'provider.readiness.changed' AND json_extract(p, '$.to') = 'ready'
GROUP BY json_extract(p, '$.provider')
UNION ALL
SELECT 'provider_terminal_outcomes', json_extract(p, '$.provider') || ':' || event_name,
  count(DISTINCT distinct_id), count(*), NULL, NULL
FROM eligible WHERE event_name IN ('provider.turn.completed', 'provider.turn.failed', 'provider.turn.stopped')
GROUP BY json_extract(p, '$.provider'), event_name
UNION ALL
SELECT 'observed_product_population', 'revision-3', count(DISTINCT distinct_id), count(*), NULL, NULL
FROM eligible
ORDER BY metric, observations DESC, category
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(
    "wrangler",
    ["d1", "execute", "scientfactory-downloads", "--remote", "--command", productInsightsQuery],
    { stdio: "inherit", timeout: 60_000 },
  );
  if (result.error) console.error("Product insights report failed or timed out");
  process.exitCode = result.error ? 1 : (result.status ?? 1);
}
