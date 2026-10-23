import { expect, it } from "vitest";
import { testDatabase } from "../workers/events/src/sqlite.testSupport.ts";
import { productInsightsQuery, productInsightsQueries } from "./product-insights.mjs";

it("reports named-agent submissions, install availability and install completions without dev traffic or outcome inflation", () => {
  const store = testDatabase();
  try {
    const insert = store.sqlite.prepare(
      "INSERT INTO analytics_events (event_id,event_name,source,privacy_level,consent_level,occurred_at,distinct_id,properties_json) VALUES (?,?,'desktop','product','product',?,?,?)",
    );
    let id = 0;
    const add = (
      event,
      properties,
      {
        installation = "PRIVATE-A",
        at = "2026-09-05T10:00:00Z",
        channel = "stable",
        revision = "7",
      } = {},
    ) =>
      insert.run(
        String(++id),
        event,
        at,
        installation,
        JSON.stringify({
          contractRevision: revision,
          buildChannel: channel,
          ...properties,
        }),
      );
    for (const provider of ["scient", "omp", "muse", "acpRegistry"]) {
      add("provider.turn.sent", { provider });
      add("provider.turn.sent", { provider }, { installation: "PRIVATE-B", channel: "beta" });
      add("provider.turn.completed", { provider });
      add("provider.turn.usage", { provider, usageStatus: "unavailable", modelKey: "other" });
      add("provider.turn.sent", { provider }, { channel: "development" });
      add("provider.turn.sent", { provider }, { channel: "unknown" });
      add("provider.turn.sent", { provider }, { at: "2026-09-06T00:00:00Z" });
      add("provider.installation.observed", { provider, installed: true });
      add(
        "provider.installation.changed",
        { provider, toInstalled: false },
        { at: "2026-09-05T11:00:00Z" },
      );
      add(
        "provider.installation.observed",
        { provider, installed: true },
        { installation: "PRIVATE-B" },
      );
      add("provider.lifecycle.completed", { provider, action: "install" });
      add("provider.lifecycle.completed", { provider, action: "repair" });
    }
    add("feature.viewed", { feature: "latex-visual" }, { revision: "6" });
    const rows = store.sqlite
      .prepare(productInsightsQuery.replaceAll("'now'", "'2026-09-06'"))
      .all();
    for (const size of [1, 2, 4]) {
      const queries = productInsightsQueries(size);
      expect(queries.every((query) => query.split("UNION ALL").length <= size)).toBe(true);
      const batched = queries.flatMap((query) =>
        store.sqlite.prepare(query.replaceAll("'now'", "'2026-09-06'")).all(),
      );
      expect(batched.map((row) => JSON.stringify(row)).sort()).toEqual(
        rows.map((row) => JSON.stringify(row)).sort(),
      );
    }
    for (const provider of ["scient", "omp", "muse", "acpRegistry"]) {
      expect(
        rows.find((r) => r.metric === "provider_submitted_prompts" && r.category === provider),
      ).toMatchObject({ installations: 2, observations: 2 });
      expect(
        rows.find(
          (r) =>
            r.metric === "provider_daily_submitted_prompts" &&
            r.category === provider + ":2026-09-05",
        ),
      ).toMatchObject({ installations: 2, observations: 2 });
      expect(
        rows.find(
          (r) => r.metric === "provider_latest_observed_installed" && r.category === provider,
        ),
      ).toMatchObject({ installations: 1, observations: 1 });
      expect(
        rows.find((r) => r.metric === "provider_install_completions" && r.category === provider),
      ).toMatchObject({ installations: 1, observations: 1 });
    }
    expect(
      rows.find(
        (r) => r.metric === "feature_observations" && r.category === "feature.viewed:latex-visual",
      ),
    ).toMatchObject({ installations: 1, observations: 1 });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  } finally {
    store.close();
  }
});

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
        JSON.stringify({ contractRevision: revision, buildChannel: "stable", ...props }),
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
    add("provider.turn.usage", {
      provider: "pi",
      modelKey: "other",
      usageStatus: "unavailable",
    });
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
      expect.objectContaining({
        category: "pi",
        installations: 1,
        observations: 1,
      }),
    ]);
    expect(rows.find((r) => r.metric === "provider_terminal_outcomes")).toMatchObject({
      observations: 1,
    });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  } finally {
    store.close();
  }
});

it("counts revision 5 events, which name every settings page", () => {
  const store = testDatabase();
  try {
    const insert = store.sqlite.prepare(
      `INSERT INTO analytics_events (event_id, event_name, source, privacy_level, consent_level, occurred_at, distinct_id, properties_json) VALUES (?, ?, 'desktop', 'product', 'product', ?, 'PRIVATE', ?)`,
    );
    insert.run(
      "1",
      "settings.viewed",
      "2026-09-04",
      JSON.stringify({ contractRevision: "5", buildChannel: "stable", section: "documents" }),
    );
    insert.run(
      "2",
      "settings.viewed",
      "2026-09-05",
      JSON.stringify({ contractRevision: "5", buildChannel: "stable", section: "documents" }),
    );
    insert.run(
      "3",
      "provider.installation.observed",
      "2026-09-05T09:00:00Z",
      JSON.stringify({
        contractRevision: "5",
        buildChannel: "stable",
        provider: "codex",
        installed: true,
      }),
    );
    const rows = store.sqlite
      .prepare(productInsightsQuery.replaceAll("'now'", "'2026-09-06'"))
      .all();
    expect(
      rows.find(
        (r) => r.metric === "feature_observations" && r.category === "settings.viewed:documents",
      ),
    ).toMatchObject({
      installations: 1,
      observations: 2,
      repeat_installations: 1,
    });
    expect(rows.filter((r) => r.metric === "provider_latest_observed_installed")).toEqual([
      expect.objectContaining({ category: "codex", installations: 1 }),
    ]);
    expect(rows.find((r) => r.metric === "observed_product_population")).toMatchObject({
      category: "revision-3-to-7",
      installations: 1,
    });
  } finally {
    store.close();
  }
});
