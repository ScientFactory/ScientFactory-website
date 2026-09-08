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
  is the planned home for future native Scient-agent work. Its current
  OpenCode-derived starting repository is not yet an implemented native-agent
  foundation.
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

## Scient Docs publishing

The public `/docs` experience is generated from reviewed Markdown in
`scient-desktop/docs/user/` at an exact commit. The source manifest, hashes,
preview/stable qualification, correction path, and rollback contract live in
[`docs/scient-docs-manifest.json`](docs/scient-docs-manifest.json) and
[`docs/architecture/scient-docs-publishing.md`](docs/architecture/scient-docs-publishing.md).
Generated website files are intentionally ignored; `bun run docs:sync` rebuilds
them and fails closed if source content no longer matches the reviewed hashes.

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
`workers/events/src/eventContract.ts`. Revision 3 is generated from
`scient-desktop/packages/scient-analytics/src/wireContract.ts`, with a shared
conformance fixture for every registered event, plus revision-2 compatibility tests. Do not edit that copy
independently; the desktop analytics document owns regeneration instructions.
New events add an optional bounded `contractRevision`; legacy revision-1
payloads remain supported. Deploy this validator before releasing new producers.

The public desktop endpoint is disabled unless the Cloudflare runtime variable
`DESKTOP_INGESTION_ENABLED` is exactly `true`. It also requires a random
installation-owned deletion token and applies the configured Cloudflare rate
limit per opaque installation ID. It does not use or store an IP address as a
rate-limit key. Keep the variable absent or false during preparation and use it
as the immediate ingestion kill switch during a selected-user rollout.

Desktop forwarding to PostHog has its own gate,
`DESKTOP_POSTHOG_EXPORT_ENABLED`, also false by default. Turning off ingress
does not drain queued data; turning off export prevents queued desktop copies
from being forwarded. Neither gate affects existing website forwarding.

`POST /v1/installations/delete` authenticates an installation, deletes its D1
events, consent, identity links, and identity record, and queues the matching
PostHog person and historical-event deletion by opaque distinct ID. A request from an installation that has never uploaded is
acknowledged idempotently so the desktop can still clear local data and rotate
its anonymous identity. A minimal opaque-ID/authentication-hash tombstone blocks
late uploads from recreating deleted history. Migration 0006 preserves legacy
erasure tombstones conservatively; missing legacy credentials cannot be guessed.
No behavioral payload is retained in the tombstone.

Erasure completes without PostHog only if no export was ever attempted. Otherwise
the scheduled Worker submits/polls PostHog's person/event deletion, with bounded
failure retries and an operator-visible blocked state. Provider verification,
not submission, completes the gateway request. Export/deletion share a lease;
deleted identities are tombstoned and never deliberately reused. Completion
records PostHog's verified operation, not a synchronous transaction covering
every ambiguous capture or a guaranteed physical-deletion deadline.
Do not claim remote deletion is complete while its state is pending or blocked.

The scheduled Worker prunes canonical raw events older than 180 days in
bounded batches of 5,000; diagnostics have a 30-day limit. An unfinished backlog
does not count as a successful retention pass. Desktop occurrence age is also
enforced during ingestion, export and pruning, so offline delivery does not
reset its retention clock. D1 remains the source of truth
for retention and delivery; dashboard filters are not physical retention controls.
Desktop Diagnostic-class events remain only in Scient's central D1 ledger and
are never exported to PostHog. `bun run analytics:report` exposes their bounded
30-day aggregate breakdown alongside maintenance health; no access to a user's
computer is required. Essential/Product-class events can be exported even when
the user's consent level is Diagnostic. PostHog retention for those copies is
provider-managed; its query-access window is not a physical-deletion deadline.
Do not advertise 13-month or 30-day PostHog deletion guarantees.

Website visitors, desktop installations, sessions, and future Scient accounts use separate opaque identifiers. The service-authenticated `POST /v1/identity/link` endpoint can connect a website visitor to an account after Scient's account service has authenticated that user. Desktop linking is rejected until its per-installation erasure model is qualified. Browser and desktop clients cannot claim account identity. Website linking preserves consent; the PostHog identity event is forwarded only for Product-or-higher consent.

Generate binding types and validate the Worker with:

```sh
bun run events:types
bun run events:typecheck
```

The normal test suite uses synthetic records and real local SQLite migrations.
An additional cross-repository proof is opt-in: build the exact desktop
candidate, then run:

```sh
SCIENT_ANALYTICS_DESKTOP_ROOT=/absolute/desktop bun run test workers/events/src/desktopPipeline.test.ts
```

This test connects the built desktop worker to a loopback gateway and mocked
PostHog exporter, checks forbidden-data removal and runtime-source metadata,
then exercises consent, deletion, and late-replay rejection. It does not touch
production and is intentionally skipped when no explicit desktop path is set.
Record the desktop revision/build as well as the website revision; ordinary
website CI alone does not qualify this cross-repository path.
The desktop's `docs/internals/product-analytics.md` also documents a non-GUI
Electron-runtime invocation. Use it to qualify the native SQLite/runtime
boundary; passing under ordinary Node alone does not prove desktop packaging.

Deploy the Worker only from an approved production change:

```sh
bun run events:deploy
```

`POSTHOG_PROJECT_TOKEN`, `POSTHOG_PERSONAL_API_KEY`, and `IDENTITY_LINK_TOKEN`
are Cloudflare Worker secrets and must never be committed. The personal key is
used only for queued deletion and needs the reviewed person read/write scopes
for lookup, submission, and verification (qualify the exact provider permissions);
`POSTHOG_PROJECT_ID` selects the project and is committed as non-secret Worker
configuration. If the project token is absent,
ingestion continues and events remain queued in D1 for later delivery. If the
deletion key or project ID is absent, accepted erasures remain queued in D1. If
the identity-link token is absent, account linking returns `503` while ordinary
ingestion continues.

Before activating an owner-approved rollout:

1. Apply the approved migrations and deploy the reviewed Worker with **both
   desktop gates false**. Website Pages deployment is not Worker deployment.
2. Verify `/health` against the exact deployed revision: required schema and a
   recent successful retention pass are checked, and the Worker version ID, tag,
   and creation time identify the deployed artifact. Configured secrets are not
   proof of valid permissions. Tag production uploads with the reviewed Git commit.
3. Confirm the approved first-party-only diagnostic routing and truthful
   PostHog-managed retention wording. Verify asynchronous provider erasure with
   synthetic identifiers; an arbitrary delay or repeat-delete loop is not proof.
4. Exercise authorized synthetic end-to-end delivery,
   rejection, erasure, retry, retention and aggregate reconciliation. Never use
   live researchers' records for a test or expose credentials in logs.
5. Complete human privacy-copy/consent/cohort review. Enable the approved
   ingress/export gates only after qualification. Packaged desktop availability
   does not override a user's Off choice; a desktop release is still needed.

Export uses stable capture UUIDs and bounded retries, with a database lease
renewed before each outbound call. This prevents concurrent local exporters;
it is not a provider-side transactional fence. Persisted desktop properties are
revalidated so malformed/legacy rows cannot bypass today's privacy contract.
`posthog_state='sent'` means capture acknowledged, not erasure settled.

The identity-link token is service-to-service authority. Rotate it if it is exposed, and never embed it in website or desktop bundles:

```sh
wrangler secret put IDENTITY_LINK_TOKEN --config workers/events/wrangler.jsonc
```

After an account service has authenticated a user and obtained their opaque account, installation, or visitor IDs, an authorized operator can exercise the same service endpoint with:

```sh
SCIENT_IDENTITY_LINK_TOKEN=... bun run identity:link \
  --account account:<uuid> \
  --identity visitor:<uuid>
```

This command is an operational bridge, not a substitute for account authentication. The eventual account service should call the endpoint server-to-server after sign-in; no link token belongs in a client bundle.

## PostHog dashboards

`bun run analytics:insights` reads an aggregate-only product report from D1:
feature observations/repeat days, provider/model terminal usage, reported token
counts and coverage, providers observed ready, and terminal outcomes. It uses
revision-3 Product/Diagnostic participants and the previous 30 complete UTC days.
Unknown token totals remain null; cache/reasoning subsets are not added again.
Ready observations are not a current sign-in inventory, installations are not
people, and observed population is not feature eligibility. See the desktop
analytics document for producer meanings and omissions. Existing delivery and
erasure diagnostics remain in `analytics:report`.

The companion PostHog query definitions remain prepared, not installed or
live-qualified. Qualify their execution and project timezone before publishing;
match UTC to the D1 report when reconciling periods. Deploy the generated
revision-3 validator before releasing new desktop producers. No database
migration, collection-gate change or dashboard mutation is part of this extension.

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

Operator API requests are project-origin restricted, time/body bounded, and do
not blindly retry ambiguous creates. Pagination is bounded. The script never
deletes dashboards or insights. D1 delivery state remains the
operational source of truth and should be reconciled with PostHog using
`bun run analytics:report` before relying on a dashboard. That aggregate-only
report includes pending/blocked deletion, exhausted or quarantined delivery,
and missing/stale maintenance; it is not a claim of end-to-end healthy delivery.
Maintenance rows have a status and timestamp, not an event count. The exact per-event
D1-sent and PostHog counts can be checked without exposing the personal API key:

```sh
bun run analytics:reconcile
```

Reconciliation defaults to desktop events in the last seven days, excluding
the newest hour, and compares the same occurrence window and deduplicated event
IDs in both stores, excluding first-party-only diagnostics. Override it with `ANALYTICS_RECONCILE_SOURCE`,
`ANALYTICS_RECONCILE_FROM`, and `ANALYTICS_RECONCILE_TO` (maximum 30 days).
The one-hour delay is a reporting convention, not an erasure guarantee.
Mismatch, pending events, outstanding deletions, and no data exit non-zero;
an empty dashboard is not a verified pipeline.

Prepared metrics count consenting installation profiles, not all people. Product
success rates use a consistent Product/Diagnostic population and exclude terminal
stops. Activation uses the gateway's first-observed Product cohort anchor,
excludes unknown legacy anchors, requires ordered steps, and reports immature
cohorts separately. Retention needs complete follow-up windows. Billing allowances
are not hardcoded as current facts. Exact HogQL execution and installed-dashboard
behavior still require authorized provider-side qualification.

Scientific `source-import` outcomes have item-attempt grain, not batch grain.
Saved source-store results count as completions even when later batch cleanup
fails; duplicate/possible-match skips are reported separately as
`scient.operation.skipped` and do not qualify for meaningful-use metrics.
Retries are new attempts, not a second completion of an already saved source.
These events do not claim batch-conversion or human-review coverage.
