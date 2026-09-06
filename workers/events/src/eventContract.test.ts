import { describe, expect, it } from "vitest";

import { EVENT_DEFINITIONS, eventContractViolation } from "./eventContract";

describe("desktop event contract", () => {
  it("keeps the revision-two registry deliberately bounded", () => {
    expect(Object.keys(EVENT_DEFINITIONS)).toHaveLength(45);
  });

  it("accepts the no-op outcome only with sufficient consent and bounded properties", () => {
    const event = {
      name: "scient.operation.skipped",
      privacyLevel: "product",
      consentLevel: "product",
      properties: {
        appVersion: "0.6.8",
        buildChannel: "development",
        operationKind: "source-import",
      },
    } as const;
    expect(eventContractViolation(event)).toBeNull();
    expect(eventContractViolation({ ...event, consentLevel: "essential" })).not.toBeNull();
    expect(
      eventContractViolation({ ...event, properties: { ...event.properties, title: "PRIVATE" } }),
    ).not.toBeNull();
  });

  it("allows higher consent for a lower-level event", () => {
    expect(
      eventContractViolation({
        name: "project.initialization.failed",
        privacyLevel: "essential",
        consentLevel: "diagnostic",
        properties: {
          appVersion: "0.0.32",
          buildChannel: "development",
          failureClass: "filesystem",
        },
      }),
    ).toBeNull();
  });

  it("rejects raw model identifiers instead of accepting arbitrary strings", () => {
    expect(
      eventContractViolation({
        name: "provider.turn.sent",
        privacyLevel: "product",
        consentLevel: "product",
        properties: {
          appVersion: "0.0.32",
          buildChannel: "development",
          provider: "codex",
          modelFamily: "gpt-user-custom-name",
          modelKey: "other",
          interactionMode: "default",
          runtimeMode: "full-access",
          attachmentCountBucket: "0",
          hasInput: true,
        },
      }),
    ).toBe("Invalid event property 'modelFamily'");
  });

  it("requires every non-optional property", () => {
    expect(
      eventContractViolation({
        name: "app.session.started",
        privacyLevel: "essential",
        consentLevel: "essential",
        properties: {
          appVersion: "1.0.0",
          buildChannel: "stable",
          platform: "macos",
        },
      }),
    ).toBe("Missing event property 'architecture'");
  });
});
