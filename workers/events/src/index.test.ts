import { afterEach, describe, expect, it, vi } from "vitest";

import worker, {
  flushPendingEvents,
  flushPendingIdentityLinks,
  validateIdentityLinkPayload,
  validateIngestionPayload,
} from "./index";

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
  const batch = vi.fn().mockResolvedValue([]);
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
  options: { readonly enabled?: boolean; readonly rateLimitSuccess?: boolean } = {},
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

  it("rejects event names outside the registered contract", () => {
    const payload = validPayload();
    expect(() =>
      validateIngestionPayload({
        ...payload,
        events: [{ ...payload.events[0], name: "provider.secret.captured" }],
      }),
    ).toThrow("Unregistered event 'provider.secret.captured'");
  });

  it("rejects properties outside the event allowlist", () => {
    const payload = validPayload();
    expect(() =>
      validateIngestionPayload({
        ...payload,
        events: [
          {
            ...payload.events[0],
            properties: {
              ...payload.events[0].properties,
              prompt: "private research",
            },
          },
        ],
      }),
    ).toThrow("Unregistered property 'prompt' for event 'provider.turn.sent'");
  });

  it("rejects a declared privacy level that differs from the event contract", () => {
    const payload = validPayload();
    expect(() =>
      validateIngestionPayload({
        ...payload,
        events: [{ ...payload.events[0], privacy_level: "essential" }],
      }),
    ).toThrow("Event 'provider.turn.sent' requires privacy level 'product'");
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
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(503);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("requires an installation-owned token", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validPayload()),
        }),
      ),
      gatewayEnv(database.database),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(400);
    expect(database.batch).not.toHaveBeenCalled();
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
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("stores a valid desktop event before accepting it", async () => {
    const database = createDatabase();
    const waitUntil = vi.fn();
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
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(database.bind).toHaveBeenCalledWith(
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      "product",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
    expect(database.bind).toHaveBeenCalledWith(
      "8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
      "provider.turn.sent",
      "product",
      expect.any(String),
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      JSON.stringify({
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
    expect(waitUntil).toHaveBeenCalledOnce();
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
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(403);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("reports whether optional PostHog forwarding is configured", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(new Request("https://events.scientfactory.com/health")),
      gatewayEnv(database.database),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      posthog_forwarding: "pending_configuration",
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
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("links installation history to an authenticated account id", async () => {
    const database = createDatabase();
    const waitUntil = vi.fn();
    const accountId = "account:16ace444-e7c3-4b26-893f-98713188ae52";
    const installationId = "installation:8e0ee7d5-2c4b-48b6-8209-08f1e536f665";
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
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      linked: 1,
      canonical_id: accountId,
    });
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.bind).toHaveBeenCalledWith(accountId, installationId);
    expect(waitUntil).toHaveBeenCalledOnce();
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
            identity_ids: ["installation:8e0ee7d5-2c4b-48b6-8209-08f1e536f665"],
          }),
        }),
      ),
      {
        ANALYTICS_DB: database.database,
        IDENTITY_LINK_TOKEN: "secret",
      } as unknown as Cloudflare.Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
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

describe("PostHog forwarding", () => {
  it("forwards stored events without creating PostHog person profiles", async () => {
    const row = {
      event_id: "8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
      event_name: "provider.turn.sent",
      source: "desktop",
      privacy_level: "product",
      occurred_at: new Date().toISOString(),
      distinct_id: "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      canonical_id: "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      identity_type: "desktop_installation",
      session_id: "session:8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
      consent_level: "product",
      properties_json: JSON.stringify({ provider: "codex" }),
    };
    const run = vi.fn().mockResolvedValue({ success: true });
    const all = vi.fn().mockResolvedValue({ results: [row] });
    const bind = vi.fn(() => ({ run, all }));
    const prepare = vi.fn((_query: string) => ({ bind }));
    const batch = vi.fn().mockResolvedValue([]);
    const database = { prepare, batch } as unknown as D1Database;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const forwarded = await flushPendingEvents({
      ANALYTICS_DB: database,
      POSTHOG_PROJECT_TOKEN: "phc_scientfactory_test",
    });

    expect(forwarded).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://eu.i.posthog.com/batch");
    const payload = JSON.parse(String(request?.body)) as {
      api_key: string;
      batch: ReadonlyArray<{ properties: Record<string, unknown> }>;
    };
    expect(payload.api_key).toBe("phc_scientfactory_test");
    expect(payload.batch[0]?.properties).toMatchObject({
      provider: "codex",
      event_id: row.event_id,
      $insert_id: row.event_id,
      source: "desktop",
      privacy_level: "product",
      consent_level: "product",
      identity_type: "desktop_installation",
      $session_id: row.session_id,
      $process_person_profile: false,
    });
    expect(batch).toHaveBeenCalledOnce();
  });

  it("forwards anonymous-to-account identity events from the first-party link queue", async () => {
    const row = {
      link_id: "link-1",
      source_identity_id: "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      canonical_id: "account:8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
      linked_at: new Date().toISOString(),
    };
    const run = vi.fn().mockResolvedValue({ success: true });
    const all = vi.fn().mockResolvedValue({ results: [row] });
    const bind = vi.fn(() => ({ run, all }));
    const prepare = vi.fn((_query: string) => ({ bind }));
    const batch = vi.fn().mockResolvedValue([]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const forwarded = await flushPendingIdentityLinks({
      ANALYTICS_DB: { prepare, batch } as unknown as D1Database,
      POSTHOG_PROJECT_TOKEN: "phc_scientfactory_test",
    });

    expect(forwarded).toBe(1);
    expect(prepare.mock.calls[0]?.[0]).toContain(
      "identities.consent_level IN ('product', 'diagnostic', 'contribution')",
    );
    const [, request] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse(String(request?.body)) as {
      batch: ReadonlyArray<{
        event: string;
        distinct_id: string;
        properties: Record<string, unknown>;
      }>;
    };
    expect(payload.batch[0]).toMatchObject({
      event: "$identify",
      distinct_id: row.canonical_id,
      properties: {
        $anon_distinct_id: row.source_identity_id,
        $insert_id: row.link_id,
        $process_person_profile: true,
      },
    });
  });
});
