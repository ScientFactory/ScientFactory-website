#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { reconciliationQueries, comparePipeline } from "./analytics-reconciliation.mjs";
import { createPosthogApi } from "./posthog-api.mjs";

const PROJECT_ID = "228610";
const KEYCHAIN_SERVICE = "scient-posthog-personal-api-key";

function fail(message) {
  console.error(message);
  process.exit(1);
}

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

// Exclude the newest hour, where accepted captures may still be processing.
// A settled window is a reporting convention, not proof of completed deletion.
const until = process.env.ANALYTICS_RECONCILE_TO ?? new Date(Date.now() - 3600000).toISOString();
const queries = reconciliationQueries({
  source: process.env.ANALYTICS_RECONCILE_SOURCE ?? "desktop",
  from:
    process.env.ANALYTICS_RECONCILE_FROM ??
    new Date(Date.parse(until) - 7 * 86400000).toISOString(),
  to: until,
});
function queryD1(query) {
  const d1 = spawnSync(
    "wrangler",
    ["d1", "execute", "scientfactory-downloads", "--remote", "--json", "--command", query],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (d1.error) fail("Unable to run the bounded D1 query");
  if (d1.status !== 0) fail("D1 query failed; verify operator access and database availability");

  let d1Body;
  try {
    d1Body = JSON.parse(d1.stdout);
  } catch {
    fail("D1 returned an unreadable reconciliation response");
  }
  const d1Rows = d1Body?.[0]?.results;
  if (!Array.isArray(d1Rows)) fail("D1 reconciliation response has no result rows");
  return d1Rows;
}
const d1Rows = queryD1(queries.d1);
const deletionBacklog = queryD1(queries.backlog).reduce(
  (sum, row) => sum + Number(row.request_count),
  0,
);

const apiKey = personalApiKey();
if (!apiKey) {
  fail(
    `PostHog personal API key unavailable. Set POSTHOG_PERSONAL_API_KEY or add macOS Keychain service '${KEYCHAIN_SERVICE}'.`,
  );
}
const api = createPosthogApi({ apiKey, projectId: PROJECT_ID });
const posthogBody = await api("query/", {
  method: "POST",
  body: JSON.stringify({
    query: {
      kind: "HogQLQuery",
      query: queries.posthog,
    },
  }),
});
if (!Array.isArray(posthogBody.results)) fail("PostHog returned no reconciliation rows");

const report = comparePipeline(d1Rows, posthogBody.results, deletionBacklog);
console.log(`${queries.source}: [${queries.from}, ${queries.to}) — event-ID counts`);
console.table(report.rows);
console.log(`Result: ${report.status}. Outstanding deletions: ${report.deletionBacklog}.`);
console.log(
  "Identity-link events are intentionally excluded. No data does not mean the pipeline is verified.",
);
if (report.status !== "matched") process.exitCode = 2;
