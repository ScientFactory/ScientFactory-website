import { afterEach, expect, it, vi } from "vitest";
import worker, { flushPendingEvents } from "./index";
import { testDatabase } from "./sqlite.testSupport";
import { prunePeopleAnalytics } from "../../../functions/_lib/analyticsPeople";
import { insertSiteEvent } from "../../../functions/_lib/events";

const installation = "installation:10000000-0000-4000-8000-000000000001";
const token = "a".repeat(64);
const stores: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.close();
});
function fixture(enabled = true) {
  const store = testDatabase();
  stores.push(store);
  const tasks: Promise<unknown>[] = [];
  const env = {
    ANALYTICS_DB: store.database,
    DESKTOP_INGESTION_ENABLED: "true",
    IDENTITY_ANALYTICS_ENABLED: String(enabled),
    DESKTOP_POSTHOG_EXPORT_ENABLED: "true",
    ANALYTICS_INGESTION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const send = async (
    name: string,
    properties: Record<string, unknown>,
    id = crypto.randomUUID(),
    secret = token,
  ) => {
    const request = new Request("https://events.scientfactory.com/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Scient-Installation-Token": secret,
        "CF-Connecting-IP": "192.0.2.4",
      },
      body: JSON.stringify({
        schema_version: 1,
        source: "desktop",
        events: [
          {
            id,
            name,
            properties,
            distinct_id: installation,
            session_id: "session:10000000-0000-4000-8000-000000000002",
            occurred_at: new Date().toISOString(),
            privacy_level: "product",
            consent_level: "product",
          },
        ],
      }),
    });
    Object.defineProperty(request, "cf", {
      value: {
        country: "IL",
        region: "Jerusalem",
        city: "Jerusalem",
        timezone: "Asia/Jerusalem",
        asn: 64500,
        asOrganization: "Synthetic network",
      },
    });
    return worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    });
  };
  const erase = () =>
    worker.fetch!(
      new Request("https://events.scientfactory.com/v1/installations/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Scient-Installation-Token": token },
        body: JSON.stringify({ schema_version: 1, installation_id: installation }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      { waitUntil: () => {} },
    );
  return { ...store, env, send, erase, tasks };
}

it("keeps collection disabled until activation, while acknowledging newer clients", async () => {
  const f = fixture(false);
  expect(
    (
      await f.send("install.account_observed", {
        provider: "codex",
        email: "synthetic@scient.test",
      })
    ).status,
  ).toBe(202);
  for (const table of [
    "analytics_events",
    "analytics_installation_accounts",
    "analytics_installation_sightings",
  ])
    expect(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
});

it("stores identity separately and never exports its events or request network", async () => {
  const f = fixture();
  expect(
    (
      await f.send("install.account_observed", {
        provider: "codex",
        email: "synthetic@scient.test",
        plan: "Pro",
      })
    ).status,
  ).toBe(202);
  await f.send("install.profile_observed", {
    workKinds: ["scientific"],
    field: "biology",
    role: "researcher",
  });
  await f.send("install.owner_observed", { ownerSource: "device", ownerId: "1".repeat(64) });
  await f.send("provider.turn.sent", { provider: "codex", modelKey: "model-new" });
  expect(
    f.sqlite.prepare("SELECT email, plan FROM analytics_installation_accounts").get(),
  ).toMatchObject({ email: "synthetic@scient.test", plan: "Pro" });
  expect(
    f.sqlite.prepare("SELECT ip_address, country FROM analytics_installation_sightings").get(),
  ).toMatchObject({ ip_address: "192.0.2.4", country: "IL" });
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await flushPendingEvents({ ...f.env, POSTHOG_PROJECT_TOKEN: "synthetic" })).toBe(1);
  const body = String(fetcher.mock.calls[0]![1].body);
  expect(body).not.toContain("synthetic@scient.test");
  expect(body).not.toContain("192.0.2.4");
  expect(body).not.toContain('"ownerSource":"device"');
  expect(body).toContain("provider.turn.sent");
});

it("rejects wrong tokens and ignores event replays without inflating totals or changing identity", async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  await f.send("install.account_observed", { provider: "codex", email: "one@scient.test" }, id);
  await f.send("install.account_observed", { provider: "codex", email: "two@scient.test" }, id);
  expect(
    f.sqlite.prepare("SELECT count(*) AS n FROM analytics_installation_accounts").get()!.n,
  ).toBe(1);
  expect((await f.send("provider.turn.sent", {}, crypto.randomUUID(), "b".repeat(64))).status).toBe(
    403,
  );
  const turn = crypto.randomUUID();
  await f.send("provider.turn.sent", {}, turn);
  await f.send("provider.turn.sent", {}, turn);
  await f.send("provider.turn.sent", {});
  expect(
    f.sqlite
      .prepare(
        "SELECT value FROM analytics_daily_totals WHERE metric = 'events' AND dimension = 'provider.turn.sent'",
      )
      .get()!.value,
  ).toBe(2);
  expect(
    f.sqlite
      .prepare("SELECT value FROM analytics_daily_totals WHERE metric = 'active_installations'")
      .get()!.value,
  ).toBe(1);
});

it("erases installation observations, preserves aggregates and prevents resurrection", async () => {
  const f = fixture();
  await f.send("install.account_observed", { provider: "codex", email: "one@scient.test" });
  await f.send("install.owner_observed", { ownerSource: "device", ownerId: "1".repeat(64) });
  await f.send("install.profile_observed", { field: "biology" });
  await f.send("provider.turn.sent", {});
  expect((await f.erase()).status).toBe(202);
  for (const table of [
    "analytics_events",
    "analytics_installation_accounts",
    "analytics_installation_profiles",
    "analytics_installation_devices",
    "analytics_installation_sightings",
    "analytics_daily_members",
  ])
    expect(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
  expect(
    f.sqlite.prepare("SELECT count(*) AS n FROM analytics_daily_totals").get()!.n,
  ).toBeGreaterThan(0);
  expect((await f.send("provider.turn.sent", {})).status).toBe(403);
});

it("retains active usage history and expires inactive identities and 60-day diagnostics", async () => {
  const f = fixture();
  await f.send("provider.turn.sent", {});
  f.sqlite.exec(
    "UPDATE analytics_events SET occurred_at = datetime('now', '-400 days'), received_at = datetime('now', '-400 days')",
  );
  await prunePeopleAnalytics(f.database);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(1);
  f.sqlite.exec(
    "UPDATE analytics_events SET privacy_level = 'diagnostic', occurred_at = datetime('now', '-61 days')",
  );
  await prunePeopleAnalytics(f.database);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(0);
  await f.send("provider.turn.sent", {});
  f.sqlite.exec("UPDATE analytics_identities SET last_seen_at = datetime('now', '-3 years')");
  await prunePeopleAnalytics(f.database);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_identities").get()!.n).toBe(0);
  expect(
    f.sqlite.prepare("SELECT count(*) AS n FROM analytics_installation_sightings").get()!.n,
  ).toBe(0);
});

it("records website network only when enabled and exposes tentative download candidates", async () => {
  const f = fixture();
  const request = new Request("https://scientfactory.com/download", {
    headers: { "CF-Connecting-IP": "192.0.2.4" },
  });
  await insertSiteEvent(f.database, { eventName: "download_clicked" }, request, false);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_web_sightings").get()!.n).toBe(0);
  await insertSiteEvent(f.database, { eventName: "download_clicked" }, request, true);
  await f.send("provider.turn.sent", {});
  expect(
    f.sqlite.prepare("SELECT evidence FROM analytics_download_installation_candidates").get(),
  ).toMatchObject({ evidence: "shared_ip_within_24h" });
});

it("reports bounded retention backlogs until every expiry predicate is drained", async () => {
  const f = fixture();
  f.sqlite.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 5001)
    INSERT INTO site_events(event_name, occurred_at) SELECT 'page_viewed', datetime('now','-3 years') FROM n`);
  await expect(prunePeopleAnalytics(f.database)).rejects.toThrow("retention-backlog");
  await prunePeopleAnalytics(f.database);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM site_events").get()!.n).toBe(0);
});

it("keeps two connected services distinct when neither exposes an email or tier", async () => {
  const f = fixture();
  await f.send("install.account_observed", { provider: "scient", accountType: "anthropic" });
  await f.send("install.account_observed", { provider: "scient", accountType: "openai-codex" });
  expect(
    f.sqlite
      .prepare("SELECT account_type FROM analytics_installation_accounts ORDER BY account_type")
      .all(),
  ).toEqual([{ account_type: "anthropic" }, { account_type: "openai-codex" }]);
});

it("does not reinterpret an immutable event replay as an account observation", async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  const properties = { provider: "codex", plan: "Pro" };
  await f.send("provider.turn.sent", properties, id);
  await f.send("install.account_observed", properties, id);
  expect(
    f.sqlite.prepare("SELECT count(*) AS n FROM analytics_installation_accounts").get()!.n,
  ).toBe(0);
});

it("ignores malformed device hashes without failing an otherwise valid batch", async () => {
  const f = fixture();
  expect((await f.send("install.owner_observed", { ownerSource: "device" })).status).toBe(202);
  expect(
    (await f.send("install.owner_observed", { ownerSource: "device", ownerId: ["one"] })).status,
  ).toBe(202);
  expect(
    f.sqlite.prepare("SELECT count(*) AS n FROM analytics_installation_devices").get()!.n,
  ).toBe(0);
});

it("expires failure observations after 60 days without dropping old active usage exports", async () => {
  const f = fixture();
  await f.send("provider.turn.failed", {});
  f.sqlite.exec("UPDATE analytics_events SET occurred_at = datetime('now', '-61 days')");
  await prunePeopleAnalytics(f.database);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(0);
  await f.send("provider.turn.sent", {});
  f.sqlite.exec(
    "UPDATE analytics_events SET occurred_at = datetime('now', '-400 days'), received_at = datetime('now', '-400 days')",
  );
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await flushPendingEvents({ ...f.env, POSTHOG_PROJECT_TOKEN: "synthetic" })).toBe(1);
});

it("retains a canonical account while any linked installation or visitor remains active", async () => {
  const f = fixture();
  f.sqlite
    .exec(`INSERT INTO analytics_identities(identity_id, identity_type, canonical_id, consent_level, first_seen_at, last_seen_at)
    VALUES ('account:one', 'account', 'account:one', 'product', datetime('now','-3 years'), datetime('now','-3 years')),
    ('visitor:one', 'web_visitor', 'account:one', 'product', datetime('now','-3 years'), datetime('now'));
    INSERT INTO analytics_identity_links(link_id, source_identity_id, canonical_id, linked_at)
    VALUES ('link:one','visitor:one','account:one',datetime('now','-3 years'))`);
  await prunePeopleAnalytics(f.database);
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_identities").get()!.n).toBe(2);
  expect(
    f.sqlite.prepare("SELECT canonical_id FROM analytics_identity_links").get()!.canonical_id,
  ).toBe("account:one");
});

it("retains old network observations for active website visitors, expiring unlinked observations", async () => {
  const f = fixture();
  f.sqlite
    .exec(`INSERT INTO analytics_identities(identity_id, identity_type, canonical_id, consent_level, first_seen_at, last_seen_at)
    VALUES ('visitor:active', 'web_visitor', 'visitor:active', 'product', datetime('now','-3 years'), datetime('now'));
    INSERT INTO analytics_web_sightings(event_id,event_name,occurred_at,visitor_id,ip_address)
    VALUES ('event:active','download_clicked',datetime('now','-3 years'),'visitor:active','192.0.2.1'),
    ('event:orphan','download_clicked',datetime('now','-3 years'),'web-event:orphan','192.0.2.2')`);
  await prunePeopleAnalytics(f.database);
  expect(f.sqlite.prepare("SELECT event_id FROM analytics_web_sightings").all()).toEqual([
    { event_id: "event:active" },
  ]);
});
