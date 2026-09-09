import {
  ANALYTICS_CONTRACT_REVISION,
  eventContractViolation,
  PRIVACY_LEVELS,
  type PrivacyLevel,
} from "./eventContract";
import { posthogEventUuid, posthogRequest, readBoundedJson, TransportFailure } from "./transport";
import { withExportLease } from "./exportLease";

const ALLOWED_WEB_ORIGINS = new Set(["https://scientfactory.com", "https://www.scientfactory.com"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTALLATION_ID_PATTERN = /^installation:[0-9a-f-]{36}$/i;
const VISITOR_ID_PATTERN = /^visitor:[0-9a-f-]{36}$/i;
const ACCOUNT_ID_PATTERN = /^account:[0-9a-f-]{36}$/i;
const SESSION_ID_PATTERN = /^session:[0-9a-f-]{36}$/i;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_BATCH_SIZE = 50;
const MAX_PROPERTIES_BYTES = 16 * 1024;
const POSTHOG_BATCH_SIZE = 100;
const POSTHOG_HOST = "https://eu.i.posthog.com";
const POSTHOG_API_HOST = "https://eu.posthog.com";
const POSTHOG_DELETION_BATCH_SIZE = 1;
const POSTHOG_DELETION_MAX_ATTEMPTS = 10;
const INSTALLATION_TOKEN_HEADER = "X-Scient-Installation-Token";
const INSTALLATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const RAW_EVENT_RETENTION_DAYS = 180;
const DIAGNOSTIC_EVENT_RETENTION_DAYS = 30;
const RETENTION_BATCH_SIZE = 5_000;

type AnalyticsEnv = Omit<
  AnalyticsWorkerBindings,
  | "ANALYTICS_INGESTION_RATE_LIMITER"
  | "CF_VERSION_METADATA"
  | "DESKTOP_INGESTION_ENABLED"
  | "DESKTOP_POSTHOG_EXPORT_ENABLED"
  | "POSTHOG_PERSONAL_API_KEY"
  | "POSTHOG_PROJECT_ID"
  | "POSTHOG_PROJECT_TOKEN"
> & {
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
  readonly POSTHOG_PROJECT_TOKEN?: string;
  readonly POSTHOG_PERSONAL_API_KEY?: string;
  readonly POSTHOG_PROJECT_ID?: string;
  readonly IDENTITY_LINK_TOKEN?: string;
  readonly DESKTOP_INGESTION_ENABLED?: string;
  readonly DESKTOP_POSTHOG_EXPORT_ENABLED?: string;
  readonly ANALYTICS_INGESTION_RATE_LIMITER?: RateLimit;
};

interface AcceptedEvent {
  readonly id: string;
  readonly name: string;
  readonly distinctId: string;
  readonly identityType: "desktop_installation";
  readonly sessionId: string | null;
  readonly occurredAt: string;
  readonly privacyLevel: PrivacyLevel;
  readonly consentLevel: PrivacyLevel;
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
  readonly product_first_seen_at?: string | null;
}

interface PendingIdentityLinkRow {
  readonly link_id: string;
  readonly source_identity_id: string;
  readonly canonical_id: string;
  readonly linked_at: string;
}

interface PendingDeletionRow {
  readonly request_id: string;
  readonly posthog_distinct_id: string;
  readonly posthog_attempts: number;
  readonly requested_at: string;
  readonly posthog_person_uuid: string | null;
  readonly posthog_submitted_at: string | null;
}

class RequestValidationError extends Error {}
class InstallationAuthenticationError extends Error {}

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
  if (!PRIVACY_LEVELS.includes(privacyLevel as PrivacyLevel)) {
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
  const retentionDays =
    privacyLevel === "diagnostic" ? DIAGNOSTIC_EVENT_RETENTION_DAYS : RAW_EVENT_RETENTION_DAYS;
  if (occurredAtDate.valueOf() < now - retentionDays * 24 * 60 * 60 * 1000) {
    throw new RequestValidationError("occurred_at is too old");
  }

  const distinctId = requireString(value.distinct_id, "distinct_id", IDENTIFIER_PATTERN);
  if (!INSTALLATION_ID_PATTERN.test(distinctId)) {
    throw new RequestValidationError("Desktop events require an installation identity");
  }
  const sessionId = requireString(value.session_id, "session_id", SESSION_ID_PATTERN);
  const consentLevel = requireString(value.consent_level, "consent_level", /^[a-z]+$/);
  if (!PRIVACY_LEVELS.includes(consentLevel as PrivacyLevel)) {
    throw new RequestValidationError("Invalid consent_level");
  }

  const name = requireString(value.name, "event name", /^[a-z][a-z0-9_.-]{0,79}$/);
  const contractViolation = eventContractViolation({
    name,
    privacyLevel: privacyLevel as PrivacyLevel,
    consentLevel: consentLevel as PrivacyLevel,
    properties,
  });
  if (contractViolation) throw new RequestValidationError(contractViolation);

  return {
    id: requireString(value.id, "event id", IDENTIFIER_PATTERN),
    name,
    distinctId,
    identityType: "desktop_installation",
    sessionId,
    occurredAt: occurredAtDate.toISOString(),
    privacyLevel: privacyLevel as PrivacyLevel,
    consentLevel: consentLevel as PrivacyLevel,
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
  const events = value.events.map(parseEvent);
  const installationId = events[0]?.distinctId;
  if (events.some((event) => event.distinctId !== installationId)) {
    throw new RequestValidationError("A batch must contain one installation identity");
  }
  return events;
}

function requireInstallationToken(request: Request): string {
  return requireString(
    request.headers.get(INSTALLATION_TOKEN_HEADER),
    "installation token",
    INSTALLATION_TOKEN_PATTERN,
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    throw new RequestValidationError(
      error instanceof TransportFailure && error.kind === "body-too-large"
        ? "Request body is too large"
        : "Request body must be valid JSON",
    );
  }
}

async function persistEvents(
  database: D1Database,
  events: ReadonlyArray<AcceptedEvent>,
  deletionTokenHash: string,
): Promise<void> {
  const installationId = events[0]?.distinctId;
  const deleted = await database
    .prepare("SELECT 1 AS deleted FROM analytics_deleted_installations WHERE installation_id = ?")
    .bind(installationId)
    .first();
  if (deleted) throw new InstallationAuthenticationError("Installation authentication failed");
  const latestEvent = events.reduce((latest, event) =>
    event.occurredAt > latest.occurredAt ? event : latest,
  );
  const firstEvent = events.reduce((first, event) =>
    event.occurredAt < first.occurredAt ? event : first,
  );
  const firstProductAt =
    events
      .filter((event) => event.consentLevel === "product" || event.consentLevel === "diagnostic")
      .map((event) => event.occurredAt)
      .sort()[0] ?? null;
  const existing = await database
    .prepare("SELECT deletion_token_hash FROM analytics_identities WHERE identity_id = ?")
    .bind(installationId)
    .first<{ readonly deletion_token_hash: string | null }>();
  if (existing?.deletion_token_hash && existing.deletion_token_hash !== deletionTokenHash) {
    throw new InstallationAuthenticationError("Installation authentication failed");
  }

  const upsertIdentity = `
    INSERT INTO analytics_identities (
      identity_id,
      identity_type,
      canonical_id,
      consent_level,
      first_seen_at,
      last_seen_at,
      deletion_token_hash,
      product_first_seen_at
    ) VALUES (?, 'desktop_installation', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(identity_id) DO UPDATE SET
      consent_level = CASE WHEN excluded.last_seen_at >= analytics_identities.last_seen_at
        THEN excluded.consent_level ELSE analytics_identities.consent_level END,
      first_seen_at = min(analytics_identities.first_seen_at, excluded.first_seen_at),
      last_seen_at = max(analytics_identities.last_seen_at, excluded.last_seen_at),
      product_first_seen_at = CASE WHEN analytics_identities.cohort_eligible = 1
        THEN CASE WHEN analytics_identities.product_first_seen_at IS NULL THEN excluded.product_first_seen_at
          WHEN excluded.product_first_seen_at IS NULL THEN analytics_identities.product_first_seen_at
          ELSE min(analytics_identities.product_first_seen_at, excluded.product_first_seen_at) END
        ELSE NULL END,
      deletion_token_hash = COALESCE(analytics_identities.deletion_token_hash, excluded.deletion_token_hash)
    WHERE analytics_identities.deletion_token_hash IS NULL
       OR analytics_identities.deletion_token_hash = excluded.deletion_token_hash
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
    ) SELECT
      ?, ?, 'desktop', ?, ?, ?, ?, 'desktop_installation',
      COALESCE((SELECT canonical_id FROM analytics_identities WHERE identity_id = ?), ?),
      ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analytics_identities
      WHERE identity_id = ? AND deletion_token_hash = ?
    )
  `;
  await database.batch([
    database
      .prepare(upsertIdentity)
      .bind(
        installationId,
        installationId,
        latestEvent.consentLevel,
        firstEvent.occurredAt,
        latestEvent.occurredAt,
        deletionTokenHash,
        firstProductAt,
      ),
    ...events.map((event) =>
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
          event.distinctId,
          deletionTokenHash,
        ),
    ),
  ]);

  const authenticated = await database
    .prepare(
      "SELECT 1 AS authenticated FROM analytics_identities WHERE identity_id = ? AND deletion_token_hash = ?",
    )
    .bind(installationId, deletionTokenHash)
    .first<{ readonly authenticated: number }>();
  if (!authenticated) {
    throw new InstallationAuthenticationError("Installation authentication failed");
  }
}

async function posthogEvent(row: PendingEventRow): Promise<Record<string, unknown>> {
  let properties: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties_json) as unknown;
    if (isRecord(parsed)) properties = parsed;
  } catch {
    // The gateway writes valid JSON; retaining an empty object makes a malformed legacy row retryable.
  }
  return {
    uuid: await posthogEventUuid(row.event_id),
    event: row.event_name,
    distinct_id: row.canonical_id,
    timestamp: row.occurred_at,
    properties: {
      ...properties,
      event_id: row.event_id,
      $insert_id: row.event_id,
      source: row.source,
      privacy_level: row.privacy_level,
      consent_level: row.consent_level,
      identity_type: row.identity_type,
      ...(row.product_first_seen_at ? { productFirstSeenAt: row.product_first_seen_at } : {}),
      ...(row.session_id ? { $session_id: row.session_id } : {}),
      // A minimal pseudonymous person record is necessary for PostHog's
      // supported distinct-id event deletion API. No person properties are set.
      $process_person_profile: true,
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
                 posthog_last_error = ?,
                 posthog_next_attempt_at = datetime('now', '+' || min(1800, 30 * (1 << min(posthog_attempts, 6))) || ' seconds')
           WHERE event_id = ? AND posthog_state = 'pending'`,
        )
        .bind(error.slice(0, 500), row.event_id),
    ),
  );
}

export async function flushPendingEvents(env: AnalyticsEnv): Promise<number> {
  if (!env.POSTHOG_PROJECT_TOKEN) return 0;
  return withExportLease(env.ANALYTICS_DB, (beforeRequest) =>
    exportPendingEvents(env, beforeRequest),
  );
}

async function exportPendingEvents(
  env: AnalyticsEnv,
  beforeRequest: () => Promise<void>,
): Promise<number> {
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
       properties_json,
       (SELECT product_first_seen_at FROM analytics_identities WHERE identity_id = analytics_events.distinct_id) AS product_first_seen_at
     FROM analytics_events
     WHERE posthog_state = 'pending'
       AND (source <> 'desktop' OR privacy_level <> 'diagnostic')
       AND (source <> 'desktop' OR ? = 1)
       AND (source <> 'desktop' OR (
         julianday(occurred_at) >= julianday('now', CASE WHEN privacy_level = 'diagnostic' THEN '-${DIAGNOSTIC_EVENT_RETENTION_DAYS} days' ELSE '-${RAW_EVENT_RETENTION_DAYS} days' END)
         AND julianday(received_at) >= julianday('now', CASE WHEN privacy_level = 'diagnostic' THEN '-${DIAGNOSTIC_EVENT_RETENTION_DAYS} days' ELSE '-${RAW_EVENT_RETENTION_DAYS} days' END)
         AND julianday(occurred_at) <= julianday('now', '+1 day')
       ))
       AND posthog_attempts < 20
       AND (posthog_next_attempt_at IS NULL OR julianday(posthog_next_attempt_at) <= julianday('now'))
       AND NOT EXISTS (SELECT 1 FROM analytics_deleted_installations WHERE installation_id = analytics_events.distinct_id)
     ORDER BY received_at, event_id
     LIMIT ?`,
  )
    .bind(env.DESKTOP_POSTHOG_EXPORT_ENABLED === "true" ? 1 : 0, POSTHOG_BATCH_SIZE)
    .all<PendingEventRow>();
  let rows = result.results;
  if (rows.length === 0) return 0;

  // Revalidate persisted desktop rows too: a legacy/corrupt row must not bypass
  // today's privacy contract, nor poison every later event in its batch.
  const rejected: string[] = [];
  rows = rows.filter((row) => {
    if (row.source !== "desktop") return true;
    try {
      const properties: unknown = JSON.parse(row.properties_json);
      if (
        isRecord(properties) &&
        PRIVACY_LEVELS.includes(row.privacy_level as PrivacyLevel) &&
        PRIVACY_LEVELS.includes(row.consent_level as PrivacyLevel) &&
        eventContractViolation({
          name: row.event_name,
          privacyLevel: row.privacy_level as PrivacyLevel,
          consentLevel: row.consent_level as PrivacyLevel,
          properties,
        }) === null
      )
        return true;
    } catch {
      /* Quarantine by a fixed class, never by raw properties/error text. */
    }
    rejected.push(row.event_id);
    return false;
  });
  if (rejected.length > 0)
    await env.ANALYTICS_DB.batch(
      rejected.map((id) =>
        env.ANALYTICS_DB.prepare(
          "UPDATE analytics_events SET posthog_attempts = 20, posthog_last_error = 'contract-rejected' WHERE event_id = ? AND posthog_state = 'pending'",
        ).bind(id),
      ),
    );
  if (rows.length === 0) return 0;

  // Persist before sending: a concurrent erasure must know about an uncertain export.
  await env.ANALYTICS_DB.batch(
    rows.map((row) =>
      env.ANALYTICS_DB.prepare(
        "UPDATE analytics_identities SET posthog_attempted = 1 WHERE identity_id = ?",
      ).bind(row.distinct_id),
    ),
  );
  const surviving = await env.ANALYTICS_DB.prepare(
    `SELECT event_id FROM analytics_events WHERE event_id IN (${rows.map(() => "?").join(",")})`,
  )
    .bind(...rows.map((row) => row.event_id))
    .all<{ event_id: string }>();
  const survivingIds = new Set(surviving.results.map((row) => row.event_id));
  rows = rows.filter((row) => survivingIds.has(row.event_id));
  if (rows.length === 0) return 0;

  let response: Response;
  try {
    const batch = await Promise.all(rows.map(posthogEvent));
    await beforeRequest();
    response = await posthogRequest(`${POSTHOG_HOST}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_PROJECT_TOKEN,
        batch,
      }),
    });
  } catch (error) {
    const message = error instanceof TransportFailure ? error.kind : "internal";
    await markPosthogFailure(env.ANALYTICS_DB, rows, message);
    throw error;
  }

  await response.body?.cancel();

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

async function identityIdentifyEvent(
  row: PendingIdentityLinkRow,
): Promise<Record<string, unknown>> {
  return {
    uuid: await posthogEventUuid(row.link_id),
    event: "$identify",
    distinct_id: row.canonical_id,
    timestamp: row.linked_at,
    properties: {
      $anon_distinct_id: row.source_identity_id,
      $insert_id: row.link_id,
      link_id: row.link_id,
      source: "identity_gateway",
      $process_person_profile: true,
    },
  };
}

export async function flushPendingIdentityLinks(env: AnalyticsEnv): Promise<number> {
  if (!env.POSTHOG_PROJECT_TOKEN) return 0;
  return withExportLease(env.ANALYTICS_DB, (beforeRequest) =>
    exportPendingIdentityLinks(env, beforeRequest),
  );
}

async function exportPendingIdentityLinks(
  env: AnalyticsEnv,
  beforeRequest: () => Promise<void>,
): Promise<number> {
  const result = await env.ANALYTICS_DB.prepare(
    `SELECT links.link_id, links.source_identity_id, links.canonical_id, links.linked_at
       FROM analytics_identity_links AS links
       JOIN analytics_identities AS identities
         ON identities.identity_id = links.source_identity_id
      WHERE links.posthog_state = 'pending'
        AND links.posthog_attempts < 20
        AND (links.posthog_next_attempt_at IS NULL OR julianday(links.posthog_next_attempt_at) <= julianday('now'))
        AND identities.identity_type = 'web_visitor'
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
    const batch = await Promise.all(rows.map(identityIdentifyEvent));
    await beforeRequest();
    response = await posthogRequest(`${POSTHOG_HOST}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_PROJECT_TOKEN,
        batch,
      }),
    });
  } catch (error) {
    const message = error instanceof TransportFailure ? error.kind : "internal";
    await env.ANALYTICS_DB.batch(
      rows.map((row) =>
        env.ANALYTICS_DB.prepare(
          `UPDATE analytics_identity_links
              SET posthog_attempts = posthog_attempts + 1,
                  posthog_last_error = ?,
                  posthog_next_attempt_at = datetime('now', '+' || min(1800, 30 * (1 << min(posthog_attempts, 6))) || ' seconds')
            WHERE link_id = ? AND posthog_state = 'pending'`,
        ).bind(message.slice(0, 500), row.link_id),
      ),
    );
    throw error;
  }

  await response.body?.cancel();

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

async function markPosthogDeletionFailure(
  database: D1Database,
  row: PendingDeletionRow,
  errorClass: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE analytics_deletion_requests
          SET posthog_attempts = posthog_attempts + 1,
              posthog_last_error_class = ?,
              next_attempt_at = datetime('now', '+30 minutes'),
              posthog_state = CASE
                WHEN posthog_attempts + 1 >= ? THEN 'blocked'
                ELSE 'pending'
              END
        WHERE request_id = ? AND posthog_state = 'pending'`,
    )
    .bind(errorClass.slice(0, 120), POSTHOG_DELETION_MAX_ATTEMPTS, row.request_id)
    .run();
}

/** A capture acknowledgement is not an erasure acknowledgement. Poll verified status. */
export async function flushPendingDeletions(env: AnalyticsEnv): Promise<number> {
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return 0;
  return withExportLease(env.ANALYTICS_DB, (beforeRequest) =>
    processPendingDeletion(env, beforeRequest),
  );
}

async function processPendingDeletion(
  env: AnalyticsEnv,
  beforeRequest: () => Promise<void>,
): Promise<number> {
  const result = await env.ANALYTICS_DB.prepare(
    `SELECT request_id, posthog_distinct_id, posthog_attempts, requested_at,
            posthog_person_uuid, posthog_submitted_at
       FROM analytics_deletion_requests
      WHERE posthog_state = 'pending'
        AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday('now'))
      ORDER BY requested_at, request_id
      LIMIT ?`,
  )
    .bind(POSTHOG_DELETION_BATCH_SIZE)
    .all<PendingDeletionRow>();

  const base = `${POSTHOG_API_HOST}/api/projects/${encodeURIComponent(env.POSTHOG_PROJECT_ID!)}`;
  const headers = {
    Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`,
    "Content-Type": "application/json",
  };
  const api = async (path: string, init: RequestInit = {}) => {
    await beforeRequest();
    return readBoundedJson(await posthogRequest(`${base}${path}`, { ...init, headers }), 64 * 1024);
  };
  let failed = false;
  let completed = 0;
  for (const row of result.results) {
    try {
      if (!INSTALLATION_ID_PATTERN.test(row.posthog_distinct_id)) {
        await env.ANALYTICS_DB.prepare(
          "UPDATE analytics_deletion_requests SET posthog_state = 'blocked', posthog_last_error_class = 'linked-identity-review' WHERE request_id = ?",
        )
          .bind(row.request_id)
          .run();
        failed = true;
        continue;
      }
      if (row.posthog_person_uuid) {
        const body = await api(
          `/persons/deletion_status/?person_uuid=${encodeURIComponent(row.posthog_person_uuid)}&limit=10`,
        );
        if (!isRecord(body) || !Array.isArray(body.results))
          throw new TransportFailure("invalid-json");
        const status = body.results.find(
          (item: unknown) =>
            isRecord(item) &&
            item.person_uuid === row.posthog_person_uuid &&
            typeof item.created_at === "string" &&
            Date.parse(item.created_at) >= Date.parse(row.requested_at),
        ) as Record<string, unknown> | undefined;
        if (status) {
          const verified =
            status.status === "completed" &&
            typeof status.delete_verified_at === "string" &&
            Date.parse(status.delete_verified_at) >= Date.parse(String(status.created_at));
          await env.ANALYTICS_DB.prepare(
            `UPDATE analytics_deletion_requests SET posthog_state = ?,
               posthog_verified_at = ?, posthog_last_error_class = ?,
               completed_at = ?,
               next_attempt_at = datetime('now', '+30 minutes') WHERE request_id = ?`,
          )
            .bind(
              verified ? "completed" : "pending",
              verified ? status.delete_verified_at : null,
              null,
              verified ? status.delete_verified_at : null,
              row.request_id,
            )
            .run();
          // Completion is PostHog's verified asynchronous erasure, not its
          // submission acknowledgement. The tombstone rejects future uploads;
          // the shared export lease prevents a later exporter reusing this ID.
          if (verified) completed += 1;
          continue;
        }
      }

      // Resolve and save the person UUID before a possibly ambiguous submission.
      // Never erase a person that also represents another installation/account.
      const people = await api(
        `/persons/?distinct_id=${encodeURIComponent(row.posthog_distinct_id)}&limit=2`,
      );
      if (!isRecord(people) || !Array.isArray(people.results))
        throw new TransportFailure("invalid-json");
      const person: unknown = people.results[0];
      if (
        people.results.length !== 1 ||
        !isRecord(person) ||
        typeof person.uuid !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(person.uuid) ||
        !Array.isArray(person.distinct_ids) ||
        person.distinct_ids.length !== 1 ||
        person.distinct_ids[0] !== row.posthog_distinct_id
      ) {
        await markPosthogDeletionFailure(
          env.ANALYTICS_DB,
          row,
          people.results.length === 0 ? "export-not-yet-visible" : "linked-identity-review",
        );
        failed = true;
        continue;
      }
      await env.ANALYTICS_DB.prepare(
        "UPDATE analytics_deletion_requests SET posthog_person_uuid = ? WHERE request_id = ?",
      )
        .bind(person.uuid, row.request_id)
        .run();
      const body = await api("/persons/bulk_delete/", {
        method: "POST",
        body: JSON.stringify({
          ids: [person.uuid],
          delete_events: true,
          delete_recordings: false,
          keep_person: false,
        }),
      });
      if (
        !isRecord(body) ||
        body.persons_found !== 1 ||
        body.events_queued_for_deletion !== true ||
        !Array.isArray(body.deletion_errors) ||
        body.deletion_errors.length !== 0
      ) {
        throw new TransportFailure("invalid-json");
      }
      await env.ANALYTICS_DB.prepare(
        `UPDATE analytics_deletion_requests
            SET posthog_submitted_at = CURRENT_TIMESTAMP,
                posthog_attempts = posthog_attempts + 1,
                posthog_last_error_class = NULL,
                next_attempt_at = datetime('now', '+30 minutes')
          WHERE request_id = ? AND posthog_state = 'pending'`,
      )
        .bind(row.request_id)
        .run();
    } catch (error) {
      await markPosthogDeletionFailure(
        env.ANALYTICS_DB,
        row,
        error instanceof TransportFailure ? error.kind : "internal",
      );
      failed = true;
    }
  }
  if (failed) throw new Error("posthog-deletion-incomplete");
  return completed;
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
    // Installation-only erasure must not delete a merged person's other installations.
    // Keep this unlaunched capability closed until account-scoped erasure is designed.
    if (link.identityIds.some((id) => INSTALLATION_ID_PATTERN.test(id))) {
      return jsonResponse({ error: "Desktop account linking is not available" }, 409);
    }
    await persistIdentityLinks(env.ANALYTICS_DB, link.accountId, link.identityIds);
    context.waitUntil(
      flushPendingIdentityLinks(env).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "PostHog identity linking failed",
            error_class: error instanceof TransportFailure ? error.kind : "internal",
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
        error_class: error instanceof TransportFailure ? error.kind : "internal",
      }),
    );
    return jsonResponse({ error: "Identity linking failed" }, 500);
  }
}

export async function pruneExpiredAnalyticsEvents(
  database: D1Database,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.valueOf() - RAW_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const diagnosticCutoff = new Date(now.valueOf() - DIAGNOSTIC_EVENT_RETENTION_DAYS * 86400000);
  const result = await database
    .prepare(
      `DELETE FROM analytics_events
        WHERE event_id IN (
          SELECT event_id
          FROM analytics_events
          WHERE julianday(received_at) < julianday(?)
             OR (privacy_level = 'diagnostic' AND julianday(received_at) < julianday(?))
             OR (source = 'desktop' AND (julianday(occurred_at) < julianday(?)
               OR (privacy_level = 'diagnostic' AND julianday(occurred_at) < julianday(?))))
          ORDER BY received_at, event_id
          LIMIT ?
        )`,
    )
    .bind(
      cutoff.toISOString(),
      diagnosticCutoff.toISOString(),
      cutoff.toISOString(),
      diagnosticCutoff.toISOString(),
      RETENTION_BATCH_SIZE,
    )
    .run();
  if (result.meta.changes === RETENTION_BATCH_SIZE) {
    const remaining = await database
      .prepare(`SELECT 1 AS expired FROM analytics_events
      WHERE julianday(received_at) < julianday(?)
        OR (privacy_level = 'diagnostic' AND julianday(received_at) < julianday(?))
        OR (source = 'desktop' AND (julianday(occurred_at) < julianday(?)
          OR (privacy_level = 'diagnostic' AND julianday(occurred_at) < julianday(?)))) LIMIT 1`)
      .bind(
        cutoff.toISOString(),
        diagnosticCutoff.toISOString(),
        cutoff.toISOString(),
        diagnosticCutoff.toISOString(),
      )
      .first();
    // Stay bounded; the next scheduled batch continues. Do not report a clean
    // retention pass while records older than the policy still remain.
    if (remaining) throw new Error("retention-backlog");
  }
  return result.meta.changes;
}

function validateDeletionPayload(value: unknown): string {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new RequestValidationError("Unsupported deletion payload");
  }
  return requireString(value.installation_id, "installation_id", INSTALLATION_ID_PATTERN);
}

async function handleInstallationDeletion(request: Request, env: AnalyticsEnv): Promise<Response> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415);
  }
  try {
    const tokenHash = await sha256(requireInstallationToken(request));
    const installationId = validateDeletionPayload(await readJsonBody(request));
    const identity = await env.ANALYTICS_DB.prepare(
      "SELECT deletion_token_hash FROM analytics_identities WHERE identity_id = ?",
    )
      .bind(installationId)
      .first<{
        readonly deletion_token_hash: string | null;
      }>();
    if (identity && (!identity.deletion_token_hash || identity.deletion_token_hash !== tokenHash)) {
      throw new InstallationAuthenticationError("Installation authentication failed");
    }

    const requestId = crypto.randomUUID();
    const requestedAt = new Date().toISOString();
    await env.ANALYTICS_DB.batch([
      env.ANALYTICS_DB.prepare(
        `INSERT INTO analytics_deleted_installations (installation_id, deletion_token_hash, request_id, requested_at)
         SELECT ?, ?, ?, ? WHERE NOT EXISTS (
           SELECT 1 FROM analytics_identities WHERE identity_id = ?
             AND (deletion_token_hash IS NULL OR deletion_token_hash <> ?)
         ) ON CONFLICT(installation_id) DO NOTHING`,
      ).bind(installationId, tokenHash, requestId, requestedAt, installationId, tokenHash),
      env.ANALYTICS_DB.prepare(
        `INSERT INTO analytics_deletion_requests (
           request_id, installation_id, posthog_distinct_id, requested_at, posthog_state,
           completed_at, next_attempt_at, posthog_last_error_class
         ) SELECT tomb.request_id, tomb.installation_id, tomb.installation_id, tomb.requested_at,
             CASE WHEN identities.canonical_id <> tomb.installation_id THEN 'blocked'
                  WHEN COALESCE(identities.posthog_attempted, 0) = 0 THEN 'completed' ELSE 'pending' END,
             CASE WHEN identities.canonical_id <> tomb.installation_id THEN NULL
                  WHEN COALESCE(identities.posthog_attempted, 0) = 0 THEN tomb.requested_at ELSE NULL END,
             datetime('now', '+5 minutes'),
             CASE WHEN identities.canonical_id <> tomb.installation_id THEN 'linked-identity-review' ELSE NULL END
           FROM analytics_deleted_installations AS tomb
           LEFT JOIN analytics_identities AS identities ON identities.identity_id = tomb.installation_id
           WHERE tomb.installation_id = ? AND tomb.deletion_token_hash = ?
           ON CONFLICT(request_id) DO NOTHING`,
      ).bind(installationId, tokenHash),
      env.ANALYTICS_DB.prepare(
        `DELETE FROM analytics_identity_links WHERE source_identity_id = ? AND EXISTS
         (SELECT 1 FROM analytics_deleted_installations WHERE installation_id = ? AND deletion_token_hash = ?)`,
      ).bind(installationId, installationId, tokenHash),
      ...(["analytics_consents", "analytics_events", "analytics_identities"] as const).map(
        (table) =>
          env.ANALYTICS_DB.prepare(
            `DELETE FROM ${table} WHERE ${table === "analytics_events" ? "distinct_id" : "identity_id"} = ? AND EXISTS
           (SELECT 1 FROM analytics_deleted_installations WHERE installation_id = ? AND deletion_token_hash = ?)`,
          ).bind(installationId, installationId, tokenHash),
      ),
    ]);
    const receipt = await env.ANALYTICS_DB.prepare(
      `SELECT requests.request_id, requests.posthog_state FROM analytics_deleted_installations AS tomb
       JOIN analytics_deletion_requests AS requests ON requests.request_id = tomb.request_id
       WHERE tomb.installation_id = ? AND tomb.deletion_token_hash = ?`,
    )
      .bind(installationId, tokenHash)
      .first<{ request_id: string; posthog_state: string }>();
    if (!receipt) throw new InstallationAuthenticationError("Installation authentication failed");
    return jsonResponse(
      {
        accepted: true,
        request_id: receipt.request_id,
        local_state: "deleted",
        posthog_state: receipt.posthog_state,
      },
      202,
    );
  } catch (error) {
    if (error instanceof InstallationAuthenticationError) {
      return jsonResponse({ error: error.message }, 403);
    }
    if (error instanceof RequestValidationError) {
      return jsonResponse({ error: error.message }, 400);
    }
    console.error(JSON.stringify({ message: "Analytics deletion request failed" }));
    return jsonResponse({ error: "Analytics deletion request failed" }, 500);
  }
}

async function handleIngestion(
  request: Request,
  env: AnalyticsEnv,
  context: ExecutionContext,
): Promise<Response> {
  if (env.DESKTOP_INGESTION_ENABLED !== "true") {
    return jsonResponse({ error: "Desktop analytics ingestion is disabled" }, 503);
  }
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_WEB_ORIGINS.has(origin)) {
    return jsonResponse({ error: "Origin is not allowed" }, 403);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415, origin);
  }

  try {
    const deletionTokenHash = await sha256(requireInstallationToken(request));
    const events = validateIngestionPayload(await readJsonBody(request));
    const installationId = events[0]?.distinctId;
    if (!installationId) throw new RequestValidationError("At least one event is required");
    if (!env.ANALYTICS_INGESTION_RATE_LIMITER) {
      return jsonResponse({ error: "Analytics rate limiting is unavailable" }, 503, origin);
    }
    const rateLimit = await env.ANALYTICS_INGESTION_RATE_LIMITER.limit({ key: installationId });
    if (!rateLimit.success) {
      const response = jsonResponse({ error: "Too many analytics requests" }, 429, origin);
      response.headers.set("Retry-After", "60");
      return response;
    }
    await persistEvents(env.ANALYTICS_DB, events, deletionTokenHash);
    context.waitUntil(
      flushPendingEvents(env).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "PostHog forwarding failed",
            error_class: error instanceof TransportFailure ? error.kind : "internal",
          }),
        );
      }),
    );
    return jsonResponse({ accepted: events.length }, 202, origin);
  } catch (error) {
    if (error instanceof InstallationAuthenticationError) {
      return jsonResponse({ error: error.message }, 403, origin);
    }
    if (error instanceof RequestValidationError) {
      return jsonResponse({ error: error.message }, 400, origin);
    }
    console.error(
      JSON.stringify({
        message: "Analytics ingestion failed",
        error_class: error instanceof TransportFailure ? error.kind : "internal",
      }),
    );
    return jsonResponse({ error: "Analytics ingestion failed" }, 500, origin);
  }
}

const worker: ExportedHandler<AnalyticsEnv> = {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      let storageReady = false;
      let retentionReady = false;
      try {
        // Compile against the required schema without scanning or exposing user rows.
        await env.ANALYTICS_DB.prepare(`SELECT events.posthog_next_attempt_at, identities.posthog_attempted,
          deletions.posthog_person_uuid, tomb.deletion_token_hash, leases.expires_at, maintenance.outcome
          FROM analytics_events AS events, analytics_identities AS identities,
            analytics_deletion_requests AS deletions, analytics_deleted_installations AS tomb,
            analytics_maintenance_leases AS leases, analytics_maintenance_status AS maintenance
          LIMIT 0`).all();
        storageReady = true;
        const retention = await env.ANALYTICS_DB.prepare(
          "SELECT completed_at, outcome FROM analytics_maintenance_status WHERE name = 'retention'",
        ).first<{ completed_at: string; outcome: string }>();
        retentionReady =
          retention?.outcome === "ok" &&
          Date.now() - Date.parse(retention.completed_at) < 20 * 60 * 1000;
      } catch {
        // Health is safe and useful even with an unavailable DB or unapplied migration.
      }
      return jsonResponse(
        {
          status: storageReady ? "ready" : "degraded",
          contract_revision: ANALYTICS_CONTRACT_REVISION,
          worker_version: env.CF_VERSION_METADATA?.id ?? "unavailable",
          worker_version_tag: env.CF_VERSION_METADATA?.tag ?? null,
          worker_version_created_at: env.CF_VERSION_METADATA?.timestamp ?? null,
          storage: storageReady ? "ready" : "unavailable_or_unmigrated",
          retention: retentionReady ? "recent_success" : "pending_verification",
          activation_prerequisites_configured: Boolean(
            storageReady &&
            retentionReady &&
            env.ANALYTICS_INGESTION_RATE_LIMITER &&
            env.POSTHOG_PROJECT_TOKEN &&
            env.POSTHOG_PERSONAL_API_KEY &&
            env.POSTHOG_PROJECT_ID,
          ),
          desktop_ingestion: env.DESKTOP_INGESTION_ENABLED === "true" ? "enabled" : "disabled",
          rate_limiting: env.ANALYTICS_INGESTION_RATE_LIMITER
            ? "configured"
            : "pending_configuration",
          posthog_forwarding: env.POSTHOG_PROJECT_TOKEN ? "configured" : "pending_configuration",
          desktop_posthog_export:
            env.DESKTOP_POSTHOG_EXPORT_ENABLED === "true" ? "enabled" : "disabled",
          posthog_deletion:
            env.POSTHOG_PERSONAL_API_KEY && env.POSTHOG_PROJECT_ID
              ? "configured"
              : "pending_configuration",
          identity_linking: env.IDENTITY_LINK_TOKEN ? "configured" : "pending_configuration",
        },
        storageReady ? 200 : 503,
      );
    }
    if (request.method === "OPTIONS" && url.pathname === "/v1/events") {
      const origin = request.headers.get("Origin");
      if (!origin || !ALLOWED_WEB_ORIGINS.has(origin)) {
        return jsonResponse({ error: "Origin is not allowed" }, 403);
      }
      const response = new Response(null, { status: 204 });
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set(
        "Access-Control-Allow-Headers",
        `Content-Type, ${INSTALLATION_TOKEN_HEADER}`,
      );
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
    if (request.method === "POST" && url.pathname === "/v1/installations/delete") {
      return handleInstallationDeletion(request, env);
    }
    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(_controller, env, context) {
    context.waitUntil(
      (async () => {
        for (const [name, operation] of [
          ["retention", () => pruneExpiredAnalyticsEvents(env.ANALYTICS_DB)],
          ["deletion", () => flushPendingDeletions(env)],
          ["identity-export", () => flushPendingIdentityLinks(env)],
          ["event-export", () => flushPendingEvents(env)],
        ] as const) {
          let outcome = "ok";
          try {
            await operation();
          } catch {
            outcome = "failed";
            console.error(
              JSON.stringify({ message: "Analytics maintenance failed", operation: name }),
            );
          }
          try {
            await env.ANALYTICS_DB.prepare(`INSERT INTO analytics_maintenance_status (name, completed_at, outcome)
              VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET completed_at = excluded.completed_at, outcome = excluded.outcome`)
              .bind(name, new Date().toISOString(), outcome)
              .run();
          } catch {
            console.error(
              JSON.stringify({
                message: "Analytics maintenance status unavailable",
                operation: name,
              }),
            );
          }
        }
      })(),
    );
  },
};

export default worker;
