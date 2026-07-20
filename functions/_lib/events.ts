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
  INSERT INTO site_events (
    event_name,
    page_path,
    asset_key,
    release_tag,
    asset_name,
    destination_host,
    destination_path,
    failure_stage,
    failure_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  await db
    .prepare(INSERT_EVENT)
    .bind(
      event.eventName,
      cleanPath(event.pagePath),
      limited(event.assetKey, 64),
      limited(event.releaseTag, 80),
      limited(event.assetName, 255),
      limited(event.destinationHost, 253),
      cleanPath(event.destinationPath),
      limited(event.failureStage, 80),
      limited(event.failureReason, 120),
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
