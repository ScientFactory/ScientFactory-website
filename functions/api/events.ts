// FILE: events.ts
// Purpose: Accepts the two anonymous browser-originated website events.
// Layer: Cloudflare Pages Function

import { cleanPath, destinationParts, queueSiteEvent, type SiteEvent } from "../_lib/events";

const MAX_BODY_BYTES = 4096;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: RESPONSE_HEADERS });
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClientEvent(body: unknown, request: Request): SiteEvent | null {
  if (!isRecord(body)) return null;
  const pagePath = typeof body.page_path === "string" ? cleanPath(body.page_path) : null;
  if (!pagePath) return null;

  if (body.event_name === "page_viewed") {
    return { eventName: "page_viewed", pagePath };
  }

  if (body.event_name === "outbound_link_clicked") {
    if (typeof body.destination_url !== "string") return null;
    const destination = destinationParts(body.destination_url, new URL(request.url).origin);
    if (!destination) return null;
    return {
      eventName: "outbound_link_clicked",
      pagePath,
      ...destination,
    };
  }

  return null;
}

export const onRequestPost: PagesFunction<Cloudflare.Env> = async (context) => {
  if (!isSameOriginRequest(context.request)) {
    return errorResponse("This endpoint only accepts same-origin events.", 403);
  }

  const declaredSize = Number(context.request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    return errorResponse("Event payload is too large.", 413);
  }

  let body: unknown;
  try {
    const raw = await context.request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return errorResponse("Event payload is too large.", 413);
    }
    body = JSON.parse(raw) as unknown;
  } catch {
    return errorResponse("Event payload must be valid JSON.", 400);
  }

  const event = parseClientEvent(body, context.request);
  if (!event) return errorResponse("Event payload is invalid.", 400);

  queueSiteEvent(context, event);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
};
