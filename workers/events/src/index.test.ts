import { afterEach, describe, expect, it, vi } from "vitest";

import worker, {
  flushPendingDeletions,
  validateIdentityLinkPayload,
  validateIngestionPayload,
} from "./index";
import { testDatabase } from "./sqlite.testSupport";

const realDatabases: ReturnType<typeof testDatabase>[] = [];
function realDatabase() {
  const database = testDatabase();
  realDatabases.push(database);
  return database;
}

const INSTALLATION_TOKEN = "a".repeat(64);

function validPayload() {
  return {
    schema_version: 1,
    source: "desktop",
    events: [
      {
        id: "8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
        name: "provider.turn.sent",
        distinct_id: "installation:16ace444-e7c3-4b26-893f-98713188ae52",
        session_id: "session:8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
        occurred_at: new Date().toISOString(),
        privacy_level: "product",
        consent_level: "product",
        properties: {
          appVersion: "0.0.32",
          buildChannel: "development",
          provider: "codex",
          modelFamily: "openai",
          modelKey: "gpt-5.6-sol",
          interactionMode: "default",
          runtimeMode: "full-access",
          attachmentCountBucket: "0",
          hasInput: true,
        },
      },
    ],
  };
}

function createDatabase(existingCanonicalId?: string) {
  const run = vi.fn().mockResolvedValue({ success: true });
  const all = vi.fn().mockResolvedValue({ results: [] });
  const first = existingCanonicalId
    ? vi.fn().mockResolvedValue({ canonical_id: existingCanonicalId })
    : vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ authenticated: 1 });
  const bind = vi.fn(() => ({ run, all, first }));
  const prepare = vi.fn(() => ({ bind }));
  // Like D1, one result per statement; the ingest batch ends with its ownership check.
  const batch = vi.fn(async (statements: ReadonlyArray<unknown>) =>
    statements.map((_, index) => ({
      results: index === statements.length - 1 ? [{ authenticated: 1 }] : [],
    })),
  );
  return {
    database: { prepare, batch } as unknown as D1Database,
    prepare,
    bind,
    batch,
    first,
  };
}

function gatewayEnv(
  database: D1Database,
  options: {
    readonly enabled?: boolean;
    readonly rateLimitSuccess?: boolean;
  } = {},
): Cloudflare.Env {
  return {
    ANALYTICS_DB: database,
    ANALYTICS_INGESTION_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: options.rateLimitSuccess ?? true }),
    },
    DESKTOP_INGESTION_ENABLED: options.enabled === false ? "false" : "true",
  } as unknown as Cloudflare.Env;
}

function incoming(request: Request): Request<unknown, IncomingRequestCfProperties> {
  return request as Request<unknown, IncomingRequestCfProperties>;
}

afterEach(() => {
  for (const database of realDatabases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("event gateway validation", () => {
  it("accepts a bounded desktop event batch", () => {
    expect(validateIngestionPayload(validPayload())).toHaveLength(1);
  });

  it("rejects an unsupported source", () => {
    expect(() => validateIngestionPayload({ ...validPayload(), source: "unknown" })).toThrow(
      "Unsupported event payload",
    );
  });

  it("rejects unsupported schema versions", () => {
    expect(() => validateIngestionPayload({ ...validPayload(), schema_version: 2 })).toThrow(
      "Unsupported event payload",
    );
  });

  it("accepts events and fields Scient has not listed, as T3 does", () => {
    const payload = validPayload();
    expect(
      validateIngestionPayload({
        ...payload,
        events: [
          {
            ...payload.events[0],
            name: "chatgpt.sign_in.completed",
            privacy_level: "essential",
            properties: {
              ...payload.events[0].properties,
              serviceTier: "fast",
              turns: 3,
            },
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it("rejects a malformed event name", () => {
    const payload = validPayload();
    expect(() =>
      validateIngestionPayload({
        ...payload,
        events: [{ ...payload.events[0], name: "Provider Secret" }],
      }),
    ).toThrow("Invalid event name");
  });

  it("rejects nested property values", () => {
    const payload = validPayload();
    expect(() =>
      validateIngestionPayload({
        ...payload,
        events: [
          {
            ...payload.events[0],
            properties: {
              ...payload.events[0].properties,
              usage: { prompt: "private research" },
            },
          },
        ],
      }),
    ).toThrow("Invalid event property 'usage'");
  });

  it("rejects an event when consent is below its required level", () => {
    const payload = validPayload();
    expect(() =>
      validateIngestionPayload({
        ...payload,
        events: [{ ...payload.events[0], consent_level: "essential" }],
      }),
    ).toThrow("Consent level 'essential' does not allow event 'provider.turn.sent'");
  });

  it("requires a session identifier for desktop events", () => {
    const payload = validPayload();
    const { session_id: _sessionId, ...event } = payload.events[0];
    expect(() => validateIngestionPayload({ ...payload, events: [event] })).toThrow(
      "Invalid session_id",
    );
  });

  it("rejects oversized batches", () => {
    const event = validPayload().events[0];
    expect(() =>
      validateIngestionPayload({
        ...validPayload(),
        events: Array.from({ length: 51 }, () => event),
      }),
    ).toThrow("At most 50 events are accepted");
  });

  it("rejects a desktop event that impersonates an account identity", () => {
    const payload = validPayload();
    expect(() =>
      validateIngestionPayload({
        ...payload,
        events: [
          {
            ...payload.events[0],
            distinct_id: "account:16ace444-e7c3-4b26-893f-98713188ae52",
          },
        ],
      }),
    ).toThrow("Desktop events require an installation identity");
  });
});

describe("event gateway routes", () => {
  it("stores Visual LaTeX views and outcomes with revision 6 and rejects document content before storage", async () => {
    const database = realDatabase();
    const base = validPayload().events[0]!;
    const common = {
      appVersion: "0.6.25",
      buildChannel: "stable",
      contractRevision: "6",
    };
    const events = [
      {
        ...base,
        id: "8e0ee7d5-2c4b-48b6-8209-08f1e536f660",
        name: "feature.viewed",
        properties: { ...common, feature: "latex-visual" },
      },
      {
        ...base,
        id: "8e0ee7d5-2c4b-48b6-8209-08f1e536f661",
        name: "scient.operation.completed",
        properties: {
          ...common,
          operationKind: "latex-visual-edit",
          trigger: "user",
          durationBucket: "under-1s",
        },
      },
      {
        ...base,
        id: "8e0ee7d5-2c4b-48b6-8209-08f1e536f662",
        name: "scient.operation.failed",
        privacy_level: "essential",
        consent_level: "essential",
        properties: {
          ...common,
          operationKind: "latex-visual-edit",
          failureClass: "unknown",
        },
      },
    ];
    const submit = (batch: unknown[]) =>
      worker.fetch!(
        incoming(
          new Request("https://events.scientfactory.com/v1/events", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Scient-Installation-Token": INSTALLATION_TOKEN,
            },
            body: JSON.stringify({ ...validPayload(), events: batch }),
          }),
        ),
        gatewayEnv(database.database),
      );
    const response = await submit(events);
    expect(await response.json()).toEqual({ accepted: 3 });
    expect(response.status).toBe(202);
    const stored = database.sqlite
      .prepare("SELECT event_name, properties_json FROM analytics_events ORDER BY event_id")
      .all();
    expect(
      stored.map((row) => ({
        name: row.event_name,
        properties: JSON.parse(String(row.properties_json)),
      })),
    ).toEqual(
      events.map((event) => ({
        name: event.name,
        properties: event.properties,
      })),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const [key, value, reason] of [
      ["path", "PRIVATE document", "property-content-key"],
      ["error", "PRIVATE document", "property-content-key"],
      ["text", "PRIVATE document", "property-content-key"],
      ["documentId", "/Users/someone/PRIVATE.tex", "property-private-value"],
      ["revision", "https://example.com/PRIVATE", "property-private-value"],
    ]) {
      const rejected = await submit([
        {
          ...events[0],
          properties: { ...events[0]!.properties, [key!]: value },
        },
      ]);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ reason, stage: "privacy" });
      const entry = String(log.mock.lastCall?.[0]);
      expect(JSON.parse(entry)).toMatchObject({
        reason,
        stage: "privacy",
        rejected_event_index: 0,
        app_version: "0.6.25",
        build_channel: "stable",
        contract_revision: "6",
      });
      expect(entry).not.toContain("PRIVATE");
      expect(entry).not.toContain("feature.viewed");
    }
    expect(database.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(3);
  });
  it("keeps desktop ingestion off until explicitly enabled", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validPayload()),
        }),
      ),
      gatewayEnv(database.database, { enabled: false }),
    );

    expect(response.status).toBe(503);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("requires an installation-owned token and logs why without identifiers or values", async () => {
    const database = createDatabase();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const payload = validPayload();
    // Nothing is authenticated yet, so no event name is logged, even one of a valid shape.
    const named = {
      ...payload,
      events: [...payload.events, { ...payload.events[0], name: "patient.192.0.2.10" }],
    };
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(named),
        }),
      ),
      gatewayEnv(database.database),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid installation token",
      reason: "installation-token-missing",
      stage: "headers",
    });
    expect(database.batch).not.toHaveBeenCalled();
    const entry = String(log.mock.lastCall?.[0]);
    expect(JSON.parse(entry)).toMatchObject({
      status: 400,
      error_class: "validation",
      reason: "installation-token-missing",
      stage: "headers",
      schema_version: 1,
      source: "desktop",
      batch_size: 2,
      app_version: "0.0.32",
      build_channel: "development",
    });
    for (const secret of [
      "installation:",
      "session:",
      "8e0ee7d5",
      "codex",
      "gpt-5.6",
      "192.0.2",
      "provider.turn.sent",
    ]) {
      expect(entry).not.toContain(secret);
    }
  });

  it("names the failed storage step without logging the error message", async () => {
    const database = createDatabase();
    database.batch.mockRejectedValueOnce(new Error("D1_ERROR: Network connection lost."));
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Scient-Installation-Token": INSTALLATION_TOKEN,
          },
          body: JSON.stringify(validPayload()),
        }),
      ),
      gatewayEnv(database.database),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Analytics ingestion failed",
    });
    const entry = String(failure.mock.lastCall?.[0]);
    expect(JSON.parse(entry)).toEqual({
      message: "Analytics ingestion failed",
      failed_step: "storage",
      error_class: "internal",
      error_name: "Error",
      error_kind: "network-lost",
    });
  });

  it("acknowledges deletion when the installation has never uploaded data", async () => {
    const database = realDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/installations/delete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Scient-Installation-Token": INSTALLATION_TOKEN,
          },
          body: JSON.stringify({
            schema_version: 1,
            installation_id: "installation:16ace444-e7c3-4b26-893f-98713188ae52",
          }),
        }),
      ),
      gatewayEnv(database.database),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      local_state: "deleted",
      posthog_state: "completed",
      request_id: expect.any(String),
    });
    expect(
      database.sqlite.prepare("SELECT count(*) AS n FROM analytics_deleted_installations").get()!.n,
    ).toBe(1);
  });

  it("rate limits one validated installation without storing its IP address", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Scient-Installation-Token": INSTALLATION_TOKEN,
          },
          body: JSON.stringify(validPayload()),
        }),
      ),
      gatewayEnv(database.database, { rateLimitSuccess: false }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("stores a valid desktop event before accepting it", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Scient-Installation-Token": INSTALLATION_TOKEN,
          },
          body: JSON.stringify(validPayload()),
        }),
      ),
      gatewayEnv(database.database),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
    // One D1 round trip: identity upsert, event insert and the ownership check.
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(database.first).not.toHaveBeenCalled();
    expect(database.bind).toHaveBeenCalledWith(
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      "product",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
    );
    expect(database.bind).toHaveBeenCalledWith(
      "8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
      "provider.turn.sent",
      "product",
      expect.any(String),
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      JSON.stringify({
        appVersion: "0.0.32",
        buildChannel: "development",
        provider: "codex",
        modelFamily: "openai",
        modelKey: "gpt-5.6-sol",
        interactionMode: "default",
        runtimeMode: "full-access",
        attachmentCountBucket: "0",
        hasInput: true,
      }),
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      "session:8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
      "product",
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      expect.any(String),
    );
    // Export runs from the cron, not after every ingest.
  });

  it("rejects browser submissions from unknown origins", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://attacker.example",
          },
          body: JSON.stringify(validPayload()),
        }),
      ),
      gatewayEnv(database.database),
    );

    expect(response.status).toBe(403);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("reports storage readiness and which optional services are configured", async () => {
    const database = realDatabase();
    const response = await worker.fetch!(
      incoming(new Request("https://events.scientfactory.com/health")),
      gatewayEnv(database.database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      contract_revision: "11",
      worker_version: "unavailable",
      worker_version_tag: null,
      worker_version_created_at: null,
      storage: "ready",
      retention: "pending_verification",
      activation_prerequisites_configured: false,
      posthog_deletion: "pending_configuration",
      identity_linking: "pending_configuration",
    });
  });

  it("requires service authentication before linking account identity", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/identity/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schema_version: 1,
            account_id: "account:16ace444-e7c3-4b26-893f-98713188ae52",
            identity_ids: ["installation:8e0ee7d5-2c4b-48b6-8209-08f1e536f665"],
          }),
        }),
      ),
      {
        ANALYTICS_DB: database.database,
        IDENTITY_LINK_TOKEN: "secret",
      } as unknown as Cloudflare.Env,
    );

    expect(response.status).toBe(401);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("links consented visitor history to an authenticated account id", async () => {
    const database = createDatabase();
    const accountId = "account:16ace444-e7c3-4b26-893f-98713188ae52";
    const installationId = "visitor:8e0ee7d5-2c4b-48b6-8209-08f1e536f665";
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/identity/link", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer secret",
          },
          body: JSON.stringify({
            schema_version: 1,
            account_id: accountId,
            identity_ids: [installationId],
          }),
        }),
      ),
      {
        ANALYTICS_DB: database.database,
        IDENTITY_LINK_TOKEN: "secret",
      } as unknown as Cloudflare.Env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      linked: 1,
      canonical_id: accountId,
    });
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.bind).toHaveBeenCalledWith(accountId, installationId);
  });

  it("refuses to reassign an identity to a different account", async () => {
    const database = createDatabase("account:11111111-1111-4111-8111-111111111111");
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/identity/link", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer secret",
          },
          body: JSON.stringify({
            schema_version: 1,
            account_id: "account:22222222-2222-4222-8222-222222222222",
            identity_ids: ["visitor:8e0ee7d5-2c4b-48b6-8209-08f1e536f665"],
          }),
        }),
      ),
      {
        ANALYTICS_DB: database.database,
        IDENTITY_LINK_TOKEN: "secret",
      } as unknown as Cloudflare.Env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Source identity is already linked to another account",
    });
    expect(database.batch).not.toHaveBeenCalled();
  });
});

describe("identity link validation", () => {
  it("accepts visitor and installation ids only", () => {
    expect(
      validateIdentityLinkPayload({
        schema_version: 1,
        account_id: "account:16ace444-e7c3-4b26-893f-98713188ae52",
        identity_ids: [
          "visitor:8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
          "installation:f48176b0-03e0-4f2b-8f4b-e1c9ebf4fb7e",
        ],
      }).identityIds,
    ).toHaveLength(2);
  });
});

describe("PostHog erasure", () => {
  it("resolves the person before submitting an erasure and keeps it pending verification", async () => {
    const row = {
      request_id: "delete-1",
      posthog_distinct_id: "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      posthog_attempts: 0,
    };
    const { database, sqlite } = realDatabase();
    sqlite
      .prepare(
        `INSERT INTO analytics_deletion_requests
      (request_id, installation_id, posthog_distinct_id, requested_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        row.request_id,
        row.posthog_distinct_id,
        row.posthog_distinct_id,
        new Date().toISOString(),
      );
    const personUuid = "11111111-1111-4111-8111-111111111111";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          results: [{ uuid: personUuid, distinct_ids: [row.posthog_distinct_id] }],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            persons_found: 1,
            persons_deleted: 1,
            events_queued_for_deletion: true,
            recordings_queued_for_deletion: false,
            deletion_errors: [],
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const submitted = await flushPendingDeletions({
      ANALYTICS_DB: database,
      POSTHOG_PERSONAL_API_KEY: "phx_person_write_test",
      POSTHOG_PROJECT_ID: "228610",
    });

    expect(submitted).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, request] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("https://eu.posthog.com/api/projects/228610/persons/bulk_delete/");
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer phx_person_write_test");
    expect(JSON.parse(String(request?.body))).toEqual({
      ids: [personUuid],
      delete_events: true,
      delete_recordings: false,
      keep_person: false,
    });
    expect(
      sqlite
        .prepare("SELECT posthog_state, posthog_submitted_at FROM analytics_deletion_requests")
        .get(),
    ).toMatchObject({
      posthog_state: "pending",
      posthog_submitted_at: expect.any(String),
    });
  });
});
