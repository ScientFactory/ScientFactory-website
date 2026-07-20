const ALLOWED_WEB_ORIGINS = new Set(["https://scientfactory.com", "https://www.scientfactory.com"]);
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTALLATION_ID_PATTERN = /^installation:[0-9a-f-]{36}$/i;
const VISITOR_ID_PATTERN = /^visitor:[0-9a-f-]{36}$/i;
const ACCOUNT_ID_PATTERN = /^account:[0-9a-f-]{36}$/i;
const SESSION_ID_PATTERN = /^session:[0-9a-f-]{36}$/i;
const PRIVACY_LEVELS = new Set(["essential", "product", "diagnostic", "contribution"]);
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_BATCH_SIZE = 50;
const MAX_PROPERTIES_BYTES = 16 * 1024;
const POSTHOG_BATCH_SIZE = 100;
const POSTHOG_HOST = "https://eu.i.posthog.com";

type AnalyticsEnv = AnalyticsWorkerBindings & {
  readonly POSTHOG_PROJECT_TOKEN?: string;
  readonly IDENTITY_LINK_TOKEN?: string;
};

interface AcceptedEvent {
  readonly id: string;
  readonly name: string;
  readonly distinctId: string;
  readonly identityType: "desktop_installation";
  readonly sessionId: string | null;
  readonly occurredAt: string;
  readonly privacyLevel: string;
  readonly consentLevel: string;
  readonly properties: Record<string, unknown>;
}

interface PendingEventRow {
  readonly event_id: string;
  readonly event_name: string;
  readonly source: string;
  readonly privacy_level: string;
  readonly occurred_at: string;
  readonly distinct_id: string;
  readonly canonical_id: string;
  readonly identity_type: string;
  readonly session_id: string | null;
  readonly consent_level: string;
  readonly properties_json: string;
}

interface PendingIdentityLinkRow {
  readonly link_id: string;
  readonly source_identity_id: string;
  readonly canonical_id: string;
  readonly linked_at: string;
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

  const distinctId = requireString(value.distinct_id, "distinct_id", IDENTIFIER_PATTERN);
  if (!INSTALLATION_ID_PATTERN.test(distinctId)) {
    throw new RequestValidationError("Desktop events require an installation identity");
  }
  const sessionId =
    value.session_id === undefined || value.session_id === null
      ? null
      : requireString(value.session_id, "session_id", SESSION_ID_PATTERN);
  const consentLevel =
    value.consent_level === undefined
      ? privacyLevel
      : requireString(value.consent_level, "consent_level", /^[a-z]+$/);
  if (!PRIVACY_LEVELS.has(consentLevel)) {
    throw new RequestValidationError("Invalid consent_level");
  }

  return {
    id: requireString(value.id, "event id", IDENTIFIER_PATTERN),
    name: requireString(value.name, "event name", EVENT_NAME_PATTERN),
    distinctId,
    identityType: "desktop_installation",
    sessionId,
    occurredAt: occurredAtDate.toISOString(),
    privacyLevel,
    consentLevel,
    properties,
  };
}

export function validateIngestionPayload(value: unknown): ReadonlyArray<AcceptedEvent> {
  if (
    !isRecord(value) ||
    (value.schema_version !== 1 && value.schema_version !== 2) ||
    value.source !== "desktop"
  ) {
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
  const upsertIdentity = `
    INSERT INTO analytics_identities (
      identity_id,
      identity_type,
      canonical_id,
      consent_level,
      first_seen_at,
      last_seen_at
    ) VALUES (?, 'desktop_installation', ?, ?, ?, ?)
    ON CONFLICT(identity_id) DO UPDATE SET
      consent_level = excluded.consent_level,
      last_seen_at = excluded.last_seen_at
  `;
  const insert = `
    INSERT OR IGNORE INTO analytics_events (
      event_id,
      event_name,
      source,
      privacy_level,
      occurred_at,
      distinct_id,
      properties_json,
      identity_type,
      canonical_id,
      session_id,
      consent_level
    ) VALUES (
      ?, ?, 'desktop', ?, ?, ?, ?, 'desktop_installation',
      COALESCE((SELECT canonical_id FROM analytics_identities WHERE identity_id = ?), ?),
      ?, ?
    )
  `;
  await database.batch(
    events.flatMap((event) => [
      database
        .prepare(upsertIdentity)
        .bind(
          event.distinctId,
          event.distinctId,
          event.consentLevel,
          event.occurredAt,
          event.occurredAt,
        ),
      database
        .prepare(insert)
        .bind(
          event.id,
          event.name,
          event.privacyLevel,
          event.occurredAt,
          event.distinctId,
          JSON.stringify(event.properties),
          event.distinctId,
          event.distinctId,
          event.sessionId,
          event.consentLevel,
        ),
    ]),
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
    distinct_id: row.canonical_id,
    timestamp: row.occurred_at,
    properties: {
      ...properties,
      event_id: row.event_id,
      source: row.source,
      privacy_level: row.privacy_level,
      consent_level: row.consent_level,
      identity_type: row.identity_type,
      ...(row.session_id ? { $session_id: row.session_id } : {}),
      $process_person_profile: row.canonical_id.startsWith("account:"),
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
       canonical_id,
       identity_type,
       session_id,
       consent_level,
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

function identityIdentifyEvent(row: PendingIdentityLinkRow): Record<string, unknown> {
  return {
    event: "$identify",
    distinct_id: row.canonical_id,
    timestamp: row.linked_at,
    properties: {
      $anon_distinct_id: row.source_identity_id,
      link_id: row.link_id,
      source: "identity_gateway",
      $process_person_profile: true,
    },
  };
}

export async function flushPendingIdentityLinks(env: AnalyticsEnv): Promise<number> {
  if (!env.POSTHOG_PROJECT_TOKEN) return 0;
  const result = await env.ANALYTICS_DB.prepare(
    `SELECT links.link_id, links.source_identity_id, links.canonical_id, links.linked_at
       FROM analytics_identity_links AS links
       JOIN analytics_identities AS identities
         ON identities.identity_id = links.source_identity_id
      WHERE links.posthog_state = 'pending'
        AND identities.consent_level IN ('product', 'diagnostic', 'contribution')
      ORDER BY links.linked_at, links.link_id
      LIMIT ?`,
  )
    .bind(POSTHOG_BATCH_SIZE)
    .all<PendingIdentityLinkRow>();
  const rows = result.results;
  if (rows.length === 0) return 0;

  let response: Response;
  try {
    response = await fetch(`${POSTHOG_HOST}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_PROJECT_TOKEN,
        batch: rows.map(identityIdentifyEvent),
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.ANALYTICS_DB.batch(
      rows.map((row) =>
        env.ANALYTICS_DB.prepare(
          `UPDATE analytics_identity_links
              SET posthog_attempts = posthog_attempts + 1,
                  posthog_last_error = ?
            WHERE link_id = ? AND posthog_state = 'pending'`,
        ).bind(message.slice(0, 500), row.link_id),
      ),
    );
    throw error;
  }

  if (!response.ok) {
    const message = `PostHog returned ${response.status}`;
    await env.ANALYTICS_DB.batch(
      rows.map((row) =>
        env.ANALYTICS_DB.prepare(
          `UPDATE analytics_identity_links
              SET posthog_attempts = posthog_attempts + 1,
                  posthog_last_error = ?
            WHERE link_id = ? AND posthog_state = 'pending'`,
        ).bind(message, row.link_id),
      ),
    );
    throw new Error(message);
  }

  await env.ANALYTICS_DB.batch(
    rows.map((row) =>
      env.ANALYTICS_DB.prepare(
        `UPDATE analytics_identity_links
            SET posthog_state = 'sent',
                posthog_attempts = posthog_attempts + 1,
                posthog_last_error = NULL,
                posthog_sent_at = CURRENT_TIMESTAMP
          WHERE link_id = ? AND posthog_state = 'pending'`,
      ).bind(row.link_id),
    ),
  );
  return rows.length;
}

function identityType(identityId: string): "web_visitor" | "desktop_installation" {
  if (VISITOR_ID_PATTERN.test(identityId)) return "web_visitor";
  if (INSTALLATION_ID_PATTERN.test(identityId)) return "desktop_installation";
  throw new RequestValidationError("Invalid source identity");
}

export function validateIdentityLinkPayload(value: unknown): {
  readonly accountId: string;
  readonly identityIds: ReadonlyArray<string>;
} {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new RequestValidationError("Unsupported identity link payload");
  }
  const accountId = requireString(value.account_id, "account_id", ACCOUNT_ID_PATTERN);
  if (!Array.isArray(value.identity_ids) || value.identity_ids.length < 1) {
    throw new RequestValidationError("At least one source identity is required");
  }
  if (value.identity_ids.length > 20) {
    throw new RequestValidationError("At most 20 source identities are accepted");
  }
  const identityIds = [
    ...new Set(
      value.identity_ids.map((id) => requireString(id, "identity_id", IDENTIFIER_PATTERN)),
    ),
  ];
  for (const identityId of identityIds) identityType(identityId);
  return { accountId, identityIds };
}

async function persistIdentityLinks(
  database: D1Database,
  accountId: string,
  identityIds: ReadonlyArray<string>,
): Promise<void> {
  for (const identityId of identityIds) {
    const existing = await database
      .prepare(
        `SELECT canonical_id
           FROM analytics_identity_links
          WHERE source_identity_id = ?`,
      )
      .bind(identityId)
      .first<{ readonly canonical_id: string }>();
    if (existing && existing.canonical_id !== accountId) {
      throw new RequestValidationError("Source identity is already linked to another account");
    }
  }

  const linkedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO analytics_identities (
           identity_id, identity_type, canonical_id, consent_level, first_seen_at, last_seen_at
         ) VALUES (?, 'account', ?, 'essential', ?, ?)
         ON CONFLICT(identity_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .bind(accountId, accountId, linkedAt, linkedAt),
  ];

  for (const identityId of identityIds) {
    const type = identityType(identityId);
    statements.push(
      database
        .prepare(
          `INSERT INTO analytics_identities (
             identity_id, identity_type, canonical_id, consent_level, first_seen_at, last_seen_at, linked_at
           ) VALUES (?, ?, ?, 'essential', ?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET
             canonical_id = excluded.canonical_id,
             last_seen_at = excluded.last_seen_at,
             linked_at = excluded.linked_at`,
        )
        .bind(identityId, type, accountId, linkedAt, linkedAt, linkedAt),
      database
        .prepare(
          `INSERT INTO analytics_identity_links (
             link_id, source_identity_id, canonical_id, linked_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(source_identity_id) DO UPDATE SET
             canonical_id = excluded.canonical_id,
             linked_at = excluded.linked_at,
             posthog_state = CASE
               WHEN analytics_identity_links.canonical_id = excluded.canonical_id
                 THEN analytics_identity_links.posthog_state
               ELSE 'pending'
             END`,
        )
        .bind(crypto.randomUUID(), identityId, accountId, linkedAt),
      database
        .prepare(
          `UPDATE analytics_events
              SET canonical_id = ?
            WHERE distinct_id = ?`,
        )
        .bind(accountId, identityId),
    );
  }
  await database.batch(statements);
}

async function handleIdentityLink(
  request: Request,
  env: AnalyticsEnv,
  context: ExecutionContext,
): Promise<Response> {
  if (!env.IDENTITY_LINK_TOKEN) {
    return jsonResponse({ error: "Identity linking is not configured" }, 503);
  }
  if (request.headers.get("Authorization") !== `Bearer ${env.IDENTITY_LINK_TOKEN}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415);
  }
  try {
    const link = validateIdentityLinkPayload(await readJsonBody(request));
    await persistIdentityLinks(env.ANALYTICS_DB, link.accountId, link.identityIds);
    context.waitUntil(
      flushPendingIdentityLinks(env).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "PostHog identity linking failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
    return jsonResponse({ linked: link.identityIds.length, canonical_id: link.accountId }, 200);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return jsonResponse({ error: error.message }, 400);
    }
    console.error(
      JSON.stringify({
        message: "Identity linking failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse({ error: "Identity linking failed" }, 500);
  }
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
        identity_linking: env.IDENTITY_LINK_TOKEN ? "configured" : "pending_configuration",
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
    if (request.method === "POST" && url.pathname === "/v1/identity/link") {
      return handleIdentityLink(request, env, context);
    }
    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(
      flushPendingIdentityLinks(env)
        .then(() => flushPendingEvents(env))
        .catch((error: unknown) => {
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
