#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

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

const d1Query = `
  SELECT event_name, posthog_state, COUNT(*) AS event_count
  FROM analytics_events
  GROUP BY event_name, posthog_state
  ORDER BY event_name, posthog_state
`;
const d1 = spawnSync(
  "wrangler",
  ["d1", "execute", "scientfactory-downloads", "--remote", "--json", "--command", d1Query],
  { encoding: "utf8" },
);
if (d1.error) fail(`Unable to query D1: ${d1.error.message}`);
if (d1.status !== 0) fail(`D1 query failed: ${d1.stderr.trim()}`);

let d1Body;
try {
  d1Body = JSON.parse(d1.stdout);
} catch {
  fail("D1 returned an unreadable reconciliation response");
}
const d1Rows = d1Body?.[0]?.results;
if (!Array.isArray(d1Rows)) fail("D1 reconciliation response has no result rows");

const apiKey = personalApiKey();
if (!apiKey) {
  fail(
    `PostHog personal API key unavailable. Set POSTHOG_PERSONAL_API_KEY or add macOS Keychain service '${KEYCHAIN_SERVICE}'.`,
  );
}
const response = await fetch(`https://eu.posthog.com/api/projects/${PROJECT_ID}/query/`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    query: {
      kind: "HogQLQuery",
      query: "SELECT event, count() FROM events GROUP BY event ORDER BY event",
    },
  }),
});
if (!response.ok) fail(`PostHog reconciliation query failed (${response.status})`);
const posthogBody = await response.json();
if (!Array.isArray(posthogBody.results)) fail("PostHog returned no reconciliation rows");

const d1Sent = new Map();
const d1Pending = new Map();
for (const row of d1Rows) {
  const target = row.posthog_state === "sent" ? d1Sent : d1Pending;
  target.set(row.event_name, (target.get(row.event_name) ?? 0) + Number(row.event_count));
}
const posthog = new Map(
  posthogBody.results.map(([eventName, eventCount]) => [String(eventName), Number(eventCount)]),
);
const eventNames = [...new Set([...d1Sent.keys(), ...d1Pending.keys(), ...posthog.keys()])].sort();
let mismatches = 0;

console.log("event | d1 sent | d1 pending | posthog | status");
for (const eventName of eventNames) {
  const sent = d1Sent.get(eventName) ?? 0;
  const pending = d1Pending.get(eventName) ?? 0;
  const delivered = posthog.get(eventName) ?? 0;
  const status = sent === delivered ? "MATCH" : "MISMATCH";
  if (status === "MISMATCH") mismatches += 1;
  console.log(`${eventName} | ${sent} | ${pending} | ${delivered} | ${status}`);
}

if (mismatches > 0) {
  console.error(`\n${mismatches} event count mismatch(es) require investigation.`);
  process.exitCode = 2;
} else {
  console.log("\nD1 sent counts and PostHog counts match exactly.");
}
