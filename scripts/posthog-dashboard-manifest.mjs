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
  },
  {
    key: "reliability",
    name: "05 — Scient reliability and release health",
    phase: "planned",
    requiredEvents: [
      "provider.turn.completed",
      "provider.turn.failed",
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
  },
];
