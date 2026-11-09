// Generated from scient-desktop/packages/scient-analytics/src/wireContract.ts. Do not edit here.
// Shared desktop/gateway shape and privacy guard; event and property names are open.
// Only install.account_observed may carry an email, in its validated email property.
export const ANALYTICS_CONTRACT_REVISION = "11" as const;
export const PRIVACY_LEVELS = ["essential", "product", "diagnostic", "contribution"] as const;

export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;
export const PROPERTY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_EVENT_PROPERTIES = 64;
export const MAX_EVENT_PROPERTIES_BYTES = 16 * 1024;
export const MAX_STRING_PROPERTY_LENGTH = 256;
export const MAX_ARRAY_PROPERTY_ITEMS = 32;

export type WirePrimitive = string | number | boolean;
export type WireValue = WirePrimitive | ReadonlyArray<WirePrimitive>;

// Keys that hold free text in T3's and Scient's code. They are never sent, whatever their value.
const CONTENT_KEYS = new Set([
  "prompt",
  "message",
  "text",
  "content",
  "input",
  "output",
  "error",
  "errormessage",
  "stack",
  "path",
  "cwd",
  "url",
  "email",
  "title",
  "query",
]);
export function isContentKey(key: string): boolean {
  return CONTENT_KEYS.has(key.toLowerCase());
}

const PATH_PATTERN = /^(?:~|\.{1,2})?[\\/]|^[A-Za-z]:[\\/]|[\\/](?:Users|home)[\\/]/u;
const URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^(?:file|mailto|data):/u;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/u;

/** Strings that look like a path, link or email address never leave the machine. */
export function isPrivateLooking(value: string): boolean {
  return PATH_PATTERN.test(value) || URL_PATTERN.test(value) || EMAIL_PATTERN.test(value);
}

/** The gateway keeps these in its own tables and never exports them with usage events. */
export const IDENTITY_EVENT_NAMES: ReadonlySet<string> = new Set([
  "install.account_observed",
  "install.profile_observed",
]);
export const ACCOUNT_EMAIL_PATTERN = /^[^\s@/\\:]{1,128}@[A-Za-z0-9.-]{1,120}\.[A-Za-z]{2,24}$/u;

/** Only an account event may carry an email address, and only as its `email`. */
export function isAllowedAccountEmail(eventName: string, key: string, value: unknown): boolean {
  return (
    eventName === "install.account_observed" &&
    key === "email" &&
    typeof value === "string" &&
    ACCOUNT_EMAIL_PATTERN.test(value)
  );
}

const PRIVACY_RANK: Readonly<Record<PrivacyLevel, number>> = {
  essential: 0,
  product: 1,
  diagnostic: 2,
  contribution: 3,
};

export function isWirePrimitive(value: unknown): value is WirePrimitive {
  if (typeof value === "string") return value.length <= MAX_STRING_PROPERTY_LENGTH;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "boolean";
}

export function isWireValue(value: unknown): value is WireValue {
  return Array.isArray(value)
    ? value.length <= MAX_ARRAY_PROPERTY_ITEMS && value.every(isWirePrimitive)
    : isWirePrimitive(value);
}

export function eventContractViolation(input: {
  readonly name: string;
  readonly privacyLevel: PrivacyLevel;
  readonly consentLevel: PrivacyLevel;
  readonly properties: Readonly<Record<string, unknown>>;
}): string | null {
  if (!EVENT_NAME_PATTERN.test(input.name)) return `Invalid event name '${input.name}'`;
  if (!PRIVACY_LEVELS.includes(input.privacyLevel)) return "Invalid privacy level";
  if (!PRIVACY_LEVELS.includes(input.consentLevel)) return "Invalid consent level";
  if (PRIVACY_RANK[input.consentLevel] < PRIVACY_RANK[input.privacyLevel]) {
    return `Consent level '${input.consentLevel}' does not allow event '${input.name}'`;
  }
  const keys = Object.keys(input.properties);
  if (keys.length > MAX_EVENT_PROPERTIES) return "Too many event properties";
  for (const key of keys) {
    if (!PROPERTY_KEY_PATTERN.test(key)) return `Invalid event property name '${key}'`;
    const value = input.properties[key];
    if (!isWireValue(value)) return `Invalid event property '${key}'`;
    if (isAllowedAccountEmail(input.name, key, value)) continue;
    // Free text, paths, links and email addresses never leave the machine.
    if (isContentKey(key)) return `Private event property '${key}'`;
    const values: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value];
    if (values.some((item) => typeof item === "string" && isPrivateLooking(item)))
      return `Private value in event property '${key}'`;
  }
  if (
    new TextEncoder().encode(JSON.stringify(input.properties)).byteLength >
    MAX_EVENT_PROPERTIES_BYTES
  ) {
    return "Event properties are too large";
  }
  return null;
}
