import { expect, it } from "vitest";
import { analyticsReportQuery } from "./analytics-report.mjs";
import { testDatabase } from "../workers/events/src/sqlite.testSupport.ts";

const fixedQuery = analyticsReportQuery.replaceAll("'now'", "'2026-08-31T12:00:00.000Z'");

it("reports centrally retained diagnostics separately from PostHog delivery", () => {
  const store = testDatabase();
  try {
    store.sqlite.exec(`INSERT INTO analytics_events
      (event_id, event_name, source, privacy_level, occurred_at, distinct_id, properties_json)
      VALUES ('diagnostic', 'app.diagnostics', 'desktop', 'diagnostic', '2026-08-30', 'private-id', '{"deliveryClass":"retrying"}');`);
    const rows = store.sqlite.prepare(fixedQuery).all();
    expect(rows.find((row) => row.report_section === "posthog_delivery")).toMatchObject({
      item: "first-party-only",
      event_count: 1,
    });
    expect(rows.find((row) => row.report_section === "30_day_desktop_diagnostics")).toMatchObject({
      event_count: 1,
    });
    expect(JSON.stringify(rows)).not.toContain("private-id");
  } finally {
    store.close();
  }
});

it("keeps the aggregate report's 30-day window correct across SQLite and ISO timestamps", () => {
  const store = testDatabase();
  try {
    const insert = store.sqlite.prepare(`INSERT INTO analytics_events
      (event_id, event_name, source, privacy_level, occurred_at, distinct_id, session_id, properties_json)
      VALUES (?, 'app.session.started', 'desktop', 'essential', ?, 'private-installation', ?, '{}')`);
    insert.run("old", "2026-08-01T09:00:00.000Z", "old-session");
    insert.run("recent", "2026-08-01 15:00:00", "recent-session");
    const rows = store.sqlite.prepare(fixedQuery).all();
    expect(rows.find((row) => row.report_section === "30_day_session")).toMatchObject({
      item: "desktop",
      event_count: 1,
    });
    expect(rows.find((row) => row.report_section === "retained_event")).toMatchObject({
      event_count: 2,
    });
    expect(JSON.stringify(rows)).not.toContain("private-installation");
    expect(JSON.stringify(rows)).not.toContain("old-session");
  } finally {
    store.close();
  }
});

it("shows blocked erasure, quarantine and missing or stale maintenance without raw errors", () => {
  const store = testDatabase();
  try {
    store.sqlite.exec(`INSERT INTO analytics_events
      (event_id, event_name, source, privacy_level, occurred_at, distinct_id, properties_json, posthog_attempts, posthog_last_error)
      VALUES ('retry', 'app.health', 'desktop', 'essential', '2026-08-30', 'private-id', '{}', 20, 'private-error-text');
      INSERT INTO analytics_deletion_requests (request_id, installation_id, requested_at, posthog_state)
      VALUES ('erase', 'private-id', '2026-08-30', 'blocked');
      INSERT INTO analytics_maintenance_status VALUES ('retention', '2026-08-31 11:00:00', 'ok');`);
    const rows = store.sqlite.prepare(fixedQuery).all();
    expect(rows.find((row) => row.report_section === "delivery_attention")).toMatchObject({
      item: "desktop:retry-exhausted",
      event_count: 1,
    });
    expect(rows.find((row) => row.report_section === "deletion_state")).toMatchObject({
      item: "blocked",
      event_count: 1,
    });
    const maintenance = rows.filter((row) => row.report_section === "maintenance");
    expect(maintenance.map((row) => row.item).sort()).toEqual([
      "deletion:never-run",
      "event-export:never-run",
      "identity-export:never-run",
      "retention:stale-ok",
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/private-id|private-error-text/);
  } finally {
    store.close();
  }
});
