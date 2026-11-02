import { describe, expect, it } from "vitest";
import legacyV2 from "../fixtures/contract-v2.json";
import legacyV3 from "../fixtures/contract-v3.json";
import legacyV4 from "../fixtures/contract-v4.json";
import legacyV5 from "../fixtures/contract-v5.json";
import legacyV6 from "../fixtures/contract-v6.json";
import legacyV7 from "../fixtures/contract-v7.json";
import legacyV8 from "../fixtures/contract-v8.json";
import legacyV9 from "../fixtures/contract-v9.json";
import fixture from "../fixtures/contract-v10.json";
import {
  ANALYTICS_CONTRACT_REVISION,
  eventContractViolation,
  type PrivacyLevel,
} from "./eventContract";

describe("desktop contract v10 conformance", () => {
  it("accepts every generated desktop event from revision 2 through 10", () => {
    expect(fixture.contractRevision).toBe(ANALYTICS_CONTRACT_REVISION);
    for (const corpus of [
      legacyV2,
      legacyV3,
      legacyV4,
      legacyV5,
      legacyV6,
      legacyV7,
      legacyV8,
      legacyV9,
      fixture,
    ]) {
      for (const entry of corpus.cases)
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

  it("rejects malformed values and insufficient consent for every event", () => {
    for (const entry of fixture.cases) {
      const event = {
        ...entry,
        privacyLevel: entry.privacyLevel as PrivacyLevel,
        consentLevel: entry.consentLevel as PrivacyLevel,
      };
      expect(
        eventContractViolation({
          ...event,
          properties: { ...event.properties, raw: { value: "private" } },
        }),
        entry.case,
      ).not.toBeNull();
      if (event.privacyLevel !== "essential") {
        expect(eventContractViolation({ ...event, consentLevel: "essential" })).not.toBeNull();
      }
    }
  });
});
