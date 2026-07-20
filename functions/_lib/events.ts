// FILE: events.ts
// Purpose: Stores a deliberately small, anonymous set of first-party website events.
// Layer: Cloudflare Pages Function utility

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
    properties_json
  ) VALUES (?, ?, 'website', ?, ?, ?, ?)
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

export async function insertSiteEvent(db: D1Database, event: SiteEvent): Promise<void> {
  const eventId = crypto.randomUUID();
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

  await db
    .prepare(INSERT_EVENT)
    .bind(
      eventId,
      event.eventName,
      event.eventName === "download_failed" ? "diagnostic" : "product",
      new Date().toISOString(),
      `web-event:${eventId}`,
      JSON.stringify(properties),
    )
    .run();
}

export function queueSiteEvent(context: SiteEventContext, event: SiteEvent): void {
  if (!shouldPersistSiteEvents(context.request)) return;

  const db = context.env.DOWNLOAD_DB;
  if (!db) {
    console.error(JSON.stringify({ message: "Site event database binding is missing" }));
    return;
  }

  const write = insertSiteEvent(db, event).catch((error: unknown) => {
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
