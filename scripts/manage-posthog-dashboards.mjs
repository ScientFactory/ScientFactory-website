#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { dashboards } from "./posthog-dashboard-manifest.mjs";

const PROJECT_ID = "228610";
const API_ORIGIN = "https://eu.posthog.com";
const KEYCHAIN_SERVICE = "scient-posthog-personal-api-key";
const apply = process.argv.includes("--apply-ready");
const validateQueries = process.argv.includes("--validate-queries");

function personalApiKey() {
  if (process.env.POSTHOG_PERSONAL_API_KEY) return process.env.POSTHOG_PERSONAL_API_KEY;
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const apiKey = personalApiKey();
if (!apiKey) {
  console.error(
    `PostHog personal API key unavailable. Set POSTHOG_PERSONAL_API_KEY or add macOS Keychain service '${KEYCHAIN_SERVICE}'.`,
  );
  process.exit(1);
}

async function api(path, init = {}) {
  const url = path.startsWith("https://")
    ? path
    : `${API_ORIGIN}/api/projects/${PROJECT_ID}/${path}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (response.ok) return response.json();
    const message = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      continue;
    }
    throw new Error(
      `PostHog ${init.method ?? "GET"} ${path} failed (${response.status}): ${message}`,
    );
  }
  throw new Error(`PostHog ${init.method ?? "GET"} ${path} exhausted retries`);
}

async function observedEvents() {
  const response = await api("query/", {
    method: "POST",
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: "SELECT event, count() FROM events GROUP BY event ORDER BY event",
      },
    }),
  });
  return new Map(response.results.map(([name, count]) => [String(name), Number(count)]));
}

async function allPages(path) {
  const results = [];
  let next = `${path}${path.includes("?") ? "&" : "?"}limit=100`;
  while (next) {
    const page = await api(next);
    results.push(...page.results);
    next = page.next ?? "";
  }
  return results;
}

async function ensureDashboard(definition, existingDashboards, existingInsights) {
  const acceptedNames = new Set([definition.name, ...(definition.aliases ?? [])]);
  let dashboard = existingDashboards.find((candidate) => acceptedNames.has(candidate.name));
  if (!dashboard) {
    dashboard = await api("dashboards/", {
      method: "POST",
      body: JSON.stringify({
        name: definition.name,
        description: definition.description,
        tags: ["scient-managed", "analytics-contract-v1"],
      }),
    });
    console.log(`created dashboard: ${definition.name}`);
  } else {
    dashboard = await api(`dashboards/${dashboard.id}/`, {
      method: "PATCH",
      body: JSON.stringify({
        name: definition.name,
        description: definition.description,
        tags: ["scient-managed", "analytics-contract-v1"],
      }),
    });
    console.log(`updated dashboard: ${definition.name}`);
  }

  for (const insightDefinition of definition.insights ?? []) {
    const existing = existingInsights.find(
      (candidate) =>
        candidate.name === insightDefinition.name && candidate.tags?.includes("scient-managed"),
    );
    const currentDashboards = existing?.dashboards ?? [];
    const payload = {
      name: insightDefinition.name,
      description: insightDefinition.description,
      query: insightDefinition.query,
      dashboards: [...new Set([...currentDashboards, dashboard.id])],
      tags: ["scient-managed", `scient-dashboard-${definition.key}`],
    };
    if (existing) {
      const updated = await api(`insights/${existing.id}/`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      Object.assign(existing, updated);
      console.log(`updated insight: ${insightDefinition.name}`);
    } else {
      const created = await api("insights/", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      existingInsights.push(created);
      console.log(`created insight: ${insightDefinition.name}`);
    }
  }
}

const observed = await observedEvents();
const readiness = dashboards.map((dashboard) => {
  const missing = dashboard.requiredEvents.filter((name) => !observed.has(name));
  return {
    dashboard,
    missing,
    ready: dashboard.phase === "current" && missing.length === 0,
  };
});

for (const { dashboard, missing, ready } of readiness) {
  const state = ready ? "READY" : dashboard.phase === "planned" ? "PLANNED" : "BLOCKED";
  console.log(`${state.padEnd(7)} ${dashboard.name}`);
  if (missing.length > 0) console.log(`        missing events: ${missing.join(", ")}`);
}

if (validateQueries) {
  for (const { dashboard } of readiness) {
    for (const insight of dashboard.insights ?? []) {
      await api("query/", {
        method: "POST",
        body: JSON.stringify({ query: insight.query }),
      });
      console.log(`valid    ${dashboard.key}: ${insight.name}`);
    }
  }
}

if (!apply) {
  console.log(
    "\nRead-only check complete. Use --validate-queries to execute definitions read-only or --apply-ready to update only READY dashboards.",
  );
  process.exit(0);
}

const [existingDashboards, existingInsights] = await Promise.all([
  allPages("dashboards/"),
  allPages("insights/"),
]);
for (const item of readiness.filter((candidate) => candidate.ready)) {
  await ensureDashboard(item.dashboard, existingDashboards, existingInsights);
}
