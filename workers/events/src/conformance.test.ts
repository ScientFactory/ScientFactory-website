import { describe, expect, it } from "vitest";
import fixture from "../fixtures/contract-v2.json";
import { eventContractViolation, EVENT_DEFINITIONS, type PrivacyLevel } from "./eventContract";

describe("desktop contract v2 conformance", () => {
  it("accepts every generated desktop event including unknown-value fallbacks", () => {
    expect(fixture.contractRevision).toBe("2");
    expect(new Set(fixture.cases.map((entry) => entry.name))).toEqual(
      new Set(Object.keys(EVENT_DEFINITIONS)),
    );
    for (const entry of fixture.cases) {
      expect(
        eventContractViolation({
          ...entry,
          privacyLevel: entry.privacyLevel as PrivacyLevel,
          consentLevel: entry.consentLevel as PrivacyLevel,
        }),
        entry.case,
      ).toBeNull();
    }
  });

  it("rejects unknown properties, malformed values, and insufficient consent for every event", () => {
    for (const entry of fixture.cases) {
      const event = {
        ...entry,
        privacyLevel: entry.privacyLevel as PrivacyLevel,
        consentLevel: entry.consentLevel as PrivacyLevel,
      };
      expect(
        eventContractViolation({
          ...event,
          properties: { ...event.properties, path: "/private/fixture" },
        }),
      ).not.toBeNull();
      for (const key of Object.keys(event.properties)) {
        expect(
          eventContractViolation({
            ...event,
            properties: { ...event.properties, [key]: { raw: "private" } },
          }),
          `${entry.case}:${key}`,
        ).not.toBeNull();
      }
      if (event.privacyLevel !== "essential") {
        expect(eventContractViolation({ ...event, consentLevel: "essential" })).not.toBeNull();
      }
    }
  });
});
