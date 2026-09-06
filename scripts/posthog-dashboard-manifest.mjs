import { providerUsageInsights, featureUsageInsights } from "./product-insights-hogql.mjs";

const event = (name, customName = name, math = "total") => ({
  kind: "EventsNode",
  event: name,
  name,
  custom_name: customName,
  math,
});

const trends = ({ series, display = "ActionsLineGraph", dateFrom = "-30d", interval = "day" }) => ({
  kind: "InsightVizNode",
  source: {
    kind: "TrendsQuery",
    series,
    version: 4,
    interval,
    dateRange: { date_from: dateFrom, explicitDate: false },
    properties: [],
    trendsFilter: {
      display,
      showLegend: series.length > 1,
      yAxisScaleType: "linear",
      showValuesOnSeries: false,
      smoothingIntervals: 1,
      showPercentStackView: false,
      aggregationAxisFormat: "numeric",
      showAlertThresholdLines: false,
    },
    breakdownFilter: { breakdown_type: "event" },
    filterTestAccounts: false,
  },
});

const hogql = (query) => ({ kind: "HogQLQuery", query });

const preparedInsight = (name, description, query, aliases = []) => ({
  name,
  description,
  query: hogql(query),
  aliases,
});

// Product denominators never mix Product successes with Essential-only failures.
// These are participating installations/profiles, not accounts or all Scient users.
export const PRODUCT_POPULATION =
  "properties.source = 'desktop' AND properties.consent_level IN ('product', 'diagnostic')";
export const SCIENTIFIC_OUTCOME =
  "event = 'scient.operation.completed' AND properties.operationKind IN ('pdf-export', 'source-import', 'compute-run', 'compute-artifact', 'latex-build', 'document-export')";
const JOURNEYS = `cohort_events AS (
  SELECT distinct_id, event, timestamp, properties.productFirstSeenAt AS cohort_start
  FROM events
  WHERE ${PRODUCT_POPULATION} AND properties.productFirstSeenAt IS NOT NULL
    AND timestamp >= now() - INTERVAL 180 DAY
), projects AS (
  SELECT distinct_id,
    min(parseDateTimeBestEffort(cohort_start)) AS first_seen,
    minIf(timestamp, event = 'project.opened') AS project_opened
  FROM cohort_events
  GROUP BY distinct_id
  HAVING first_seen >= now() - INTERVAL 180 DAY
), providers AS (
  SELECT projects.distinct_id, projects.first_seen, projects.project_opened,
    minIf(cohort_events.timestamp, cohort_events.event = 'provider.session.started'
      AND cohort_events.timestamp >= projects.project_opened) AS provider_started
  FROM projects INNER JOIN cohort_events ON projects.distinct_id = cohort_events.distinct_id
  GROUP BY projects.distinct_id, projects.first_seen, projects.project_opened
), journeys AS (
  SELECT providers.distinct_id, providers.first_seen, providers.project_opened, providers.provider_started,
    minIf(cohort_events.timestamp, cohort_events.event = 'provider.turn.completed'
      AND cohort_events.timestamp >= providers.provider_started) AS turn_completed
  FROM providers INNER JOIN cohort_events ON providers.distinct_id = cohort_events.distinct_id
  GROUP BY providers.distinct_id, providers.first_seen, providers.project_opened, providers.provider_started
)`;
const ACTIVATED =
  "project_opened >= first_seen AND provider_started >= project_opened AND turn_completed >= provider_started AND turn_completed <= first_seen + INTERVAL 7 DAY";

export const dashboards = [
  {
    key: "pipeline",
    name: "90 — Scient analytics pipeline and data quality",
    aliases: ["00 — Scient analytics: current coverage"],
    phase: "current",
    requiredEvents: ["server.boot.heartbeat"],
    description:
      "Current first-party event coverage. D1 remains the delivery source of truth; use bun run analytics:report for queue reconciliation.",
    insights: [
      {
        name: "Current event volume",
        description: "Daily volume for the event families that currently exist in this project.",
        query: trends({
          series: [
            event("page_viewed", "Website page views"),
            event("server.boot.heartbeat", "Desktop server heartbeats"),
            event("outbound_link_clicked", "Website outbound links"),
            event("provider.sessions.stopped_all", "Desktop shutdowns"),
            event("download_clicked", "Website downloads"),
          ],
        }),
      },
      {
        name: "Active desktop installations",
        description:
          "Unique pseudonymous installations emitting server heartbeats. This is not an account or named-user count.",
        query: trends({
          series: [event("server.boot.heartbeat", "Active installations", "dau")],
          interval: "day",
        }),
      },
      {
        name: "Observed website identities",
        aliases: ["Active website visitors"],
        description:
          "Consent-dependent identity count, not a visitor count: without persistent consent each event may have its own identity.",
        query: trends({
          series: [event("page_viewed", "Observed website identities", "dau")],
          interval: "day",
        }),
      },
      {
        name: "Desktop heartbeat volume (30 days)",
        description: "Total accepted desktop heartbeat events over the last 30 days.",
        query: trends({
          series: [event("server.boot.heartbeat", "Heartbeats")],
          display: "BoldNumber",
        }),
      },
      preparedInsight(
        "Monthly event volume",
        "Rolling 30-day event volume. Billing limits are configured separately; this is not a cost estimate or calendar-month invoice count.",
        "SELECT count() AS events_last_30_days FROM events WHERE timestamp >= now() - INTERVAL 30 DAY",
        ["Monthly event volume and free-tier budget"],
      ),
      {
        ...preparedInsight(
          "Observed provider lifecycle outcomes",
          "Observed starts and terminal outcomes, not clicks or a current-state fleet. Product/Diagnostic population only; failures at Essential consent appear in the failure view.",
          `SELECT properties.appVersion AS app_version, properties.provider AS provider,
  properties.action AS action, properties.runtimeSource AS runtime_source, event,
  uniqExact(properties.event_id) AS observations
FROM events WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('provider.lifecycle.started', 'provider.lifecycle.completed', 'provider.lifecycle.failed', 'provider.lifecycle.cancelled')
GROUP BY app_version, provider, action, runtime_source, event ORDER BY observations DESC`,
        ),
        requiredEvents: ["provider.lifecycle.started"],
      },
      {
        ...preparedInsight(
          "Observed provider readiness transitions",
          "Reported changes only. Missing or offline installations are not assumed ready, and no observations is not a healthy zero.",
          `SELECT properties.provider AS provider, properties.from AS previous_state,
  properties.to AS next_state, uniqExact(properties.event_id) AS transitions
FROM events WHERE ${PRODUCT_POPULATION} AND event = 'provider.readiness.changed'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY provider, previous_state, next_state ORDER BY transitions DESC`,
        ),
        requiredEvents: ["provider.readiness.changed"],
      },
      {
        ...preparedInsight(
          "Observed app health outcomes",
          "Server startup and renderer termination observations by release and consent. Desktop-update and migration coverage is not implied; counts are not a success rate.",
          `SELECT properties.appVersion AS app_version, properties.component AS component,
  properties.operation AS operation, properties.outcome AS outcome, properties.consent_level AS consent,
  uniqExact(properties.event_id) AS observations
FROM events WHERE properties.source = 'desktop' AND event = 'app.health'
  AND properties.outcome IN ('completed', 'failed', 'abnormal') AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY app_version, component, operation, outcome, consent ORDER BY observations DESC`,
          ["Observed server health outcomes"],
        ),
        requiredEvents: ["app.health"],
      },
    ],
  },
  {
    key: "executive",
    name: "00 — Scient executive product health",
    phase: "planned",
    requiredEvents: ["app.session.started", "project.opened", "provider.turn.completed"],
    description:
      "Activation, meaningful weekly use, retention, and reliability guardrails in one decision view.",
    plannedInsights: [
      "Weekly Meaningful Active Installations",
      "Seven-day activation rate",
      "Week-one and week-four retained activation",
      "Successful assistant-turn rate",
    ],
    insights: [
      preparedInsight(
        "Weekly Meaningful Active Installations",
        "Twelve complete calendar weeks. An installation qualifies after three completed turns across two sessions, or one completed scientific operation; the current partial week is excluded.",
        `SELECT week, countIf(turns >= 3 AND sessions >= 2 OR scientific_operations >= 1) AS meaningful_installations
FROM (
  SELECT toStartOfWeek(timestamp) AS week, distinct_id,
    uniqExactIf(properties.event_id, event = 'provider.turn.completed') AS turns,
    uniqIf(properties.$session_id, event = 'provider.turn.completed') AS sessions,
    uniqExactIf(properties.event_id, ${SCIENTIFIC_OUTCOME}) AS scientific_operations
  FROM events
  WHERE ${PRODUCT_POPULATION} AND timestamp >= toStartOfWeek(now()) - INTERVAL 12 WEEK
    AND timestamp < toStartOfWeek(now())
  GROUP BY week, distinct_id
)
GROUP BY week ORDER BY week`,
      ),
      preparedInsight(
        "Successful assistant-turn rate",
        "Product-consenting completed turns divided by completed plus failed turns. Stops/cancellations are reported separately; Essential-only failures are excluded from this denominator.",
        `SELECT toStartOfDay(timestamp) AS day,
  uniqExactIf(properties.event_id, event = 'provider.turn.completed') AS completed,
  uniqExactIf(properties.event_id, event IN ('provider.turn.completed', 'provider.turn.failed')) AS terminal,
  round(100 * completed / nullIf(terminal, 0), 1) AS success_percent
FROM events
WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY
  AND (event <> 'provider.turn.failed' OR properties.failureClass NOT IN ('cancelled', 'interrupted'))
GROUP BY day ORDER BY day`,
      ),
      preparedInsight(
        "Activated installations",
        "Ordered project → provider session → completed turn within seven days of first observed Product participation. Only complete seven-day windows and known cohort origins count; not install-to-activation conversion.",
        `WITH ${JOURNEYS}
SELECT countIf(first_seen <= now() - INTERVAL 7 DAY) AS eligible_installations,
  countIf(first_seen > now() - INTERVAL 7 DAY) AS immature_installations,
  countIf(first_seen <= now() - INTERVAL 7 DAY AND ${ACTIVATED}) AS activated_installations
FROM journeys`,
      ),
      preparedInsight(
        "Week-one and week-four retained activation",
        "Activated Product cohorts qualifying for meaningful later-week use. Separate mature denominators exclude incomplete week-one/week-four windows; absent cohort history is unknown, not new.",
        `WITH ${JOURNEYS}, activated AS (
  SELECT distinct_id, toStartOfWeek(greatest(project_opened, greatest(provider_started, turn_completed))) AS activation_week
  FROM journeys
  WHERE ${ACTIVATED}
), meaningful AS (
  SELECT distinct_id, toStartOfWeek(timestamp) AS week,
    uniqExactIf(properties.event_id, event = 'provider.turn.completed') AS turns,
    uniqIf(properties.$session_id, event = 'provider.turn.completed') AS sessions,
    uniqExactIf(properties.event_id, ${SCIENTIFIC_OUTCOME}) AS scientific_operations
  FROM events
  WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 180 DAY
  GROUP BY distinct_id, week
  HAVING turns >= 3 AND sessions >= 2 OR scientific_operations >= 1
)
SELECT activation_week,
  uniqExactIf(activated.distinct_id, activation_week + INTERVAL 2 WEEK <= toStartOfWeek(now())) AS eligible_week_one,
  uniqExactIf(activated.distinct_id, activation_week + INTERVAL 5 WEEK <= toStartOfWeek(now())) AS eligible_week_four,
  uniqExactIf(activated.distinct_id, activation_week + INTERVAL 2 WEEK <= toStartOfWeek(now()) AND meaningful.week = activation_week + INTERVAL 1 WEEK) AS retained_week_one,
  uniqExactIf(activated.distinct_id, activation_week + INTERVAL 5 WEEK <= toStartOfWeek(now()) AND meaningful.week = activation_week + INTERVAL 4 WEEK) AS retained_week_four
FROM activated
LEFT JOIN meaningful ON activated.distinct_id = meaningful.distinct_id
GROUP BY activation_week ORDER BY activation_week`,
      ),
    ],
  },
  {
    key: "activation",
    name: "01 — Scient acquisition and activation",
    phase: "planned",
    requiredEvents: [
      "app.session.started",
      "project.added",
      "project.opened",
      "provider.session.started",
      "provider.turn.completed",
    ],
    description:
      "First-observed Product participation and seven-day activation through an ordered project/provider/answer journey. Not install conversion.",
    plannedInsights: [
      "App start → project → provider session → successful turn funnel",
      "Median time-to-activation bucket",
      "Activation by build channel",
    ],
    insights: [
      preparedInsight(
        "Activation stage reach",
        "Product-participating installations observed at each stage. These independent reach counts are not an ordered funnel or conversion rate.",
        `SELECT event, uniqExact(distinct_id) AS installations
FROM events
WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('app.session.started', 'project.opened', 'provider.session.started', 'provider.turn.completed')
GROUP BY event ORDER BY installations DESC`,
      ),
      preparedInsight(
        "Answer-producing installations by build channel",
        "Product-participating installations with a completed turn, grouped by its build channel. This is not first-use activation.",
        `SELECT properties.buildChannel AS build_channel, uniqExact(distinct_id) AS installations
FROM events
WHERE ${PRODUCT_POPULATION} AND event = 'provider.turn.completed' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY build_channel ORDER BY installations DESC`,
        ["First-answer activation by build channel"],
      ),
    ],
  },
  {
    key: "engagement",
    name: "02 — Scient engagement and retention",
    phase: "planned",
    requiredEvents: ["app.session.started", "provider.turn.completed", "surface.opened"],
    description:
      "Weekly meaningful active installations, depth of core use, and week-one/week-four return behavior.",
    plannedInsights: [
      "Weekly Meaningful Active Installations",
      "Meaningful sessions per installation",
      "Week-one and week-four retention cohorts",
      "Core surface use by returning installations",
    ],
    insights: [
      preparedInsight(
        "Completed turns per active installation",
        "Distribution of completed provider turns per pseudonymous installation over the last 30 days.",
        `SELECT turns, count() AS installations FROM (
  SELECT distinct_id, uniqExactIf(properties.event_id, event = 'provider.turn.completed') AS turns
  FROM events WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY GROUP BY distinct_id
) GROUP BY turns ORDER BY turns`,
      ),
      preparedInsight(
        "Returning active installations by week",
        "Product-participating installations with completed turns in consecutive complete calendar weeks. Not the stricter meaningful-use retention KPI.",
        `WITH weekly AS (
  SELECT distinct_id, toStartOfWeek(timestamp) AS week
  FROM events WHERE ${PRODUCT_POPULATION} AND event = 'provider.turn.completed'
    AND timestamp >= toStartOfWeek(now()) - INTERVAL 13 WEEK AND timestamp < toStartOfWeek(now())
  GROUP BY distinct_id, week
)
SELECT current.week, uniqExact(current.distinct_id) AS returning_installations
FROM weekly AS current
INNER JOIN weekly AS previous ON current.distinct_id = previous.distinct_id AND previous.week = current.week - INTERVAL 1 WEEK
GROUP BY current.week ORDER BY current.week`,
      ),
    ],
  },
  {
    key: "providers",
    name: "03 — Scient providers and agent runtime",
    phase: "planned",
    requiredEvents: [
      "provider.turn.usage",
      "provider.session.started",
      "provider.session.recovered",
      "provider.turn.completed",
      "provider.turn.failed",
    ],
    description: "Provider connection, recovery, success, failure class, and latency guardrails.",
    plannedInsights: [
      "Provider session starts and recoveries",
      "Successful and failed turns by provider",
      "Turn duration buckets by provider",
      "Runtime-mode distribution",
    ],
    insights: [
      ...providerUsageInsights,
      preparedInsight(
        "Provider terminal outcomes",
        "Completed, failed and stopped turns for the same Product-consenting population, by provider. Stopped turns are not failures.",
        `SELECT properties.provider AS provider, event, uniqExact(properties.event_id) AS turns
FROM events
WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('provider.turn.completed', 'provider.turn.failed', 'provider.turn.stopped')
GROUP BY provider, event ORDER BY provider, event`,
      ),
      preparedInsight(
        "Model selection",
        "Attempted turns by maintained public model key; private custom model names collapse to other.",
        `SELECT properties.modelKey AS model_key, uniqExact(properties.event_id) AS turns
FROM events
WHERE ${PRODUCT_POPULATION} AND event = 'provider.turn.sent' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY model_key ORDER BY turns DESC`,
      ),
      preparedInsight(
        "Provider failure classes",
        "Bounded provider failure classes without raw messages or stack traces.",
        `SELECT properties.provider AS provider, properties.failureClass AS failure_class, uniqExact(properties.event_id) AS failures
FROM events
WHERE properties.source = 'desktop' AND event = 'provider.turn.failed' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY provider, failure_class ORDER BY failures DESC`,
      ),
    ],
  },
  {
    key: "features",
    name: "04 — Scient feature adoption",
    phase: "planned",
    requiredEvents: [
      "surface.opened",
      "panel.viewed",
      "settings.viewed",
      "usage.viewed",
      "project.initialization.completed",
      "thread.fork.completed",
      "voice.transcription.completed",
    ],
    description:
      "Repeated adoption of projects, surfaces, forking, voice, settings, and later Scient-owned capabilities.",
    plannedInsights: [
      "Feature adoption by active installation",
      "Repeated feature use",
      "Project initialization outcomes",
      "Fork and voice completion",
    ],
    insights: [
      ...featureUsageInsights,
      preparedInsight(
        "Feature completion by installation",
        "Unique installations completing bounded Scient feature outcomes.",
        `SELECT event, uniqExact(distinct_id) AS installations, uniqExact(properties.event_id) AS completions
FROM events
WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('project.initialization.completed', 'thread.fork.completed', 'thread.revert.completed', 'voice.transcription.completed')
GROUP BY event ORDER BY installations DESC`,
      ),
      preparedInsight(
        "Selected surfaces opened",
        "Once-per-session style surface signals; this is deliberately not clickstream tracking.",
        `SELECT properties.surface AS surface, uniqExact(distinct_id) AS installations, uniqExact(properties.event_id) AS opens
FROM events
WHERE ${PRODUCT_POPULATION} AND event = 'surface.opened' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY surface ORDER BY installations DESC`,
      ),
      preparedInsight(
        "Measured settings choices",
        "Bounded direction, theme, and notification choices only.",
        `SELECT properties.setting AS setting, properties.value AS value, uniqExact(properties.event_id) AS changes
FROM events
WHERE ${PRODUCT_POPULATION} AND event = 'setting.changed' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY setting, value ORDER BY setting, changes DESC`,
      ),
    ],
  },
  {
    key: "reliability",
    name: "05 — Scient reliability and release health",
    phase: "planned",
    requiredEvents: [
      "provider.turn.completed",
      "provider.turn.failed",
      "project.add.failed",
      "project.initialization.failed",
      "thread.fork.failed",
      "voice.transcription.failed",
    ],
    description: "Release, provider, project, recovery, and voice reliability guardrails.",
    plannedInsights: [
      "Successful assistant-turn rate by version",
      "Bounded failure classes by version",
      "Project, fork, revert, and voice success rates",
      "Release regression comparison",
    ],
    insights: [
      preparedInsight(
        "Failures by class and release",
        "Bounded failures grouped by event, class, and application version.",
        `SELECT properties.appVersion AS app_version, event, properties.failureClass AS failure_class, uniqExact(properties.event_id) AS failures
FROM events
WHERE properties.source = 'desktop' AND timestamp >= now() - INTERVAL 30 DAY
  AND (event IN ('provider.turn.failed', 'project.add.failed', 'project.initialization.failed', 'thread.fork.failed', 'thread.revert.failed', 'voice.transcription.failed', 'provider.lifecycle.failed', 'scient.operation.failed')
    OR (event = 'app.health' AND properties.outcome IN ('failed', 'abnormal')))
GROUP BY app_version, event, failure_class ORDER BY failures DESC`,
      ),
      preparedInsight(
        "Duration bucket distribution",
        "Coarse terminal-outcome latency histograms, not exact percentiles. Starts are excluded; missing duration remains unknown.",
        `SELECT event, properties.component AS component, properties.operation AS operation,
  properties.operationKind AS operation_kind, properties.outcome AS health_outcome,
  properties.durationBucket AS duration_bucket, uniqExact(properties.event_id) AS outcomes
FROM events
WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY
  AND (event IN ('provider.turn.completed', 'provider.turn.failed', 'provider.turn.stopped',
    'provider.lifecycle.completed', 'provider.lifecycle.failed', 'provider.lifecycle.cancelled',
    'scient.operation.completed', 'scient.operation.failed', 'scient.operation.cancelled', 'scient.operation.skipped', 'voice.transcription.completed')
    OR (event = 'app.health' AND properties.outcome IN ('completed', 'failed', 'abnormal')))
GROUP BY event, component, operation, operation_kind, health_outcome, duration_bucket ORDER BY event, outcomes DESC`,
      ),
    ],
  },
  {
    key: "scientific-workflows",
    name: "06 — Scient scientific workflows",
    phase: "planned",
    requiredEvents: [
      "scient.operation.started",
      "scient.operation.completed",
      "scient.operation.failed",
    ],
    description:
      "Prepared for actual compute-run, latex-build, agent pdf-export and per-item source-import outcomes. Import skips are separate from saved sources; technical completion does not prove scientific review.",
    plannedInsights: [
      "Completed scientific operations",
      "Reviewed outcome rate",
      "Failure class by registered operation",
      "Repeat workflow use",
    ],
    insights: [
      preparedInsight(
        "Scientific operation outcomes",
        "Technical completions, failures, cancellations and no-op skips for qualified producers in one consent population. Source imports count individual attempts, not batches; no reviewed-outcome rate is inferred.",
        `SELECT properties.operationKind AS operation_kind, event, uniqExact(properties.event_id) AS outcomes
FROM events
WHERE ${PRODUCT_POPULATION} AND timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('scient.operation.completed', 'scient.operation.failed', 'scient.operation.cancelled', 'scient.operation.skipped')
GROUP BY operation_kind, event ORDER BY outcomes DESC`,
      ),
    ],
  },
  {
    key: "cloud-mobile",
    name: "07 — Scient cloud and mobile",
    phase: "planned",
    requiredEvents: ["cloud.session.started", "mobile.session.started"],
    description: "Future selected-user cloud and mobile activation, health, and meaningful use.",
    plannedInsights: [
      "Selected-user cloud activation and reliability",
      "Mobile meaningful use and retention",
      "Cross-surface continuation after authenticated linking",
    ],
    insights: [
      preparedInsight(
        "Cloud and mobile session health",
        "Session starts by future governed client surface after those event contracts ship.",
        `SELECT event, uniqExact(distinct_id) AS active_identities, count() AS sessions
FROM events
WHERE event IN ('cloud.session.started', 'mobile.session.started')
GROUP BY event ORDER BY sessions DESC`,
      ),
    ],
  },
];
