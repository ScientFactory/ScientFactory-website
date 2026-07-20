// FILE: identity.ts
// Purpose: Resolve consent-aware first-party website identity without browser fingerprinting.
// Layer: Cloudflare Pages Function utility

export const ANALYTICS_NOTICE_VERSION = "2026-07-identity-v1";
export const ANALYTICS_CONSENT_COOKIE = "sf_analytics";
export const ANALYTICS_VISITOR_COOKIE = "sf_visitor";
export const ANALYTICS_SESSION_COOKIE = "sf_session";

export type WebsiteConsentLevel = "essential" | "product";

export interface WebsiteIdentity {
  readonly identityId: string;
  readonly identityType: "web_visitor";
  readonly canonicalId: string;
  readonly consentLevel: "product";
}

const VISITOR_ID_PATTERN =
  /^visitor:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN =
  /^session:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cookieMap(request: Request): ReadonlyMap<string, string> {
  const entries = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part): ReadonlyArray<readonly [string, string]> => {
      const separator = part.indexOf("=");
      if (separator < 1) return [];
      const key = part.slice(0, separator);
      const value = part.slice(separator + 1);
      try {
        return [[key, decodeURIComponent(value)]];
      } catch {
        return [];
      }
    });
  return new Map(entries);
}

export function websiteConsentLevel(request: Request): WebsiteConsentLevel | null {
  const value = cookieMap(request).get(ANALYTICS_CONSENT_COOKIE);
  return value === "essential" || value === "product" ? value : null;
}

export function websiteIdentity(request: Request): WebsiteIdentity | null {
  if (websiteConsentLevel(request) !== "product") return null;
  const identityId = cookieMap(request).get(ANALYTICS_VISITOR_COOKIE);
  if (!identityId || !VISITOR_ID_PATTERN.test(identityId)) return null;
  return {
    identityId,
    identityType: "web_visitor",
    canonicalId: identityId,
    consentLevel: "product",
  };
}

export function cleanSessionId(value: string | null | undefined): string | null {
  return value && SESSION_ID_PATTERN.test(value) ? value : null;
}

export function websiteSessionId(request: Request): string | null {
  return cleanSessionId(cookieMap(request).get(ANALYTICS_SESSION_COOKIE));
}

export function newVisitorId(): string {
  return `visitor:${crypto.randomUUID()}`;
}

function secureCookie(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}

export function consentCookies(
  request: Request,
  level: WebsiteConsentLevel,
  visitorId?: string,
): ReadonlyArray<string> {
  const common = `Path=/; Max-Age=${180 * 24 * 60 * 60}; SameSite=Lax${secureCookie(request)}`;
  const cookies = [`${ANALYTICS_CONSENT_COOKIE}=${level}; ${common}`];
  if (level === "product" && visitorId) {
    cookies.push(`${ANALYTICS_VISITOR_COOKIE}=${visitorId}; ${common}; HttpOnly`);
  } else {
    cookies.push(
      `${ANALYTICS_VISITOR_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secureCookie(request)}; HttpOnly`,
    );
  }
  return cookies;
}

export async function persistWebsiteConsent(
  database: D1Database,
  level: WebsiteConsentLevel,
  recordedAt: string,
  identityId: string | null,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (identityId) {
    statements.push(
      database
        .prepare(
          `INSERT INTO analytics_identities (
             identity_id, identity_type, canonical_id, consent_level, first_seen_at, last_seen_at
           ) VALUES (?, 'web_visitor', ?, ?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET
             consent_level = excluded.consent_level,
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(identityId, identityId, level, recordedAt, recordedAt),
    );
  }
  statements.push(
    database
      .prepare(
        `INSERT INTO analytics_consents (
           consent_id, identity_id, source, consent_level, notice_version, recorded_at
         ) VALUES (?, ?, 'website', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), identityId, level, ANALYTICS_NOTICE_VERSION, recordedAt),
  );
  await database.batch(statements);
}
