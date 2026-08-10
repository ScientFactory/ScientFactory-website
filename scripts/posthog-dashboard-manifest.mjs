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

const preparedInsight = (name, description, query) => ({
  name,
  description,
  query: hogql(query),
});

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
        name: "Active website visitors",
        description:
          "Unique consented or event-scoped website identities. Interpret with the consent model documented in the repository.",
        query: trends({
          series: [event("page_viewed", "Active website visitors", "dau")],
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
        "Monthly event volume and free-tier budget",
        "Rolling 30-day event volume. Compare this total with the configured PostHog billing limit before enabling a wider cohort.",
        "SELECT count() AS events_last_30_days, round(count() / 1000000 * 100, 1) AS percent_of_one_million FROM events WHERE timestamp >= now() - INTERVAL 30 DAY",
      ),
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
        "An installation qualifies after three completed turns across two sessions, or one completed scientific operation, in a calendar week.",
        `SELECT week, countIf(turns >= 3 AND sessions >= 2 OR scientific_operations >= 1) AS meaningful_installations
FROM (
  SELECT toStartOfWeek(timestamp) AS week, distinct_id,
    countIf(event = 'provider.turn.completed') AS turns,
    uniqIf(properties.$session_id, event = 'provider.turn.completed') AS sessions,
    countIf(event = 'scient.operation.completed') AS scientific_operations
  FROM events
  WHERE timestamp >= now() - INTERVAL 12 WEEK
  GROUP BY week, distinct_id
)
GROUP BY week ORDER BY week`,
      ),
      preparedInsight(
        "Successful assistant-turn rate",
        "Completed provider turns divided by all terminal provider-turn outcomes.",
        `SELECT toStartOfDay(timestamp) AS day,
  round(100 * countIf(event = 'provider.turn.completed') / nullIf(countIf(event IN ('provider.turn.completed', 'provider.turn.failed')), 0), 1) AS success_percent
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day`,
      ),
      preparedInsight(
        "Activated installations",
        "Installations that opened a project, started a provider session, and completed a provider turn within seven days of first use.",
        `WITH journeys AS (
  SELECT distinct_id,
    minIf(timestamp, event = 'app.session.started') AS first_seen,
    minIf(timestamp, event = 'project.opened') AS project_opened,
    minIf(timestamp, event = 'provider.session.started') AS provider_started,
    minIf(timestamp, event = 'provider.turn.completed') AS turn_completed
  FROM events
  WHERE timestamp >= now() - INTERVAL 90 DAY
    AND event IN ('app.session.started', 'project.opened', 'provider.session.started', 'provider.turn.completed')
  GROUP BY distinct_id
)
SELECT countIf(
  project_opened >= first_seen AND project_opened <= first_seen + INTERVAL 7 DAY
  AND provider_started >= first_seen AND provider_started <= first_seen + INTERVAL 7 DAY
  AND turn_completed >= first_seen AND turn_completed <= first_seen + INTERVAL 7 DAY
) AS activated_installations
FROM journeys`,
      ),
      preparedInsight(
        "Week-one and week-four retained activation",
        "Activated cohorts that later qualify for meaningful weekly use in week one or week four.",
        `WITH journeys AS (
  SELECT distinct_id,
    minIf(timestamp, event = 'app.session.started') AS first_seen,
    minIf(timestamp, event = 'project.opened') AS project_opened,
    minIf(timestamp, event = 'provider.session.started') AS provider_started,
    minIf(timestamp, event = 'provider.turn.completed') AS turn_completed
  FROM events
  WHERE timestamp >= now() - INTERVAL 180 DAY
  GROUP BY distinct_id
), activated AS (
  SELECT distinct_id, toStartOfWeek(greatest(project_opened, greatest(provider_started, turn_completed))) AS activation_week
  FROM journeys
  WHERE project_opened >= first_seen AND project_opened <= first_seen + INTERVAL 7 DAY
    AND provider_started >= first_seen AND provider_started <= first_seen + INTERVAL 7 DAY
    AND turn_completed >= first_seen AND turn_completed <= first_seen + INTERVAL 7 DAY
), meaningful AS (
  SELECT distinct_id, toStartOfWeek(timestamp) AS week,
    countIf(event = 'provider.turn.completed') AS turns,
    uniqIf(properties.$session_id, event = 'provider.turn.completed') AS sessions,
    countIf(event = 'scient.operation.completed') AS scientific_operations
  FROM events
  WHERE timestamp >= now() - INTERVAL 180 DAY
  GROUP BY distinct_id, week
  HAVING turns >= 3 AND sessions >= 2 OR scientific_operations >= 1
)
SELECT activation_week,
  uniqExact(activated.distinct_id) AS activated,
  uniqExactIf(activated.distinct_id, meaningful.week = activation_week + INTERVAL 1 WEEK) AS retained_week_one,
  uniqExactIf(activated.distinct_id, meaningful.week = activation_week + INTERVAL 4 WEEK) AS retained_week_four
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
      "First-session and seven-day activation from app start through a completed provider turn.",
    plannedInsights: [
      "App start → project → provider session → successful turn funnel",
      "Median time-to-activation bucket",
      "Activation by build channel",
    ],
    insights: [
      preparedInsight(
        "Activation stage reach",
        "Unique installations reaching each durable activation stage in the selected period.",
        `SELECT event, uniqExact(distinct_id) AS installations
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('app.session.started', 'project.opened', 'provider.session.started', 'provider.turn.completed')
GROUP BY event ORDER BY installations DESC`,
      ),
      preparedInsight(
        "First-answer activation by build channel",
        "Activated installation counts grouped by the bounded build channel recorded on session start.",
        `SELECT properties.buildChannel AS build_channel, uniqExact(distinct_id) AS installations
FROM events
WHERE event = 'provider.turn.completed' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY build_channel ORDER BY installations DESC`,
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
  SELECT distinct_id, countIf(event = 'provider.turn.completed') AS turns
  FROM events WHERE timestamp >= now() - INTERVAL 30 DAY GROUP BY distinct_id
) GROUP BY turns ORDER BY turns`,
      ),
      preparedInsight(
        "Returning active installations by week",
        "Installations active in both the current and immediately preceding week.",
        `WITH weekly AS (
  SELECT distinct_id, toStartOfWeek(timestamp) AS week
  FROM events WHERE event = 'provider.turn.completed' GROUP BY distinct_id, week
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
      preparedInsight(
        "Provider terminal outcomes",
        "Completed and failed provider turns by bounded provider kind.",
        `SELECT properties.provider AS provider, event, count() AS turns
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('provider.turn.completed', 'provider.turn.failed')
GROUP BY provider, event ORDER BY provider, event`,
      ),
      preparedInsight(
        "Model selection",
        "Completed and attempted turns by maintained public model key; private custom model names collapse to other.",
        `SELECT properties.modelKey AS model_key, count() AS turns
FROM events
WHERE event = 'provider.turn.sent' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY model_key ORDER BY turns DESC`,
      ),
      preparedInsight(
        "Provider failure classes",
        "Bounded provider failure classes without raw messages or stack traces.",
        `SELECT properties.provider AS provider, properties.failureClass AS failure_class, count() AS failures
FROM events
WHERE event = 'provider.turn.failed' AND timestamp >= now() - INTERVAL 30 DAY
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
      preparedInsight(
        "Feature completion by installation",
        "Unique installations completing bounded Scient feature outcomes.",
        `SELECT event, uniqExact(distinct_id) AS installations, count() AS completions
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('project.initialization.completed', 'thread.fork.completed', 'thread.revert.completed', 'voice.transcription.completed')
GROUP BY event ORDER BY installations DESC`,
      ),
      preparedInsight(
        "Selected surfaces opened",
        "Once-per-session style surface signals; this is deliberately not clickstream tracking.",
        `SELECT properties.surface AS surface, uniqExact(distinct_id) AS installations, count() AS opens
FROM events
WHERE event = 'surface.opened' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY surface ORDER BY installations DESC`,
      ),
      preparedInsight(
        "Measured settings choices",
        "Bounded direction, theme, and notification choices only.",
        `SELECT properties.setting AS setting, properties.value AS value, count() AS changes
FROM events
WHERE event = 'setting.changed' AND timestamp >= now() - INTERVAL 30 DAY
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
        `SELECT properties.appVersion AS app_version, event, properties.failureClass AS failure_class, count() AS failures
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
  AND event IN ('provider.turn.failed', 'project.add.failed', 'project.initialization.failed', 'thread.fork.failed', 'thread.revert.failed', 'voice.transcription.failed')
GROUP BY app_version, event, failure_class ORDER BY failures DESC`,
      ),
      preparedInsight(
        "Duration bucket distribution",
        "Coarse latency buckets for completed and failed product operations.",
        `SELECT event, properties.durationBucket AS duration_bucket, count() AS outcomes
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY AND properties.durationBucket IS NOT NULL
GROUP BY event, duration_bucket ORDER BY event, outcomes DESC`,
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
      "Registered scientific operations and reviewed outcomes once those operations exist.",
    plannedInsights: [
      "Completed scientific operations",
      "Reviewed outcome rate",
      "Failure class by registered operation",
      "Repeat workflow use",
    ],
    insights: [
      preparedInsight(
        "Scientific operation outcomes",
        "Registered scientific operation completions and bounded failures after those operations ship.",
        `SELECT properties.operationKind AS operation_kind, event, count() AS outcomes
FROM events
WHERE event IN ('scient.operation.completed', 'scient.operation.failed')
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
