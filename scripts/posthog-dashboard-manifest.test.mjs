import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  dashboards,
  PRODUCT_POPULATION,
  SCIENTIFIC_OUTCOME,
} from "./posthog-dashboard-manifest.mjs";

const insights = dashboards.flatMap((dashboard) => dashboard.insights ?? []);
const query = (name) => insights.find((insight) => insight.name === name).query.query;

it("keeps reliability ratios within one consent population and stops separate", () => {
  expect(query("Successful assistant-turn rate")).toContain(PRODUCT_POPULATION);
  expect(query("Successful assistant-turn rate")).toContain("nullIf(terminal, 0)");
  expect(query("Successful assistant-turn rate")).not.toContain("provider.turn.stopped");
  expect(query("Provider terminal outcomes")).toContain("provider.turn.stopped");
  expect(query("Provider terminal outcomes")).toContain(PRODUCT_POPULATION);
});

it("uses durable known Product cohort origins and complete later-week denominators", () => {
  const activation = query("Activated installations");
  expect(activation).toContain("properties.productFirstSeenAt IS NOT NULL");
  expect(activation).not.toContain("minIf(timestamp, event = 'app.session.started')");
  expect(activation).toContain("eligible_installations");
  expect(activation).toContain("immature_installations");
  expect(activation).toContain("provider_started >= project_opened");
  const retention = query("Week-one and week-four retained activation");
  expect(retention).toContain("eligible_week_one");
  expect(retention).toContain("eligible_week_four");
  expect(retention).toContain("INTERVAL 2 WEEK <= toStartOfWeek(now())");
  expect(retention).toContain("INTERVAL 5 WEEK <= toStartOfWeek(now())");
});

it("does not count opening a browser/file as a scientific outcome", () => {
  expect(query("Weekly Meaningful Active Installations")).toContain(SCIENTIFIC_OUTCOME);
  expect(SCIENTIFIC_OUTCOME).not.toContain("file-preview");
  expect(SCIENTIFIC_OUTCOME).not.toContain("browser");
  expect(
    insights.some((insight) => insight.name === "First-answer activation by build channel"),
  ).toBe(false);
});

// Execute the actual query text against synthetic records. This small adapter
// covers only the date/property/aggregate functions used below; it does not claim
// to qualify PostHog's parser, timezone configuration, permissions or live data.
const DAY = 86_400;
const WEEK = 7 * DAY;
const NOW = Date.parse("2026-08-31T12:00:00Z") / 1000;
const startOfWeek = (timestamp) => {
  const date = new Date(timestamp * 1000);
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()) / 1000
  );
};
const runQuery = (name, rows) => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE events (distinct_id TEXT, event TEXT, timestamp INTEGER, properties TEXT)",
    );
    const insert = database.prepare("INSERT INTO events VALUES (?, ?, ?, ?)");
    rows.forEach((row, index) =>
      insert.run(
        row.id ?? "desktop-one",
        row.event,
        row.timestamp ?? NOW - DAY,
        JSON.stringify({
          source: "desktop",
          consent_level: "product",
          event_id: `event-${index}`,
          ...row.properties,
        }),
      ),
    );
    database.function("now", () => NOW);
    database.function("parseDateTimeBestEffort", (value) => Date.parse(value) / 1000);
    database.function("toStartOfWeek", startOfWeek);
    database.function("greatest", (left, right) => Math.max(left, right));
    database.aggregate("countIf", {
      start: 0,
      step: (count, condition) => count + (condition ? 1 : 0),
    });
    database.aggregate("minIf", {
      start: () => null,
      step: (minimum, value, condition) =>
        condition ? (minimum === null ? value : Math.min(minimum, value)) : minimum,
      result: (minimum) => minimum ?? 0,
    });
    database.aggregate("uniqExact", {
      start: () => new Set(),
      step: (values, value) => {
        if (value !== null) values.add(value);
        return values;
      },
      result: (values) => values.size,
    });
    for (const aggregate of ["uniqExactIf", "uniqIf"]) {
      database.aggregate(aggregate, {
        start: () => new Set(),
        step: (values, value, condition) => {
          if (condition && value !== null) values.add(value);
          return values;
        },
        result: (values) => values.size,
      });
    }
    const sql = query(name)
      .replace(
        /properties\.([A-Za-z_$][\w$]*)/g,
        (_, key) => `json_extract(properties, '$."${key}"')`,
      )
      .replace(/INTERVAL (\d+) (DAY|WEEK)/g, (_, amount, unit) =>
        String(Number(amount) * (unit === "DAY" ? DAY : WEEK)),
      );
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
};

it("finds a valid ordered activation even after earlier out-of-order attempts", () => {
  const firstSeen = NOW - 14 * DAY;
  const properties = { productFirstSeenAt: new Date(firstSeen * 1000).toISOString() };
  const records = [
    ["provider.session.started", 0],
    ["provider.turn.completed", 60],
    ["project.opened", 100],
    ["provider.session.started", 120],
    ["provider.turn.completed", 150],
  ].map(([event, offset]) => ({ event, timestamp: firstSeen + offset, properties }));
  const unordered = records.slice(0, 3).map((row) => ({ ...row, id: "not-activated" }));
  expect(runQuery("Activated installations", [...records, ...unordered])).toEqual([
    { eligible_installations: 2, immature_installations: 0, activated_installations: 1 },
  ]);
});

it("does not count website or Essential-only identities in desktop engagement", () => {
  const website = Array.from({ length: 100 }, (_, index) => ({
    id: `website-${index}`,
    event: "page_viewed",
    properties: { source: "website" },
  }));
  expect(
    runQuery("Completed turns per active installation", [
      ...website,
      {
        id: "essential-only",
        event: "provider.turn.failed",
        properties: { consent_level: "essential" },
      },
      { event: "provider.turn.completed" },
    ]),
  ).toEqual([{ turns: 1, installations: 1 }]);
});

it("includes the entire oldest calendar week and excludes the current partial week", () => {
  const oldest = startOfWeek(NOW) - 12 * WEEK;
  const turns = [0, DAY, 2 * DAY].map((offset, index) => ({
    event: "provider.turn.completed",
    timestamp: oldest + offset,
    properties: { $session_id: `session-${index % 2}`, event_id: `turn-${index}` },
  }));
  expect(
    runQuery("Weekly Meaningful Active Installations", [
      ...turns,
      turns[0], // Duplicate delivery must not add a completed turn.
      {
        event: "scient.operation.completed",
        timestamp: startOfWeek(NOW) + 1,
        properties: { operationKind: "pdf-export" },
      },
      {
        event: "scient.operation.completed",
        timestamp: oldest - 1,
        properties: { operationKind: "compute-run" },
      },
    ]),
  ).toEqual([{ week: oldest, meaningful_installations: 1 }]);
});

it("counts terminal duration observations without counting their start event", () => {
  const properties = { component: "server", operation: "startup", durationBucket: "lt_1s" };
  const result = runQuery("Duration bucket distribution", [
    { event: "app.health", properties: { ...properties, outcome: "started" } },
    { event: "app.health", properties: { ...properties, outcome: "completed" } },
    {
      event: "scient.operation.started",
      properties: { operationKind: "latex-build", durationBucket: "unknown" },
    },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    event: "app.health",
    health_outcome: "completed",
    outcomes: 1,
  });
});

it("reports import skips separately without counting them as meaningful work", () => {
  const week = startOfWeek(NOW) - WEEK;
  const records = [
    {
      id: "skipped-only",
      event: "scient.operation.skipped",
      timestamp: week + DAY,
      properties: { operationKind: "source-import", durationBucket: "under-1s" },
    },
    {
      id: "imported",
      event: "scient.operation.completed",
      timestamp: week + DAY,
      properties: { operationKind: "source-import", durationBucket: "under-1s" },
    },
    {
      id: "essential-only",
      event: "scient.operation.failed",
      timestamp: week + DAY,
      properties: { operationKind: "source-import", consent_level: "essential" },
    },
  ];
  expect(runQuery("Weekly Meaningful Active Installations", records)).toEqual([
    { week, meaningful_installations: 1 },
  ]);
  expect(runQuery("Scientific operation outcomes", records)).toEqual(
    expect.arrayContaining([
      { operation_kind: "source-import", event: "scient.operation.skipped", outcomes: 1 },
      { operation_kind: "source-import", event: "scient.operation.completed", outcomes: 1 },
    ]),
  );
  expect(runQuery("Scientific operation outcomes", records)).toHaveLength(2);
  expect(
    runQuery("Duration bucket distribution", records)
      .map((row) => row.event)
      .toSorted(),
  ).toEqual(["scient.operation.completed", "scient.operation.skipped"]);
});

it("uses separate mature week-one and week-four retention denominators", () => {
  const matureWeek = startOfWeek(NOW) - 8 * WEEK;
  const recentWeek = startOfWeek(NOW) - 2 * WEEK;
  const activation = (id, week) =>
    ["project.opened", "provider.session.started", "provider.turn.completed"].map(
      (event, index) => ({
        id,
        event,
        timestamp: week + DAY + index,
        properties: {
          productFirstSeenAt: new Date((week + DAY) * 1000).toISOString(),
          $session_id: "activation",
        },
      }),
    );
  const returns = [0, DAY, 2 * DAY].map((offset, index) => ({
    id: "mature",
    event: "provider.turn.completed",
    timestamp: matureWeek + WEEK + offset,
    properties: {
      productFirstSeenAt: new Date((matureWeek + DAY) * 1000).toISOString(),
      $session_id: `return-${index % 2}`,
    },
  }));
  expect(
    runQuery("Week-one and week-four retained activation", [
      ...activation("mature", matureWeek),
      ...activation("recent", recentWeek),
      ...returns,
      {
        id: "mature",
        event: "scient.operation.completed",
        timestamp: matureWeek + 4 * WEEK + DAY,
        properties: { operationKind: "latex-build" },
      },
    ]),
  ).toEqual([
    {
      activation_week: matureWeek,
      eligible_week_one: 1,
      eligible_week_four: 1,
      retained_week_one: 1,
      retained_week_four: 1,
    },
    {
      activation_week: recentWeek,
      eligible_week_one: 1,
      eligible_week_four: 0,
      retained_week_one: 0,
      retained_week_four: 0,
    },
  ]);
});

it("keeps managed insight aliases unique so corrected names update rather than duplicate", () => {
  const names = insights.flatMap((insight) => [insight.name, ...(insight.aliases ?? [])]);
  expect(new Set(names).size).toBe(names.length);
  expect(
    insights.find((insight) => insight.name === "Observed website identities").aliases,
  ).toContain("Active website visitors");
});
