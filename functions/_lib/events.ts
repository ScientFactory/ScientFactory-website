// FILE: events.ts
// Purpose: Stores a deliberately small set of consent-aware first-party website events.
// Layer: Cloudflare Pages Function utility

import { cleanSessionId, websiteIdentity, websiteSessionId } from "./identity";

export const SITE_EVENT_NAMES = [
  "page_viewed",
  "download_clicked",
  "download_failed",
  "outbound_link_clicked",
] as const;

export type SiteEventName = (typeof SITE_EVENT_NAMES)[number];

export interface SiteEvent {
  readonly eventName: SiteEventName;
  readonly pagePath?: string | null;
  readonly assetKey?: string | null;
  readonly releaseTag?: string | null;
  readonly assetName?: string | null;
  readonly destinationHost?: string | null;
  readonly destinationPath?: string | null;
  readonly failureStage?: string | null;
  readonly failureReason?: string | null;
  readonly sessionId?: string | null;
}

export interface SiteEventContext {
  readonly request: Request;
  readonly env: { readonly DOWNLOAD_DB?: D1Database };
  waitUntil(promise: Promise<unknown>): void;
}

const INSERT_EVENT = `
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
  ) VALUES (?, ?, 'website', ?, ?, ?, ?, ?, ?, ?, ?)
`;

const PRODUCTION_HOSTS = new Set(["scientfactory.com", "www.scientfactory.com"]);

function limited(value: string | null | undefined, maximum: number): string | null {
  if (!value) return null;
  return value.slice(0, maximum);
}

export function cleanPath(value: string | null | undefined): string | null {
  if (!value?.startsWith("/")) return null;
  const path = value.split(/[?#]/, 1)[0] ?? "/";
  return limited(path, 512);
}

export function destinationParts(
  value: string,
  siteOrigin: string,
): {
  destinationHost: string;
  destinationPath: string;
} | null {
  try {
    const destination = new URL(value);
    if (destination.protocol !== "https:" && destination.protocol !== "http:") return null;
    if (destination.origin === siteOrigin) return null;

    return {
      destinationHost: destination.hostname.slice(0, 253),
      destinationPath: cleanPath(destination.pathname) ?? "/",
    };
  } catch {
    return null;
  }
}

export function shouldPersistSiteEvents(request: Request): boolean {
  return PRODUCTION_HOSTS.has(new URL(request.url).hostname);
}

export async function insertSiteEvent(
  db: D1Database,
  event: SiteEvent,
  request?: Request,
): Promise<void> {
  const eventId = crypto.randomUUID();
  const identity = request ? websiteIdentity(request) : null;
  const distinctId = identity?.identityId ?? `web-event:${eventId}`;
  const occurredAt = new Date().toISOString();
  const sessionId = identity
    ? (websiteSessionId(request!) ?? cleanSessionId(event.sessionId))
    : null;
  const properties = Object.fromEntries(
    Object.entries({
      page_path: cleanPath(event.pagePath),
      asset_key: limited(event.assetKey, 64),
      release_tag: limited(event.releaseTag, 80),
      asset_name: limited(event.assetName, 255),
      destination_host: limited(event.destinationHost, 253),
      destination_path: cleanPath(event.destinationPath),
      failure_stage: limited(event.failureStage, 80),
      failure_reason: limited(event.failureReason, 120),
    }).filter((entry): entry is [string, string] => entry[1] !== null),
  );

  const statements: D1PreparedStatement[] = [];
  if (identity) {
    statements.push(
      db
        .prepare(
          `INSERT INTO analytics_identities (
             identity_id, identity_type, canonical_id, consent_level, first_seen_at, last_seen_at
           ) VALUES (?, 'web_visitor', ?, 'product', ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             consent_level = 'product'`,
        )
        .bind(identity.identityId, identity.canonicalId, occurredAt, occurredAt),
    );
  }
  statements.push(
    db
      .prepare(INSERT_EVENT)
      .bind(
        eventId,
        event.eventName,
        event.eventName === "download_failed" ? "diagnostic" : "product",
        occurredAt,
        distinctId,
        JSON.stringify(properties),
        identity?.identityType ?? "event",
        identity?.canonicalId ?? distinctId,
        sessionId,
        identity?.consentLevel ?? "essential",
      ),
  );
  await db.batch(statements);
}

export function queueSiteEvent(context: SiteEventContext, event: SiteEvent): void {
  if (!shouldPersistSiteEvents(context.request)) return;

  const db = context.env.DOWNLOAD_DB;
  if (!db) {
    console.error(JSON.stringify({ message: "Site event database binding is missing" }));
    return;
  }

  const write = insertSiteEvent(db, event, context.request).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        message: "Site event write failed",
        eventName: event.eventName,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });

  context.waitUntil(write);
}
