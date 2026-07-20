import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { flushPendingEvents, validateIngestionPayload } from "./index";

function validPayload() {
  return {
    schema_version: 1,
    source: "desktop",
    events: [
      {
        id: "8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
        name: "provider.turn.sent",
        distinct_id: "installation:16ace444-e7c3-4b26-893f-98713188ae52",
        occurred_at: new Date().toISOString(),
        privacy_level: "product",
        properties: { provider: "codex", clientType: "desktop-app" },
      },
    ],
  };
}

function createDatabase() {
  const run = vi.fn().mockResolvedValue({ success: true });
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn(() => ({ run, all }));
  const prepare = vi.fn(() => ({ bind }));
  const batch = vi.fn().mockResolvedValue([]);
  return { database: { prepare, batch } as unknown as D1Database, prepare, bind, batch };
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

  it("rejects oversized batches", () => {
    const event = validPayload().events[0];
    expect(() =>
      validateIngestionPayload({
        ...validPayload(),
        events: Array.from({ length: 51 }, () => event),
      }),
    ).toThrow("At most 50 events are accepted");
  });
});

describe("event gateway routes", () => {
  it("stores a valid desktop event before accepting it", async () => {
    const database = createDatabase();
    const waitUntil = vi.fn();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validPayload()),
        }),
      ),
      { ANALYTICS_DB: database.database } as Cloudflare.Env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.bind).toHaveBeenCalledWith(
      "8e0ee7d5-2c4b-48b6-8209-08f1e536f665",
      "provider.turn.sent",
      "product",
      expect.any(String),
      "installation:16ace444-e7c3-4b26-893f-98713188ae52",
      JSON.stringify({ provider: "codex", clientType: "desktop-app" }),
    );
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("rejects browser submissions from unknown origins", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(
        new Request("https://events.scientfactory.com/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
          body: JSON.stringify(validPayload()),
        }),
      ),
      { ANALYTICS_DB: database.database } as Cloudflare.Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(403);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it("reports whether optional PostHog forwarding is configured", async () => {
    const database = createDatabase();
    const response = await worker.fetch!(
      incoming(new Request("https://events.scientfactory.com/health")),
      { ANALYTICS_DB: database.database } as Cloudflare.Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      posthog_forwarding: "pending_configuration",
    });
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
      properties_json: JSON.stringify({ provider: "codex" }),
    };
    const run = vi.fn().mockResolvedValue({ success: true });
    const all = vi.fn().mockResolvedValue({ results: [row] });
    const bind = vi.fn(() => ({ run, all }));
    const prepare = vi.fn(() => ({ bind }));
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
      source: "desktop",
      privacy_level: "product",
      $process_person_profile: false,
    });
    expect(batch).toHaveBeenCalledOnce();
  });
});
