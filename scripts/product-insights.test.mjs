import { expect, it } from "vitest";
import { testDatabase } from "../workers/events/src/sqlite.testSupport.ts";
import { productInsightsQuery } from "./product-insights.mjs";

it("separates adoption, latest installation state, unknown tokens and failure populations", () => {
  const store = testDatabase();
  try {
    const insert = store.sqlite.prepare(
      `INSERT INTO analytics_events (event_id, event_name, source, privacy_level, consent_level, occurred_at, distinct_id, properties_json) VALUES (?, ?, 'desktop', 'product', ?, ?, ?, ?)`,
    );
    let id = 0;
    const add = (
      name,
      props,
      { consent = "product", day = "2026-09-05", installation = "PRIVATE", revision = "3" } = {},
    ) =>
      insert.run(
        String(++id),
        name,
        consent,
        day,
        installation,
        JSON.stringify({ contractRevision: revision, ...props }),
      );
    add("panel.viewed", { category: "browser" });
    add("panel.viewed", { category: "browser" });
    add("panel.viewed", { category: "browser" }, { day: "2026-09-04" });
    add("panel.viewed", { category: "browser" }, { consent: "essential" });
    add("panel.viewed", { category: "browser" }, { revision: "2" });
    add("panel.viewed", { category: "browser" }, { day: "2026-09-06" });
    add(
      "provider.installation.observed",
      { provider: "codex", installed: true },
      { revision: "4", day: "2026-09-05T09:00:00Z" },
    );
    add(
      "provider.installation.changed",
      { provider: "codex", fromInstalled: true, toInstalled: false },
      { revision: "4", day: "2026-09-05T10:00:00Z" },
    );
    add(
      "provider.installation.observed",
      { provider: "pi", installed: false },
      { revision: "4", installation: "PRIVATE-2", day: "2026-09-05T09:00:00Z" },
    );
    add(
      "provider.installation.changed",
      { provider: "pi", fromInstalled: false, toInstalled: true },
      { revision: "4", installation: "PRIVATE-2", day: "2026-09-05T10:00:00Z" },
    );
    // Legacy readiness is not treated as an explicit current installation.
    add("provider.discovered", { provider: "grok", state: "ready" });
    add("provider.turn.usage", {
      provider: "codex",
      modelKey: "gpt-5.6-sol",
      usageStatus: "complete",
      inputTokens: 100,
      outputTokens: 50,
    });
    add("provider.turn.usage", {
      provider: "codex",
      modelKey: "unknown",
      usageStatus: "unavailable",
    });
    add("provider.turn.usage", { provider: "pi", modelKey: "other", usageStatus: "unavailable" });
    add("provider.turn.failed", { provider: "codex" });
    add("provider.turn.failed", { provider: "codex" }, { consent: "essential" });
    const rows = store.sqlite
      .prepare(productInsightsQuery.replaceAll("'now'", "'2026-09-06'"))
      .all();
    expect(rows.find((r) => r.metric === "feature_observations")).toMatchObject({
      installations: 1,
      observations: 3,
      repeat_installations: 1,
    });
    expect(
      rows.find((r) => r.metric === "reported_input_tokens" && r.category === "codex"),
    ).toMatchObject({ observations: 1, value: 100 });
    expect(
      rows.find((r) => r.metric === "reported_input_tokens" && r.category === "pi"),
    ).toMatchObject({ observations: 0, value: null });
    expect(rows.filter((r) => r.metric === "provider_latest_observed_installed")).toEqual([
      expect.objectContaining({ category: "pi", installations: 1, observations: 1 }),
    ]);
    expect(rows.find((r) => r.metric === "provider_terminal_outcomes")).toMatchObject({
      observations: 1,
    });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  } finally {
    store.close();
  }
});
