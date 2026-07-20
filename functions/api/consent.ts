// FILE: consent.ts
// Purpose: Persist the visitor's website analytics choice and issue first-party cookies.
// Layer: Cloudflare Pages Function

import {
  consentCookies,
  newVisitorId,
  persistWebsiteConsent,
  websiteIdentity,
  type WebsiteConsentLevel,
} from "../_lib/identity";
import { shouldPersistSiteEvents } from "../_lib/events";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function response(body: unknown, status = 200, cookies: ReadonlyArray<string> = []): Response {
  const headers = new Headers(RESPONSE_HEADERS);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers });
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && origin === new URL(request.url).origin;
}

export const onRequestPost: PagesFunction<Cloudflare.Env> = async (context) => {
  if (!isSameOrigin(context.request)) return response({ error: "Forbidden" }, 403);
  if (!context.request.headers.get("Content-Type")?.startsWith("application/json")) {
    return response({ error: "Content-Type must be application/json" }, 415);
  }

  let level: WebsiteConsentLevel;
  try {
    const body = (await context.request.json()) as { level?: unknown };
    if (body.level !== "essential" && body.level !== "product") {
      return response({ error: "Invalid consent level" }, 400);
    }
    level = body.level;
  } catch {
    return response({ error: "Invalid JSON" }, 400);
  }

  const existing = websiteIdentity(context.request)?.identityId;
  const visitorId = level === "product" ? (existing ?? newVisitorId()) : null;
  const consentIdentityId = visitorId ?? existing ?? null;
  const recordedAt = new Date().toISOString();
  if (shouldPersistSiteEvents(context.request)) {
    if (!context.env.DOWNLOAD_DB) return response({ error: "Analytics storage unavailable" }, 503);
    await persistWebsiteConsent(context.env.DOWNLOAD_DB, level, recordedAt, consentIdentityId);
  }

  return response({ level }, 200, consentCookies(context.request, level, visitorId ?? undefined));
};
