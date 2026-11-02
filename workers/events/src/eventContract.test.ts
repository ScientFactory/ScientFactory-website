import { describe, expect, it } from "vitest";

import { eventContractViolation } from "./eventContract";

const base = {
  name: "provider.request.completed",
  privacyLevel: "product",
  consentLevel: "product",
  properties: {
    appVersion: "0.6.8",
    buildChannel: "stable",
    contractRevision: "10",
  },
} as const;

describe("desktop event contract", () => {
  it("accepts any event and field of a valid shape, as T3 does", () => {
    expect(eventContractViolation(base)).toBeNull();
    expect(
      eventContractViolation({
        ...base,
        name: "chatgpt.sign_in.completed",
        properties: {
          ...base.properties,
          serviceTier: "fast",
          inputTokens: 1200,
          ratio: 0.25,
          fastMode: true,
          tags: ["a", "b", 3, false],
        },
      }),
    ).toBeNull();
  });

  it("allows higher consent for a lower-level event and refuses lower consent", () => {
    expect(eventContractViolation({ ...base, consentLevel: "diagnostic" })).toBeNull();
    expect(eventContractViolation({ ...base, consentLevel: "essential" })).toBe(
      "Consent level 'essential' does not allow event 'provider.request.completed'",
    );
  });

  it("rejects events whose shape or size is wrong", () => {
    const withProperty = (key: string, value: unknown) =>
      eventContractViolation({
        ...base,
        properties: { ...base.properties, [key]: value },
      });
    expect(eventContractViolation({ ...base, name: "Not An Event" })).toBe(
      "Invalid event name 'Not An Event'",
    );
    expect(withProperty("nested", { raw: "private" })).toBe("Invalid event property 'nested'");
    expect(withProperty("missing", null)).toBe("Invalid event property 'missing'");
    expect(withProperty("notFinite", Number.POSITIVE_INFINITY)).toBe(
      "Invalid event property 'notFinite'",
    );
    expect(withProperty("long", "x".repeat(257))).toBe("Invalid event property 'long'");
    expect(
      withProperty(
        "list",
        Array.from({ length: 33 }, () => 1),
      ),
    ).toBe("Invalid event property 'list'");
    expect(withProperty("$set", "x")).toBe("Invalid event property name '$set'");
    expect(
      eventContractViolation({
        ...base,
        properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])),
      }),
    ).toBe("Too many event properties");
    expect(
      eventContractViolation({
        ...base,
        properties: Object.fromEntries(
          Array.from({ length: 64 }, (_, i) => [`k${i}`, "y".repeat(256)]),
        ),
      }),
    ).toBe("Event properties are too large");
  });
});
