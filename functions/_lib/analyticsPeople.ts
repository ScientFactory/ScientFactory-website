export interface NetworkObservation {
  readonly ip: string;
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly timezone: string | null;
  readonly asn: number | null;
  readonly network: string | null;
}

const label = (value: unknown, maxLength = 128): string | null =>
  typeof value === "string" ? value.slice(0, maxLength) : null;

export function networkObservation(request: Request): NetworkObservation | null {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || ip.length > 45 || !/^[0-9a-f:.]+$/iu.test(ip)) return null;
  const cf = request.cf;
  return {
    ip,
    country: label(cf?.country),
    region: label(cf?.region),
    city: label(cf?.city),
    timezone: label(cf?.timezone),
    asn: typeof cf?.asn === "number" && Number.isFinite(cf.asn) ? cf.asn : null,
    network: label(cf?.asOrganization),
  };
}

export interface IdentityObservation {
  readonly id: string;
  readonly name: string;
  readonly distinctId: string;
  readonly occurredAt: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export function isIdentityObservation(event: Pick<IdentityObservation, "name" | "properties">) {
  return (
    event.name === "install.account_observed" ||
    event.name === "install.profile_observed" ||
    (event.name === "install.owner_observed" && event.properties.ownerSource === "device")
  );
}

// Called inside the event transaction, after token ownership and tombstones are checked.
export function installationObservationStatements(
  db: D1Database,
  events: ReadonlyArray<IdentityObservation>,
  network: NetworkObservation | null,
  tokenHash: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const event of events) {
    const p = event.properties;
    const guard =
      "EXISTS (SELECT 1 FROM analytics_events WHERE event_id = ? AND distinct_id = ? AND properties_json = ? AND occurred_at = ? AND event_name = ?)";
    if (event.name === "install.account_observed") {
      statements.push(
        db
          .prepare(`INSERT INTO analytics_installation_accounts
        (installation_id, provider, email, plan, account_type, first_seen_at, last_seen_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
        ON CONFLICT(installation_id, provider, email, plan, account_type) DO UPDATE SET
        last_seen_at = max(last_seen_at, excluded.last_seen_at)`)
          .bind(
            event.distinctId,
            label(p.provider) ?? "other",
            label(p.email, 254) ?? "",
            label(p.plan) ?? "",
            label(p.accountType) ?? "",
            event.occurredAt,
            event.occurredAt,
            event.id,
            event.distinctId,
            JSON.stringify(p),
            event.occurredAt,
            event.name,
          ),
      );
    } else if (event.name === "install.profile_observed") {
      statements.push(
        db
          .prepare(`INSERT INTO analytics_installation_profiles
        (installation_id, work_kinds, field, role, other_work, answered_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}
        ON CONFLICT(installation_id) DO UPDATE SET work_kinds = excluded.work_kinds,
        field = excluded.field, role = excluded.role, other_work = excluded.other_work,
        answered_at = excluded.answered_at WHERE excluded.answered_at >= answered_at`)
          .bind(
            event.distinctId,
            JSON.stringify(p.workKinds ?? []),
            label(p.field),
            label(p.role),
            label(p.otherWork),
            event.occurredAt,
            event.id,
            event.distinctId,
            JSON.stringify(p),
            event.occurredAt,
            event.name,
          ),
      );
    } else if (
      event.name === "install.owner_observed" &&
      p.ownerSource === "device" &&
      typeof p.ownerId === "string" &&
      /^[a-f0-9]{64}$/iu.test(p.ownerId)
    ) {
      statements.push(
        db
          .prepare(`INSERT INTO analytics_installation_devices
        (installation_id, device_hash, first_seen_at, last_seen_at)
        SELECT ?, ?, ?, ? WHERE ${guard}
        ON CONFLICT(installation_id, device_hash) DO UPDATE SET last_seen_at = max(last_seen_at, excluded.last_seen_at)`)
          .bind(
            event.distinctId,
            p.ownerId,
            event.occurredAt,
            event.occurredAt,
            event.id,
            event.distinctId,
            JSON.stringify(p),
            event.occurredAt,
            event.name,
          ),
      );
    }
  }
  const first = events[0];
  if (network && first) {
    const now = new Date().toISOString();
    statements.push(
      db
        .prepare(`INSERT INTO analytics_installation_sightings
      (installation_id, day, ip_address, country, region, city, timezone, asn, network_name, first_seen_at, last_seen_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM analytics_identities WHERE identity_id = ? AND deletion_token_hash = ?)
      AND NOT EXISTS (SELECT 1 FROM analytics_deleted_installations WHERE installation_id = ?)
      ON CONFLICT(installation_id, day, ip_address) DO UPDATE SET
      last_seen_at = max(last_seen_at, excluded.last_seen_at)`)
        .bind(
          first.distinctId,
          now.slice(0, 10),
          network.ip,
          network.country,
          network.region,
          network.city,
          network.timezone,
          network.asn,
          network.network,
          now,
          now,
          first.distinctId,
          tokenHash,
          first.distinctId,
        ),
    );
  }
  return statements;
}

export function webObservationStatement(
  db: D1Database,
  eventId: string,
  eventName: string,
  occurredAt: string,
  visitorId: string,
  request: Request,
): D1PreparedStatement | null {
  const network = networkObservation(request);
  if (!network) return null;
  let referrer: string | null = null;
  try {
    referrer = new URL(request.headers.get("Referer") ?? "").hostname;
  } catch {
    /* optional */
  }
  return db
    .prepare(`INSERT OR IGNORE INTO analytics_web_sightings
    (event_id, event_name, occurred_at, visitor_id, ip_address, referrer_host, country, region, city, timezone, asn, network_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId,
      eventName,
      occurredAt,
      visitorId,
      network.ip,
      referrer,
      network.country,
      network.region,
      network.city,
      network.timezone,
      network.asn,
      network.network,
    );
}

export const INSTALLATION_OBSERVATION_TABLES = [
  "analytics_installation_accounts",
  "analytics_installation_profiles",
  "analytics_installation_devices",
  "analytics_installation_sightings",
  "analytics_daily_members",
] as const;

export const DIAGNOSTIC_SQL = `(privacy_level = 'diagnostic' OR event_name LIKE '%.failed'
  OR event_name = 'download_failed' OR CASE WHEN json_valid(properties_json)
  THEN COALESCE(json_extract(properties_json, '$.outcome') IN ('error', 'failed'), 0) ELSE 0 END)`;

export function diagnosticObservation(
  name: string,
  privacy: string,
  properties: Readonly<Record<string, unknown>>,
) {
  return (
    privacy === "diagnostic" ||
    name.endsWith(".failed") ||
    name === "download_failed" ||
    properties.outcome === "error" ||
    properties.outcome === "failed"
  );
}

const EXPIRED_IDENTITY_SQL = `julianday(last_seen_at) < julianday(?)
  AND (identity_type <> 'account' OR NOT EXISTS (
    SELECT 1 FROM analytics_identities AS source
    WHERE source.canonical_id = analytics_identities.identity_id
    AND source.identity_id <> analytics_identities.identity_id
    AND julianday(source.last_seen_at) >= julianday(?)))`;

export function usageRetentionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  return cutoff;
}

export async function prunePeopleAnalytics(db: D1Database, now = new Date()): Promise<number> {
  const inactive = usageRetentionCutoff(now);
  const diagnostic = new Date(now.valueOf() - 60 * 86400000).toISOString();
  const cutoff = inactive.toISOString();
  // Freeze a bounded set of expired identities for the entire cleanup transaction.
  const statements = [
    db
      .prepare(`INSERT OR IGNORE INTO analytics_expired_identities (identity_id)
    SELECT identity_id FROM analytics_identities WHERE ${EXPIRED_IDENTITY_SQL}
    ORDER BY last_seen_at LIMIT 100`)
      .bind(cutoff, cutoff),
  ];
  for (const table of INSTALLATION_OBSERVATION_TABLES) {
    statements.push(
      db.prepare(
        `DELETE FROM ${table} WHERE installation_id IN (SELECT identity_id FROM analytics_expired_identities)`,
      ),
    );
  }
  statements.push(
    db
      .prepare(`DELETE FROM analytics_web_sightings WHERE event_id IN (SELECT event_id FROM analytics_web_sightings
      WHERE visitor_id IN (SELECT identity_id FROM analytics_expired_identities)
      OR (NOT EXISTS (SELECT 1 FROM analytics_identities WHERE identity_id = visitor_id)
        AND julianday(occurred_at) < julianday(?)) LIMIT 5000)`)
      .bind(cutoff),
    db.prepare(`DELETE FROM analytics_identity_links WHERE source_identity_id IN (SELECT identity_id FROM analytics_expired_identities)
      OR canonical_id IN (SELECT identity_id FROM analytics_expired_identities)`),
    db.prepare(
      `DELETE FROM analytics_consents WHERE identity_id IN (SELECT identity_id FROM analytics_expired_identities)`,
    ),
    db
      .prepare(`DELETE FROM analytics_events WHERE event_id IN (SELECT event_id FROM analytics_events
      WHERE distinct_id IN (SELECT identity_id FROM analytics_expired_identities)
      OR (${DIAGNOSTIC_SQL} AND (julianday(occurred_at) < julianday(?) OR julianday(received_at) < julianday(?)))
      OR (NOT EXISTS (SELECT 1 FROM analytics_identities WHERE identity_id = distinct_id)
        AND julianday(received_at) < julianday(?)) LIMIT 5000)`)
      .bind(diagnostic, diagnostic, cutoff),
    // Keep identities with remaining events for the next bounded maintenance pass.
    db.prepare(`DELETE FROM analytics_identities WHERE identity_id IN (SELECT identity_id FROM analytics_expired_identities)
      AND NOT EXISTS (SELECT 1 FROM analytics_events WHERE distinct_id = identity_id)
      AND NOT EXISTS (SELECT 1 FROM analytics_web_sightings WHERE visitor_id = identity_id)`),
    db
      .prepare(`DELETE FROM site_events WHERE id IN (SELECT id FROM site_events
      WHERE julianday(occurred_at) < julianday(?) OR (event_name = 'download_failed' AND julianday(occurred_at) < julianday(?)) LIMIT 5000)`)
      .bind(cutoff, diagnostic),
    db.prepare("DELETE FROM analytics_expired_identities"),
    db
      .prepare("DELETE FROM analytics_daily_members WHERE day < substr(?, 1, 10)")
      .bind(new Date(now.valueOf() - 733 * 86400000).toISOString()),
  );
  const results = await db.batch(statements);
  const remaining = await db
    .prepare(`SELECT 1 AS expired FROM analytics_identities
    WHERE ${EXPIRED_IDENTITY_SQL} LIMIT 1`)
    .bind(cutoff, cutoff)
    .first();
  const diagnosticsRemaining = await db
    .prepare(`SELECT 1 AS expired FROM analytics_events WHERE ${DIAGNOSTIC_SQL}
    AND (julianday(occurred_at) < julianday(?) OR julianday(received_at) < julianday(?)) LIMIT 1`)
    .bind(diagnostic, diagnostic)
    .first();
  const orphanRemaining = await db
    .prepare(`SELECT 1 AS expired FROM analytics_events
    WHERE NOT EXISTS (SELECT 1 FROM analytics_identities WHERE identity_id = distinct_id)
    AND julianday(received_at) < julianday(?) LIMIT 1`)
    .bind(cutoff)
    .first();
  const legacyRemaining = await db
    .prepare(`SELECT 1 AS expired FROM site_events
    WHERE julianday(occurred_at) < julianday(?)
    OR (event_name = 'download_failed' AND julianday(occurred_at) < julianday(?)) LIMIT 1`)
    .bind(cutoff, diagnostic)
    .first();
  const webRemaining = await db
    .prepare(`SELECT 1 AS expired FROM analytics_web_sightings
    WHERE NOT EXISTS (SELECT 1 FROM analytics_identities WHERE identity_id = visitor_id)
    AND julianday(occurred_at) < julianday(?) LIMIT 1`)
    .bind(cutoff)
    .first();
  if (remaining || diagnosticsRemaining || orphanRemaining || legacyRemaining || webRemaining)
    throw new Error("retention-backlog");
  return results.reduce((n, result) => n + result.meta.changes, 0);
}
