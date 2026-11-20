// FILE: visitSource.ts
// Purpose: Where a visit came from: the referring site's host and the link's campaign tags.
// Layer: Cloudflare Pages Function utility

import { cleanPath } from "./events";

export interface VisitSource {
  /** The referring site's host, without "www.", never its full address. */
  readonly referrerHost?: string | null;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly utmCampaign?: string | null;
  /** The first page of the visit on this site. */
  readonly landingPath?: string | null;
}

const HOST_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
// Campaign tags are short labels: no "/" or "@", so an address, a path or an email is dropped.
const TAG_PATTERN = /^[\p{L}\p{N} ._+\-|:]{1,100}$/u;

export function cleanReferrerHost(value: unknown, siteHost: string): string | null {
  if (typeof value !== "string") return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!HOST_PATTERN.test(host)) return null;
  if (host === siteHost.toLowerCase().replace(/^www\./, "")) return null;
  return host;
}

export function cleanCampaignTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim();
  if (!TAG_PATTERN.test(tag)) return null;
  return tag;
}

/** Reads a visit source from named values, keeping only what passes the checks above. */
export function visitSourceFrom(
  read: (
    name: "referrer_host" | "utm_source" | "utm_medium" | "utm_campaign" | "landing_path",
  ) => unknown,
  siteHost: string,
): VisitSource {
  const landing = read("landing_path");
  return {
    referrerHost: cleanReferrerHost(read("referrer_host"), siteHost),
    utmSource: cleanCampaignTag(read("utm_source")),
    utmMedium: cleanCampaignTag(read("utm_medium")),
    utmCampaign: cleanCampaignTag(read("utm_campaign")),
    landingPath: typeof landing === "string" ? cleanPath(landing) : null,
  };
}
