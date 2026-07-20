#!/usr/bin/env node

const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function argumentsFor(name) {
  return args.flatMap((value, index) =>
    value === name && args[index + 1] ? [args[index + 1]] : [],
  );
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const accountId = argument("--account");
const identityIds = argumentsFor("--identity");
const endpoint =
  process.env.SCIENT_IDENTITY_LINK_ENDPOINT ?? "https://events.scientfactory.com/v1/identity/link";
const token = process.env.SCIENT_IDENTITY_LINK_TOKEN;

if (!accountId || identityIds.length === 0) {
  fail(
    "Usage: bun run identity:link --account account:<uuid> --identity installation:<uuid> [--identity visitor:<uuid>]",
  );
} else if (!token) {
  fail(
    "Set SCIENT_IDENTITY_LINK_TOKEN to the Worker identity-link secret before running this command.",
  );
} else {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schema_version: 1,
      account_id: accountId,
      identity_ids: identityIds,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    fail(`Identity link failed (${response.status}): ${body}`);
  } else {
    console.log(body);
  }
}
