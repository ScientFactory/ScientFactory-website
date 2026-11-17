import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { flushPendingDeletions, pruneExpiredAnalyticsEvents } from "./index";
import { testDatabase } from "./sqlite.testSupport";
import { posthogRequest, readBoundedJson } from "./transport";
import { withDeletionLease } from "./deletionLease";

const installation = "installation:10000000-0000-4000-8000-000000000001";
const token = "a".repeat(64);
const databases: ReturnType<typeof testDatabase>[] = [];
function fixture(...hooks: Parameters<typeof testDatabase>) {
  const store = testDatabase(...hooks);
  databases.push(store);
  const tasks: Promise<unknown>[] = [];
  const env = {
    ANALYTICS_DB: store.database,
    DESKTOP_INGESTION_ENABLED: "true",
    ANALYTICS_INGESTION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const context = {
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
  } as ExecutionContext;
  const request = (path: string, data: unknown, secret = token) =>
    worker.fetch!(
      new Request(`https://example.invalid${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Scient-Installation-Token": secret },
        body: JSON.stringify(data),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
    );
  const event = (id = crypto.randomUUID()) => ({
    schema_version: 1,
    source: "desktop",
    events: [
      {
        id,
        name: "app.session.started",
        distinct_id: installation,
        session_id: "session:10000000-0000-4000-8000-000000000002",
        occurred_at: new Date().toISOString(),
        privacy_level: "essential",
        consent_level: "essential",
        properties: {
          appVersion: "0.6.8",
          buildChannel: "stable",
          platform: "macos",
          architecture: "arm64",
        },
      },
    ],
  });
  return {
    ...store,
    env,
    request,
    event,
    tasks,
    context,
    erase: () =>
      request("/v1/installations/delete", { schema_version: 1, installation_id: installation }),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

it("does not follow PostHog redirects or turn them into network failures", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
  vi.stubGlobal("fetch", fetcher);

  await expect(
    posthogRequest("https://eu.posthog.com/api/projects/1/persons/", { method: "GET" }),
  ).rejects.toThrow("http");
  expect(fetcher.mock.calls[0]![1].redirect).toBe("manual");
});

describe("inactive gateway readiness with real SQL", () => {
  it("keeps retention bounded and reports an outstanding backlog as unqualified", async () => {
    const f = fixture();
    f.sqlite
      .exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5001)
      INSERT INTO analytics_events (event_id, event_name, source, privacy_level, occurred_at, received_at, distinct_id, properties_json)
      SELECT 'expired-' || n, 'test', 'desktop', 'essential', '2020-01-01', '2020-01-01', 'test', '{}' FROM seq`);
    await expect(pruneExpiredAnalyticsEvents(f.database)).rejects.toThrow("retention-backlog");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(1);
    expect(await pruneExpiredAnalyticsEvents(f.database)).toBe(1);
  });

  it("backfills excluded rows without recounting totals and keeps the table's triggers", async () => {
    const insert = `INSERT INTO analytics_events (event_id, event_name, source, privacy_level,
      occurred_at, distinct_id, properties_json, posthog_state) VALUES (?, ?, 'desktop', ?, ?, ?, ?, ?)`;
    const day = "2026-11-14T10:00:00.000Z";
    const f = fixture(undefined, {
      "0008_analytics_export_excluded.sql": (sqlite) => {
        const rows = [
          ["diagnostic", "app.diagnostics", "diagnostic", "{}", "pending"],
          ["account", "install.account_observed", "product", "{}", "pending"],
          ["device", "install.owner_observed", "product", '{"ownerSource":"device"}', "pending"],
          ["owner", "install.owner_observed", "product", '{"ownerSource":"account"}', "pending"],
          ["product", "provider.turn.sent", "product", "{}", "pending"],
          ["sent", "app.diagnostics", "diagnostic", "{}", "sent"],
        ] as const;
        for (const [id, name, privacy, properties, state] of rows) {
          sqlite.prepare(insert).run(id, name, privacy, day, installation, properties, state);
        }
      },
    });
    expect(
      f.sqlite
        .prepare("SELECT event_id, posthog_state FROM analytics_events ORDER BY event_id")
        .all(),
    ).toEqual([
      { event_id: "account", posthog_state: "excluded" },
      { event_id: "device", posthog_state: "excluded" },
      { event_id: "diagnostic", posthog_state: "excluded" },
      { event_id: "owner", posthog_state: "pending" },
      { event_id: "product", posthog_state: "pending" },
      { event_id: "sent", posthog_state: "sent" },
    ]);
    const eventTotal = () =>
      f.sqlite
        .prepare(
          "SELECT sum(value) AS n FROM analytics_daily_totals WHERE metric = 'events' AND day = '2026-11-14'",
        )
        .get()!.n;
    expect(eventTotal()).toBe(5);
    f.sqlite
      .prepare(insert)
      .run("later", "provider.turn.sent", "product", day, installation, "{}", "pending");
    expect(eventTotal()).toBe(6);
    f.sqlite.exec(`INSERT INTO analytics_deleted_installations
      (installation_id, deletion_token_hash, request_id, requested_at)
      VALUES ('${installation}', 'hash', 'request', '${day}')`);
    expect(() =>
      f.sqlite
        .prepare(insert)
        .run("deleted", "provider.turn.sent", "product", day, installation, "{}", "pending"),
    ).toThrow("deleted-installation");
  });

  it("does not reset diagnostic retention when old offline events arrive", async () => {
    const f = fixture();
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const diagnostic = {
      ...f.event(),
      events: [
        {
          ...f.event().events[0]!,
          name: "app.diagnostics",
          occurred_at: old,
          privacy_level: "diagnostic",
          consent_level: "diagnostic",
          properties: {
            appVersion: "0.6.8",
            buildChannel: "stable",
            contractRevision: "2",
            queuedCountBucket: "0",
            retryCountBucket: "0",
            droppedCountBucket: "unknown",
            deliveryClass: "idle",
          },
        },
      ],
    };
    expect(
      (
        await f.request("/v1/events", {
          ...diagnostic,
          events: [{ ...diagnostic.events[0]!, occurred_at: new Date().toISOString() }],
        })
      ).status,
    ).toBe(202);
    expect((await f.request("/v1/events", diagnostic)).status).toBe(400);
    f.sqlite
      .prepare("UPDATE analytics_events SET privacy_level = 'diagnostic', occurred_at = ?")
      .run(old);
    expect(await pruneExpiredAnalyticsEvents(f.database)).toBe(1);
  });

  it("does not mark a blocked linked-identity erasure as completed", async () => {
    const f = fixture();
    await f.request("/v1/events", f.event());
    f.sqlite.exec("UPDATE analytics_identities SET canonical_id = 'account:synthetic'");
    expect((await f.erase()).status).toBe(202);
    expect(
      f.sqlite.prepare("SELECT posthog_state, completed_at FROM analytics_deletion_requests").get(),
    ).toMatchObject({ posthog_state: "blocked", completed_at: null });
  });

  it("records deletion maintenance failure without preventing the other maintenance passes", async () => {
    const f = fixture();
    await f.request("/v1/events", f.event());
    f.sqlite.exec("UPDATE analytics_identities SET posthog_attempted = 1");
    await f.erase();
    f.sqlite.exec("UPDATE analytics_deletion_requests SET next_attempt_at = NULL");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private remote detail")));
    await worker.scheduled!(
      {} as ScheduledController,
      { ...f.env, POSTHOG_PROJECT_ID: "1", POSTHOG_PERSONAL_API_KEY: "synthetic" },
      f.context,
    );
    await Promise.all(f.tasks);
    expect(
      f.sqlite
        .prepare("SELECT outcome FROM analytics_maintenance_status WHERE name = 'deletion'")
        .get(),
    ).toEqual({ outcome: "failed" });
    expect(
      f.sqlite
        .prepare("SELECT outcome FROM analytics_maintenance_status WHERE name = 'retention'")
        .get(),
    ).toEqual({ outcome: "ok" });
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM analytics_maintenance_status").get()!.n,
    ).toBe(2);
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("private remote detail"),
    );
  });

  it("preserves a legacy erasure across migration without inventing authentication or completion", async () => {
    const f = fixture((sqlite) => {
      sqlite
        .prepare(`INSERT INTO analytics_deletion_requests
        (request_id, installation_id, requested_at, posthog_state, posthog_distinct_id)
        VALUES ('old-request', ?, '2026-08-01T00:00:00Z', 'pending', ?)`)
        .run(installation, installation);
    });
    expect((await f.request("/v1/events", f.event())).status).toBe(403);
    expect((await f.erase()).status).toBe(403);
    expect(
      f.sqlite
        .prepare(
          "SELECT request_id, posthog_state, posthog_last_error_class FROM analytics_deletion_requests",
        )
        .all(),
    ).toEqual([
      {
        request_id: "old-request",
        posthog_state: "blocked",
        posthog_last_error_class: "legacy-unverified-deletion",
      },
    ]);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(0);
  });

  it("does not let out-of-order observations roll consent or last-seen time backward", async () => {
    const f = fixture();
    const latest = f.event();
    const old = f.event();
    old.events[0]!.consent_level = "product";
    old.events[0]!.occurred_at = new Date(Date.now() - 3600000).toISOString();
    await f.request("/v1/events", latest);
    await f.request("/v1/events", old);
    expect(
      f.sqlite
        .prepare(
          "SELECT consent_level, first_seen_at, last_seen_at, product_first_seen_at FROM analytics_identities",
        )
        .get(),
    ).toMatchObject({
      consent_level: "essential",
      first_seen_at: old.events[0]!.occurred_at,
      last_seen_at: latest.events[0]!.occurred_at,
      product_first_seen_at: old.events[0]!.occurred_at,
    });
  });

  it("renews a live lease before transport and aborts an expired owner", async () => {
    const f = fixture();
    let requests = 0;
    await expect(
      withDeletionLease(f.database, async (beforeRequest) => {
        await beforeRequest();
        f.sqlite.exec("UPDATE analytics_maintenance_leases SET expires_at = 0");
        expect(
          await withDeletionLease(f.database, async (newOwnerRequest) => {
            await newOwnerRequest();
            requests += 1;
            return 1;
          }),
        ).toBe(1);
        await beforeRequest();
        requests += 1;
        return 1;
      }),
    ).rejects.toThrow("deletion-lease-lost");
    expect(requests).toBe(1);
  });

  it("rejects desktop account linking even with service credentials", async () => {
    const f = fixture();
    const response = await worker.fetch!(
      new Request("https://example.invalid/v1/identity/link", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic" },
        body: JSON.stringify({
          schema_version: 1,
          account_id: "account:10000000-0000-4000-8000-000000000003",
          identity_ids: [installation],
        }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      { ...f.env, IDENTITY_LINK_TOKEN: "synthetic" },
    );
    expect(response.status).toBe(409);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_identity_links").get()!.n).toBe(0);
  });
  it("deduplicates accepted uploads and blocks resurrection after authenticated erasure", async () => {
    const f = fixture();
    const payload = f.event();
    expect((await f.request("/v1/events", payload)).status).toBe(202);
    expect((await f.request("/v1/events", payload)).status).toBe(202);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(1);
    const first = await (await f.erase()).json();
    expect(first).toMatchObject({ accepted: true, posthog_state: "completed" });
    expect(await (await f.erase()).json()).toEqual(first);
    expect((await f.request("/v1/events", f.event())).status).toBe(403);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(0);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_identities").get()!.n).toBe(0);
    expect(
      (
        await f.request(
          "/v1/installations/delete",
          { schema_version: 1, installation_id: installation },
          "b".repeat(64),
        )
      ).status,
    ).toBe(403);
  });

  it("tombstones a never-uploaded installation too; SQL guards cover stale writers", async () => {
    const f = fixture();
    expect((await f.erase()).status).toBe(202);
    expect(() =>
      f.sqlite
        .prepare(`INSERT INTO analytics_identities
      (identity_id, identity_type, canonical_id, consent_level, first_seen_at, last_seen_at)
      VALUES (?, 'desktop_installation', ?, 'essential', '', '')`)
        .run(installation, installation),
    ).toThrow("deleted-installation");
    expect((await f.request("/v1/events", f.event())).status).toBe(403);
  });

  it("completes only after provider-verified erasure and continues rejecting the old identity", async () => {
    const f = fixture();
    await f.request("/v1/events", f.event());
    f.sqlite.exec("UPDATE analytics_identities SET posthog_attempted = 1");
    await f.erase();
    f.sqlite.exec("UPDATE analytics_deletion_requests SET next_attempt_at = NULL");
    const uuid = "20000000-0000-4000-8000-000000000001";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ results: [{ uuid, distinct_ids: [installation] }] }))
      .mockResolvedValueOnce(
        Response.json({ persons_found: 1, events_queued_for_deletion: true, deletion_errors: [] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              person_uuid: uuid,
              created_at: new Date(Date.now() + 1000).toISOString(),
              status: "pending",
              delete_verified_at: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              person_uuid: uuid,
              created_at: new Date(Date.now() + 1000).toISOString(),
              status: "completed",
              delete_verified_at: new Date(Date.now() + 2000).toISOString(),
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const env = { ...f.env, POSTHOG_PROJECT_ID: "1", POSTHOG_PERSONAL_API_KEY: "synthetic" };
    expect(await flushPendingDeletions(env)).toBe(0);
    expect(
      f.sqlite
        .prepare("SELECT posthog_state, posthog_submitted_at FROM analytics_deletion_requests")
        .get(),
    ).toMatchObject({ posthog_state: "pending", posthog_submitted_at: expect.any(String) });
    f.sqlite.exec("UPDATE analytics_deletion_requests SET next_attempt_at = NULL");
    expect(await flushPendingDeletions(env)).toBe(0);
    f.sqlite.exec("UPDATE analytics_deletion_requests SET next_attempt_at = NULL");
    expect(await flushPendingDeletions(env)).toBe(1);
    expect(await (await f.erase()).json()).toMatchObject({ posthog_state: "completed" });
    expect((await f.request("/v1/events", f.event())).status).toBe(403);
    expect(await flushPendingDeletions(env)).toBe(0);
    expect(
      f.sqlite
        .prepare(
          "SELECT posthog_verified_at, posthog_last_error_class, completed_at FROM analytics_deletion_requests",
        )
        .get(),
    ).toMatchObject({
      posthog_verified_at: expect.any(String),
      posthog_last_error_class: null,
      completed_at: expect.any(String),
    });
  });

  it("uses actual instants for retention, with a shorter diagnostic lifetime", async () => {
    const f = fixture();
    const now = new Date("2026-08-31T12:00:00Z");
    const cutoff = new Date(now.valueOf() - 180 * 86400000).toISOString().slice(0, 10);
    const insert = f.sqlite.prepare(`INSERT INTO analytics_events
      (event_id, event_name, source, privacy_level, occurred_at, received_at, distinct_id, properties_json)
      VALUES (?, 'test', 'desktop', ?, ?, ?, 'retention-test', '{}')`);
    insert.run("keep", "essential", now.toISOString(), `${cutoff} 15:00:00`);
    insert.run("expire", "essential", now.toISOString(), `${cutoff} 09:00:00`);
    insert.run("diagnostic-old", "diagnostic", now.toISOString(), "2026-07-30 12:00:00");
    insert.run("diagnostic-new", "diagnostic", now.toISOString(), "2026-08-30 12:00:00");
    expect(await pruneExpiredAnalyticsEvents(f.database, now)).toBe(2);
    expect(
      f.sqlite
        .prepare("SELECT event_id FROM analytics_events ORDER BY event_id")
        .all()
        .map((row) => row.event_id),
    ).toEqual(["diagnostic-new", "keep"]);
  });
});

it("bounds unknown-length bodies while streaming", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(readBoundedJson(new Response(body), 100)).rejects.toThrow("body-too-large");
  expect(cancelled).toBe(true);
});
