# ScientFactory Website

The source of truth for [scientfactory.com](https://scientfactory.com), including the public Scient pages and desktop download experience.

## Repository role

- `main` is the production website branch.
- Pull requests receive CI validation and Cloudflare preview deployments.
- A successful merge to `main` triggers the production Cloudflare Pages deployment.
- Desktop binaries are not built here. Download metadata comes from the latest published release in [`ScientFactory/scient-desktop`](https://github.com/ScientFactory/scient-desktop/releases).

## Repository family

- [`ScientFactory/Scient`](https://github.com/ScientFactory/Scient) owns product
  policy, architecture, cross-repository planning, and operating procedures.
- [`ScientFactory/scient-desktop`](https://github.com/ScientFactory/scient-desktop)
  owns the desktop application and its releases.
- [`ScientFactory/scient-agent`](https://github.com/ScientFactory/scient-agent)
  owns the native-agent source foundation.
- [`ScientFactory/ScientFactory-website`](https://github.com/ScientFactory/ScientFactory-website)
  owns this website and download experience.

Internal contributors may keep these independent repositories as sibling
checkouts in one plain local workspace for shared read context. Cross-repository
changes still require separate branches, worktrees, commits, and pull requests,
with dependencies stated explicitly.

## Local development

Requires Bun 1.3.12 and Node.js 24.13.1.

```sh
bun install --frozen-lockfile
bun run dev
```

Before opening a pull request:

```sh
bun run check
```

## Deployment

Cloudflare Pages owns production and preview deployment. The project is `scientfactory-website`, the production branch is `main`, and the build output is `dist/`.

Do not deploy production from a feature branch or store Cloudflare credentials in this repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow. The cross-repository operating model is maintained in [`ScientFactory/Scient`](https://github.com/ScientFactory/Scient).

## First-party event measurement

Cloudflare D1 stores four website event types:

- `page_viewed`
- `download_clicked`
- `download_failed`
- `outbound_link_clicked`

Before a visitor chooses analytics, and after choosing **Essential only**, every event receives a new event-specific identifier. Those counts represent events rather than unique people. After explicit **Allow analytics** consent, the site sets a random first-party visitor identifier and creates a session identifier so visits, downloads, sessions, and return behavior can be measured. The identity is not derived from an IP address, browser fingerprint, email address, advertising identifier, referrer, or third-party account. `download_failed` is limited to a failure in ScientFactory's redirect service; the website cannot observe a transfer failure after GitHub begins serving an installer.

The production binding is `DOWNLOAD_DB`, backed by the `scientfactory-downloads` D1 database. New events use the shared `analytics_events` table; the earlier `site_events` table remains as read-only historical data. Apply new migrations before deploying code that depends on them:

```sh
bun run db:migrate
```

To view the lifetime event summary plus 30-day identity, consent, session, download, outbound-link, and failure breakdowns:

```sh
bun run analytics:report
```

Local and Cloudflare preview hosts do not write events, which keeps production counts free of development traffic.

## Analytics gateway

The Worker under `workers/events` is ScientFactory's first-party telemetry and identity gateway. Desktop clients submit bounded event batches to `https://events.scientfactory.com/v1/events`; the Worker stores them in D1 first and can then forward pseudonymous copies to the ScientFactory EU PostHog project. PostHog is an optional analysis layer rather than the primary event store.

Desktop ingestion is contract-first. The Worker accepts schema version 1, a
registered event name, its exact allowlisted property set, the event's declared
privacy level, and sufficient explicit consent. Unknown events, extra
properties, raw text, and mismatched consent or privacy classifications are
rejected before storage. The versioned registry and its focused tests live in
`workers/events/src/eventContract.ts`.

The public desktop endpoint is disabled unless the Cloudflare runtime variable
`DESKTOP_INGESTION_ENABLED` is exactly `true`. It also requires a random
installation-owned deletion token and applies the configured Cloudflare rate
limit per opaque installation ID. It does not use or store an IP address as a
rate-limit key. Keep the variable absent or false during preparation and use it
as the immediate ingestion kill switch during a selected-user rollout.

`POST /v1/installations/delete` authenticates an installation, deletes its D1
events, consent, identity links, and identity record, and queues the matching
PostHog person and historical-event deletion by opaque distinct ID. A request from an installation that has never uploaded is
acknowledged idempotently so the desktop can still clear local data and rotate
its anonymous identity. The scheduled Worker retries a failed PostHog submission
up to ten times and records a blocked queue item for operator review instead of
silently claiming success. Do not describe remote deletion as complete while
the queued PostHog state remains pending or blocked.

The scheduled Worker prunes canonical raw events older than 180 days in
bounded batches. D1 remains the source of truth for retention and delivery;
dashboard filters are not retention controls.

Website visitors, desktop installations, sessions, and future Scient accounts use separate opaque identifiers. The service-authenticated `POST /v1/identity/link` endpoint can connect a visitor or installation to an account after Scient's account service has authenticated that user. Browser and desktop clients cannot call this endpoint directly or claim an account identifier. Linking updates first-party historical events without changing the user's analytics choice; the corresponding anonymous-to-account PostHog identity event is forwarded only for product-or-higher consent.

Generate binding types and validate the Worker with:

```sh
bun run events:types
bun run events:typecheck
```

Deploy the Worker only from an approved production change:

```sh
bun run events:deploy
```

`POSTHOG_PROJECT_TOKEN`, `POSTHOG_PERSONAL_API_KEY`, and `IDENTITY_LINK_TOKEN`
are Cloudflare Worker secrets and must never be committed. The personal key is
used only for queued deletion and needs the narrow `person:write` scope;
`POSTHOG_PROJECT_ID` selects the project. If the project token is absent,
ingestion continues and events remain queued in D1 for later delivery. If the
deletion key or project ID is absent, accepted erasures remain queued in D1. If
the identity-link token is absent, account linking returns `503` while ordinary
ingestion continues.

Before any production activation, apply the migration, deploy the reviewed
Worker, verify that `/health` reports forwarding, deletion, rate limiting, and
storage ready, run the D1/PostHog reconciliation command, and only
then set `DESKTOP_INGESTION_ENABLED=true` for the approved cohort. Reversing
that variable to false stops new desktop ingestion without changing website
measurement.

The identity-link token is service-to-service authority. Rotate it if it is exposed, and never embed it in website or desktop bundles:

```sh
wrangler secret put IDENTITY_LINK_TOKEN --config workers/events/wrangler.jsonc
```

After an account service has authenticated a user and obtained their opaque account, installation, or visitor IDs, an authorized operator can exercise the same service endpoint with:

```sh
SCIENT_IDENTITY_LINK_TOKEN=... bun run identity:link \
  --account account:<uuid> \
  --identity installation:<uuid> \
  --identity visitor:<uuid>
```

This command is an operational bridge, not a substitute for account authentication. The eventual account service should call the endpoint server-to-server after sign-in; no link token belongs in a client bundle.

## PostHog dashboards

The managed dashboard manifest is `scripts/posthog-dashboard-manifest.mjs`.
It records all planned product dashboards, their source-backed queries, and the
exact events each one needs.
The manager is read-only by default and retrieves the personal API key from the
`scient-posthog-personal-api-key` macOS Keychain item (or the
`POSTHOG_PERSONAL_API_KEY` environment variable):

```sh
bun run analytics:dashboards
```

Validate every prepared query against PostHog without creating or changing a
dashboard:

```sh
bun run analytics:dashboards --validate-queries
```

Only dashboards marked current and backed by observed events are eligible for
creation. Planned dashboards are not created as empty or misleading shells.
After reviewing the readiness output, an authorized operator can idempotently
create or update ready dashboards:

```sh
bun run analytics:dashboards --apply-ready
```

The script never deletes dashboards or insights. D1 delivery state remains the
operational source of truth and should be reconciled with PostHog using
`bun run analytics:report` before relying on a dashboard. The exact per-event
D1-sent and PostHog counts can be checked without exposing the personal API key:

```sh
bun run analytics:reconcile
```

That command exits non-zero when the two systems disagree; pending D1 events
are reported separately rather than counted as delivered.
