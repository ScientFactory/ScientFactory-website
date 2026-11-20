import { expect, it } from "vitest";
import { analyticsReportQueries, analyticsReportQuery } from "./analytics-report.mjs";
import { testDatabase } from "../workers/events/src/sqlite.testSupport.ts";

const fixedQuery = analyticsReportQuery.replaceAll("'now'", "'2026-08-31T12:00:00.000Z'");

it("keeps remote report chunks within the D1 compound SELECT limit", () => {
  const store = testDatabase();
  try {
    const queries = analyticsReportQueries();
    expect(queries.length).toBeGreaterThan(1);
    for (const query of queries) {
      expect(query.match(/\bSELECT\b/g)?.length).toBeLessThanOrEqual(4);
      expect(() => store.sqlite.prepare(query).all()).not.toThrow();
    }
  } finally {
    store.close();
  }
});

it("reports centrally retained diagnostics", () => {
  const store = testDatabase();
  try {
    store.sqlite.exec(`INSERT INTO analytics_events
      (event_id, event_name, source, privacy_level, occurred_at, distinct_id, properties_json)
      VALUES ('diagnostic', 'app.diagnostics', 'desktop', 'diagnostic', '2026-08-30', 'private-id', '{"deliveryClass":"retrying"}');`);
    const rows = store.sqlite.prepare(fixedQuery).all();
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

it("shows blocked erasure and missing or stale maintenance without identifiers", () => {
  const store = testDatabase();
  try {
    store.sqlite
      .exec(`INSERT INTO analytics_deletion_requests (request_id, installation_id, requested_at, posthog_state)
      VALUES ('erase', 'private-id', '2026-08-30', 'blocked');
      INSERT INTO analytics_maintenance_status VALUES ('retention', '2026-08-31 11:00:00', 'ok');`);
    const rows = store.sqlite.prepare(fixedQuery).all();
    expect(rows.find((row) => row.report_section === "deletion_state")).toMatchObject({
      item: "blocked",
      event_count: 1,
    });
    const maintenance = rows.filter((row) => row.report_section === "maintenance");
    expect(maintenance.map((row) => row.item).sort()).toEqual([
      "deletion:never-run",
      "retention:stale-ok",
    ]);
    expect(JSON.stringify(rows)).not.toContain("private-id");
  } finally {
    store.close();
  }
});

it("reports where downloads came from and GitHub's totals without identifiers", () => {
  const store = testDatabase();
  try {
    store.sqlite.exec(`INSERT INTO analytics_events
      (event_id, event_name, source, privacy_level, occurred_at, distinct_id, properties_json)
      VALUES
        ('d1', 'download_clicked', 'website', 'product', '2026-08-30T10:00:00.000Z', 'visitor:private',
          '{"asset_key":"macArm64","referrer_host":"google.com"}'),
        ('d2', 'download_clicked', 'website', 'product', '2026-08-30T11:00:00.000Z', 'web-event:x',
          '{"asset_key":"windowsX64","utm_source":"newsletter","utm_medium":"email","utm_campaign":"launch"}'),
        ('d3', 'download_clicked', 'website', 'product', '2026-08-30T12:00:00.000Z', 'web-event:y',
          '{"asset_key":"linuxX64"}');
      INSERT INTO analytics_web_sightings
        (event_id, event_name, occurred_at, visitor_id, ip_address, country, city, network_name)
      VALUES
        ('d1', 'download_clicked', '2026-08-30T10:00:00.000Z', 'visitor:private', '192.0.2.1', 'US', 'Boston', 'Harvard University'),
        ('d2', 'download_clicked', '2026-08-30T11:00:00.000Z', 'web-event:x', '192.0.2.2', 'IL', 'Tel Aviv', 'Bezeq');
      INSERT INTO github_release_downloads
        (day, repository, release_tag, release_published_at, asset_name, download_count, recorded_at)
      VALUES
        ('2026-08-20', 'ScientFactory/scient-desktop', 'v0.6.1', '2026-07-01T00:00:00Z', 'Scient-0.6.1-arm64.dmg', 40, 'x'),
        ('2026-08-31', 'ScientFactory/scient-desktop', 'v0.6.1', '2026-07-01T00:00:00Z', 'Scient-0.6.1-arm64.dmg', 46, 'x'),
        ('2026-08-31', 'ScientFactory/scient-desktop', 'v0.6.2', '2026-08-25T00:00:00Z', 'Scient-0.6.2-x64.exe', 9, 'x');`);
    const rows = store.sqlite.prepare(fixedQuery).all();
    const section = (name) =>
      Object.fromEntries(
        rows.filter((row) => row.report_section === name).map((row) => [row.item, row.event_count]),
      );
    expect(section("30_day_download_source")).toEqual({
      "google.com": 1,
      newsletter: 1,
      "direct or unknown": 1,
    });
    expect(section("30_day_download_campaign")).toEqual({ "newsletter / email / launch": 1 });
    expect(section("30_day_download_place")).toEqual({ "US / Boston": 1, "IL / Tel Aviv": 1 });
    expect(section("30_day_download_network")).toEqual({ "Harvard University": 1, Bezeq: 1 });
    expect(section("30_day_github_downloads")).toEqual({
      "ScientFactory/scient-desktop:Scient-0.6.1-arm64.dmg": 6,
      "ScientFactory/scient-desktop:Scient-0.6.2-x64.exe": 9,
    });
    expect(JSON.stringify(rows)).not.toContain("private");
    expect(JSON.stringify(rows)).not.toContain("192.0.2");
  } finally {
    store.close();
  }
});
