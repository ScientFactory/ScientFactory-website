const ALLOWED_WEB_ORIGINS = new Set(["https://scientfactory.com", "https://www.scientfactory.com"]);
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRIVACY_LEVELS = new Set(["essential", "product", "diagnostic", "contribution"]);
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_BATCH_SIZE = 50;
const MAX_PROPERTIES_BYTES = 16 * 1024;
const POSTHOG_BATCH_SIZE = 100;
const POSTHOG_HOST = "https://eu.i.posthog.com";

type AnalyticsEnv = AnalyticsWorkerBindings & {
  readonly POSTHOG_PROJECT_TOKEN?: string;
};

interface AcceptedEvent {
  readonly id: string;
  readonly name: string;
  readonly distinctId: string;
  readonly occurredAt: string;
  readonly privacyLevel: string;
  readonly properties: Record<string, unknown>;
}

interface PendingEventRow {
  readonly event_id: string;
  readonly event_name: string;
  readonly source: string;
  readonly privacy_level: string;
  readonly occurred_at: string;
  readonly distinct_id: string;
  readonly properties_json: string;
}

class RequestValidationError extends Error {}

function jsonResponse(body: unknown, status = 200, origin?: string | null): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (origin && ALLOWED_WEB_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RequestValidationError(`Invalid ${field}`);
  }
  return value;
}

function parseEvent(value: unknown): AcceptedEvent {
  if (!isRecord(value)) throw new RequestValidationError("Each event must be an object");

  const properties = value.properties;
  if (!isRecord(properties)) throw new RequestValidationError("Invalid event properties");
  if (Object.keys(properties).length > 64) {
    throw new RequestValidationError("Too many event properties");
  }
  if (new TextEncoder().encode(JSON.stringify(properties)).byteLength > MAX_PROPERTIES_BYTES) {
    throw new RequestValidationError("Event properties are too large");
  }

  const privacyLevel = requireString(value.privacy_level, "privacy_level", /^[a-z]+$/);
  if (!PRIVACY_LEVELS.has(privacyLevel)) {
    throw new RequestValidationError("Invalid privacy_level");
  }

  const occurredAtInput = requireString(value.occurred_at, "occurred_at", /^.{10,40}$/);
  const occurredAtDate = new Date(occurredAtInput);
  if (Number.isNaN(occurredAtDate.valueOf())) {
    throw new RequestValidationError("Invalid occurred_at");
  }
  const now = Date.now();
  if (occurredAtDate.valueOf() > now + 24 * 60 * 60 * 1000) {
    throw new RequestValidationError("occurred_at is too far in the future");
  }
  if (occurredAtDate.valueOf() < now - 180 * 24 * 60 * 60 * 1000) {
    throw new RequestValidationError("occurred_at is too old");
  }

  return {
    id: requireString(value.id, "event id", IDENTIFIER_PATTERN),
    name: requireString(value.name, "event name", EVENT_NAME_PATTERN),
    distinctId: requireString(value.distinct_id, "distinct_id", IDENTIFIER_PATTERN),
    occurredAt: occurredAtDate.toISOString(),
    privacyLevel,
    properties,
  };
}

export function validateIngestionPayload(value: unknown): ReadonlyArray<AcceptedEvent> {
  if (!isRecord(value) || value.schema_version !== 1 || value.source !== "desktop") {
    throw new RequestValidationError("Unsupported event payload");
  }
  if (!Array.isArray(value.events) || value.events.length < 1) {
    throw new RequestValidationError("At least one event is required");
  }
  if (value.events.length > MAX_BATCH_SIZE) {
    throw new RequestValidationError(`At most ${MAX_BATCH_SIZE} events are accepted`);
  }
  return value.events.map(parseEvent);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new RequestValidationError("Request body is too large");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new RequestValidationError("Request body is too large");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RequestValidationError("Request body must be valid JSON");
  }
}

async function persistEvents(
  database: D1Database,
  events: ReadonlyArray<AcceptedEvent>,
): Promise<void> {
  const insert = `
    INSERT OR IGNORE INTO analytics_events (
      event_id,
      event_name,
      source,
      privacy_level,
      occurred_at,
      distinct_id,
      properties_json
    ) VALUES (?, ?, 'desktop', ?, ?, ?, ?)
  `;
  await database.batch(
    events.map((event) =>
      database
        .prepare(insert)
        .bind(
          event.id,
          event.name,
          event.privacyLevel,
          event.occurredAt,
          event.distinctId,
          JSON.stringify(event.properties),
        ),
    ),
  );
}

function posthogEvent(row: PendingEventRow): Record<string, unknown> {
  let properties: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties_json) as unknown;
    if (isRecord(parsed)) properties = parsed;
  } catch {
    // The gateway writes valid JSON; retaining an empty object makes a malformed legacy row retryable.
  }
  return {
    event: row.event_name,
    distinct_id: row.distinct_id,
    timestamp: row.occurred_at,
    properties: {
      ...properties,
      event_id: row.event_id,
      source: row.source,
      privacy_level: row.privacy_level,
      $process_person_profile: false,
    },
  };
}

async function markPosthogFailure(
  database: D1Database,
  rows: ReadonlyArray<PendingEventRow>,
  error: string,
): Promise<void> {
  if (rows.length === 0) return;
  await database.batch(
    rows.map((row) =>
      database
        .prepare(
          `UPDATE analytics_events
             SET posthog_attempts = posthog_attempts + 1,
                 posthog_last_error = ?
           WHERE event_id = ? AND posthog_state = 'pending'`,
        )
        .bind(error.slice(0, 500), row.event_id),
    ),
  );
}

export async function flushPendingEvents(env: AnalyticsEnv): Promise<number> {
  if (!env.POSTHOG_PROJECT_TOKEN) return 0;

  const result = await env.ANALYTICS_DB.prepare(
    `SELECT
       event_id,
       event_name,
       source,
       privacy_level,
       occurred_at,
       distinct_id,
       properties_json
     FROM analytics_events
     WHERE posthog_state = 'pending'
     ORDER BY received_at, event_id
     LIMIT ?`,
  )
    .bind(POSTHOG_BATCH_SIZE)
    .all<PendingEventRow>();
  const rows = result.results;
  if (rows.length === 0) return 0;

  let response: Response;
  try {
    response = await fetch(`${POSTHOG_HOST}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_PROJECT_TOKEN,
        batch: rows.map(posthogEvent),
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markPosthogFailure(env.ANALYTICS_DB, rows, message);
    throw error;
  }

  if (!response.ok) {
    const message = `PostHog returned ${response.status}`;
    await markPosthogFailure(env.ANALYTICS_DB, rows, message);
    throw new Error(message);
  }

  await env.ANALYTICS_DB.batch(
    rows.map((row) =>
      env.ANALYTICS_DB.prepare(
        `UPDATE analytics_events
           SET posthog_state = 'sent',
               posthog_attempts = posthog_attempts + 1,
               posthog_last_error = NULL,
               posthog_sent_at = CURRENT_TIMESTAMP
         WHERE event_id = ? AND posthog_state = 'pending'`,
      ).bind(row.event_id),
    ),
  );
  return rows.length;
}

async function handleIngestion(
  request: Request,
  env: AnalyticsEnv,
  context: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_WEB_ORIGINS.has(origin)) {
    return jsonResponse({ error: "Origin is not allowed" }, 403);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415, origin);
  }

  try {
    const events = validateIngestionPayload(await readJsonBody(request));
    await persistEvents(env.ANALYTICS_DB, events);
    context.waitUntil(
      flushPendingEvents(env).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "PostHog forwarding failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
    return jsonResponse({ accepted: events.length }, 202, origin);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return jsonResponse({ error: error.message }, 400, origin);
    }
    console.error(
      JSON.stringify({
        message: "Analytics ingestion failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse({ error: "Analytics ingestion failed" }, 500, origin);
  }
}

const worker: ExportedHandler<AnalyticsEnv> = {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        status: "ready",
        storage: "configured",
        posthog_forwarding: env.POSTHOG_PROJECT_TOKEN ? "configured" : "pending_configuration",
      });
    }
    if (request.method === "OPTIONS" && url.pathname === "/v1/events") {
      const origin = request.headers.get("Origin");
      if (!origin || !ALLOWED_WEB_ORIGINS.has(origin)) {
        return jsonResponse({ error: "Origin is not allowed" }, 403);
      }
      const response = new Response(null, { status: 204 });
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Access-Control-Allow-Headers", "Content-Type");
      response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.headers.set("Access-Control-Max-Age", "86400");
      response.headers.set("Vary", "Origin");
      return response;
    }
    if (request.method === "POST" && url.pathname === "/v1/events") {
      return handleIngestion(request, env, context);
    }
    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(
      flushPendingEvents(env).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "Scheduled PostHog forwarding failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  },
};

export default worker;
