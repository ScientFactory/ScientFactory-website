// Same Product population and complete-day window as product-insights.mjs.
const population = `properties.source = 'desktop' AND properties.consent_level IN ('product', 'diagnostic')
AND properties.contractRevision = '3' AND timestamp >= toStartOfDay(now()) - INTERVAL 30 DAY AND timestamp < toStartOfDay(now())`;
const insight = (name, description, query) => ({
  name,
  description,
  query: { kind: "HogQLQuery", query },
  aliases: [],
});

export const providerUsageInsights = [
  insight(
    "Provider and model usage",
    "Deduplicated live terminal usage reports, not model-picker clicks. Missing models are unknown; private and mixed-model labels use other. Counts include failed and stopped turns.",
    `SELECT properties.provider AS provider, properties.modelKey AS model,
uniqExact(distinct_id) AS installations, uniqExact(properties.event_id) AS reported_turns
FROM events WHERE ${population} AND event = 'provider.turn.usage'
GROUP BY provider, model ORDER BY reported_turns DESC`,
  ),
  insight(
    "Reported tokens and coverage",
    "Main-agent reported counts only. Cache and reasoning subsets are not added again. Missing counts are not zero; complete/partial/unavailable turns show coverage. Not all-provider billing or subagent totals.",
    `SELECT provider,
count() AS reported_turns, countIf(status = 'complete') AS complete_turns,
countIf(status = 'partial') AS partial_turns, countIf(status = 'unavailable') AS unavailable_turns,
count(input_tokens) AS input_reporting_turns, count(output_tokens) AS output_reporting_turns,
if(count(input_tokens) = 0, NULL, sum(input_tokens)) AS reported_input_tokens,
if(count(output_tokens) = 0, NULL, sum(output_tokens)) AS reported_output_tokens
FROM (SELECT properties.event_id AS id, any(properties.provider) AS provider,
any(properties.usageStatus) AS status, any(toFloat(properties.inputTokens)) AS input_tokens,
any(toFloat(properties.outputTokens)) AS output_tokens FROM events WHERE ${population}
AND event = 'provider.turn.usage' GROUP BY id)
GROUP BY provider ORDER BY reported_turns DESC`,
  ),
  insight(
    "Providers observed ready",
    "Installations with a provider observed ready during the window. Not signed-in people, current connection inventory, or proof the provider was used.",
    `SELECT properties.provider AS provider, uniqExact(distinct_id) AS installations
FROM events WHERE ${population} AND ((event = 'provider.discovered' AND properties.state = 'ready')
OR (event = 'provider.readiness.changed' AND properties.to = 'ready')) GROUP BY provider ORDER BY installations DESC`,
  ),
];

export const featureUsageInsights = [
  insight(
    "Panel adoption and repeat days",
    "Observed visible category entries, including a visible restored panel. Background tabs are excluded. Repeat means at least two distinct days, not runtime sessions; no eligibility-adjusted adoption rate is claimed.",
    `SELECT category, count() AS installations, sum(observations) AS observations, countIf(days >= 2) AS repeat_installations
FROM (SELECT distinct_id, properties.category AS category, uniqExact(properties.event_id) AS observations,
uniqExact(toDate(timestamp)) AS days FROM events WHERE ${population} AND event = 'panel.viewed'
GROUP BY distinct_id, category) GROUP BY category ORDER BY installations DESC`,
  ),
  insight(
    "Settings sections visited",
    "Visible section entries, not preference changes or evidence of preference. Routes and search text are never collected.",
    `SELECT properties.section AS section, uniqExact(distinct_id) AS installations, uniqExact(properties.event_id) AS observations
FROM events WHERE ${population} AND event = 'settings.viewed' GROUP BY section ORDER BY installations DESC`,
  ),
  insight(
    "Usage tools viewed",
    "Visible metric/range/breakdown combinations. Counts reflect view changes, not imported transcript usage or monetary spend.",
    `SELECT properties.metric AS metric, properties.window AS range_days, properties.breakdown AS breakdown,
uniqExact(distinct_id) AS installations, uniqExact(properties.event_id) AS observations
FROM events WHERE ${population} AND event = 'usage.viewed' GROUP BY metric, range_days, breakdown ORDER BY observations DESC`,
  ),
];
