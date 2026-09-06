import { describe, expect, it } from "vitest";
import { comparePipeline, reconciliationQueries } from "./analytics-reconciliation.mjs";

describe("analytics reconciliation", () => {
  it("uses a shared bounded source/time window and deduplicated capture IDs", () => {
    const query = reconciliationQueries({ from: "2026-08-20", to: "2026-08-27" });
    for (const sql of [query.d1, query.posthog]) {
      expect(sql).toContain("desktop");
      expect(sql).toContain("2026-08-20T00:00:00.000Z");
      expect(sql).toContain("2026-08-27T00:00:00.000Z");
    }
    expect(query.posthog).toContain("uniqExact(properties.event_id)");
    expect(query.d1).toContain("privacy_level <> 'diagnostic'");
    expect(query.posthog).toContain("coalesce(properties.privacy_level, '') != 'diagnostic'");
    expect(() =>
      reconciliationQueries({ source: "desktop' OR 1=1", from: "2026-08-20", to: "2026-08-27" }),
    ).toThrow();
    expect(() => reconciliationQueries({ from: "2026-01-01", to: "2026-08-27" })).toThrow();
  });
  it("does not call empty, pending or deletion-affected populations healthy", () => {
    const rows = [{ event_name: "app.health", posthog_state: "sent", event_count: 2 }];
    expect(comparePipeline([], []).status).toBe("no-data");
    expect(comparePipeline([], [], 1).status).toBe("unsettled");
    expect(comparePipeline(rows, [["app.health", 2]]).status).toBe("matched");
    expect(comparePipeline(rows, [["app.health", 1]]).status).toBe("mismatch");
    expect(comparePipeline(rows, [["app.health", 2]], 1).status).toBe("unsettled");
    expect(
      comparePipeline(
        [...rows, { event_name: "app.health", posthog_state: "pending", event_count: 1 }],
        [["app.health", 2]],
      ).status,
    ).toBe("unsettled");
  });
});
