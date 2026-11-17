import { expect, it, vi } from "vitest";

import { webObservationStatement } from "./analyticsPeople";

function sightingReferrer(sourceHost: string | null) {
  const bind = vi.fn((..._values: unknown[]) => ({}));
  const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;
  const request = new Request("https://scientfactory.com/api/events", {
    headers: { "CF-Connecting-IP": "192.0.2.10", Referer: "https://scientfactory.com/about/" },
  });
  webObservationStatement(
    db,
    "e1",
    "page_viewed",
    "2026-11-17T00:00:00Z",
    "v1",
    request,
    sourceHost,
  );
  return bind.mock.calls[0]?.[5];
}

it("records the visit's source, never this website's own page, as the referrer", () => {
  expect(sightingReferrer(null)).toBeNull();
  expect(sightingReferrer("google.com")).toBe("google.com");
});
