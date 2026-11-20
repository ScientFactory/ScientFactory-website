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
  owns Scient Agent, the native research agent built from Oh My Pi that the
  desktop application installs and runs.
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

## Desktop update feeds: deploy and verify

The `scientfactory-release-mirror` worker is the only publisher of
`downloads.scientfactory.com/scient-desktop/`. It copies the Stable installers and the complete
Stable and Beta electron-updater sets; see
[docs/architecture/desktop-downloads.md](docs/architecture/desktop-downloads.md). Pages
deployments do not deploy it.

1. After merge, from `main`: `bun run mirror:types:check && bun run mirror:deploy`.
2. Watch the next runs (every ten minutes) with
   `bunx wrangler tail scientfactory-release-mirror --config workers/release-mirror/wrangler.jsonc`.
   Expect `Stable update feed synchronized` and `Beta update feed synchronized` with `promoted`
   naming three manifests each. The first run per release copies up to about 1.8 GB per channel and
   hashes it; on the Workers Free plan (50 external subrequests, 10 ms CPU) it cannot finish,
   so confirm the account is on Workers Paid. A run cut short resumes from what is already in the
   bucket.
3. In the `scientfactory.com` zone, the `Scient download cache policy` ruleset (C1)
   applies only to the `downloads.scientfactory.com` hostname:
   - `/scient-desktop/updates/*` and `/scient-desktop/stable.json`: **Bypass cache**.
   - `/scient-desktop/v*`: **Eligible for cache**, edge and browser TTLs **respect origin**,
     with **no-store** for HTTP 300–599. Keep errors and redirects out of immutable caches.
     Without such a rule, Cloudflare caches some 404s and does not cache `.AppImage`,
     `.blockmap` or `.yml` by default. Files above 512 MB are not cached on non-Enterprise plans.
4. Verify each channel (`stable`/`latest`, then `beta`/`beta`):

   ```sh
   feed=https://downloads.scientfactory.com/scient-desktop/updates/stable
   for manifest in latest.yml latest-mac.yml latest-linux.yml; do
     curl -fsS -D- "$feed/$manifest?noCache=$RANDOM" -o "/tmp/$manifest" | grep -i '^cache-control'  # no-store
     grep -E '^(version|  - url|    size|    sha512|releaseName)' "/tmp/$manifest"
   done
   # For each url: it must resolve under scient-desktop/<tag>/, answer 200 with the listed size,
   # and hash to the listed sha512.
   url=https://downloads.scientfactory.com/scient-desktop/v0.6.30/Scient-0.6.30-x64.exe
   curl -fsSI "$url" | grep -iE '^(content-length|cache-control|cf-cache-status)'
   curl -fsS "$url" | openssl dgst -sha512 -binary | base64
   curl -fsSI "$url.blockmap" | head -1                                         # 200
   curl -sS -r 0-99 -o /dev/null -w '%{http_code} %{size_download}\n' "$url"     # 206 100
   curl -sS -o /dev/null -w '%{http_code}\n' https://downloads.scientfactory.com/scient-desktop/v0.0.0/missing.exe  # 404, twice: never HIT
   ```

5. Only then merge the desktop change that makes these feeds the updater's default, and qualify
   real updates on each platform from a build that uses them.

To stop publishing, remove the cron trigger and redeploy; the bucket's objects stay valid. Never
delete or rewrite a versioned object: installed clients and caches may still use it.

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

Each visit also records where it came from: the referring site's host (never its full address) and the link's `utm_source`, `utm_medium` and `utm_campaign` tags. The browser keeps them for the tab and sends them once on the visit's first page view, and the site's download links carry them with the page the download was clicked on. A download link on another site is credited to that site's host. Values that look like an address or an email are dropped.

Downloads made directly from GitHub never reach this site. Once a day the events Worker saves GitHub's running total for each release file in `github_release_downloads`. GitHub counts every fetch: Mac `.dmg` files are installs only and Mac updates fetch the `.zip`, but Windows `.exe` and Linux `.AppImage` totals also include updates that fell back to GitHub from the update mirror. A token in the optional `GITHUB_TOKEN` Worker secret only raises GitHub's rate limit.

The production binding is `DOWNLOAD_DB`, backed by the `scientfactory-downloads` D1 database. New events use the shared `analytics_events` table; the earlier `site_events` table remains as read-only historical data. Apply new migrations before deploying code that depends on them:

```sh
bun run db:migrate
```

To view the lifetime event summary plus 30-day identity, consent, session, download (by source, campaign, place and network, and GitHub's totals), outbound-link, and failure breakdowns:

```sh
bun run analytics:report
```

Local and Cloudflare preview hosts do not write events, which keeps production counts free of development traffic.

## Analytics gateway

The Worker under `workers/events` is ScientFactory's first-party telemetry and identity gateway. Desktop clients submit bounded event batches to `https://events.scientfactory.com/v1/events`; the Worker stores them in D1, the only analytics store.

Until 17 November 2026 the Worker also forwarded pseudonymous copies of website
and desktop usage events, and website identity links, to the ScientFactory EU
PostHog project. It no longer sends anything there. The only remaining PostHog
code is erasure: installation deletion requests still delete that
installation's earlier copies from PostHog. Remove the deletion code,
`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` once that PostHog project is
deleted. The `posthog_*` columns of shipped migrations stay; new event and identity
link rows keep `posthog_state='pending'` forever and nothing reads it.

Desktop ingestion works like T3's: the Worker accepts any event the app records, with no list of
event or property names. It checks schema version 1, the event's shape and size (an event name,
at most 64 properties of short strings, numbers, booleans or short arrays of those, 16 KiB in all)
and sufficient consent for the event's declared privacy level. It rejects nested values, free-text
properties such as `prompt` or `error`, and any value that looks like a path, link or email
address. `workers/events/src/eventContract.ts` is generated from
`scient-desktop/packages/scient-analytics/src/wireContract.ts`; do not edit it here. The shared
conformance fixtures (revisions 2 to 11) must keep passing. Since revision 10, new desktop events
and fields need no gateway change, so the desktop and gateway no longer have to ship in order.

After regenerating a shared fixture, apply this repository's formatter before validation:
`bunx --no-install oxfmt workers/events/fixtures/contract-v11.json`, then `bun run check`.
The desktop generator's JSON layout is not the website's formatting contract.

The public desktop endpoint is disabled unless the Cloudflare runtime variable
`DESKTOP_INGESTION_ENABLED` is exactly `true`. It also requires a random
installation-owned deletion token and applies the configured Cloudflare rate
limit per opaque installation ID. It does not use or store an IP address as a
rate-limit key. Keep the variable absent or false during preparation and use it
as the immediate ingestion kill switch during a selected-user rollout.

`POST /v1/installations/delete` authenticates an installation, deletes its D1
events, consent, identity links, and identity record, and, if that installation's
events were ever sent to PostHog, queues the matching PostHog person and
historical-event deletion by opaque distinct ID. A request from an installation that has never uploaded is
acknowledged idempotently so the desktop can still clear local data and rotate
its anonymous identity. A minimal opaque-ID/authentication-hash tombstone blocks
late uploads from recreating deleted history. Migration 0006 preserves legacy
erasure tombstones conservatively; missing legacy credentials cannot be guessed.
No behavioral payload is retained in the tombstone.

Erasure completes without PostHog only if no export was ever attempted (every
installation first seen after the export stopped). Otherwise
the scheduled Worker submits/polls PostHog's person/event deletion, with bounded
failure retries and an operator-visible blocked state. Provider verification,
not submission, completes the gateway request. A database lease, renewed before
each PostHog request, keeps overlapping cron runs from submitting the same
deletion twice; deleted identities are tombstoned and never deliberately reused. Completion
records PostHog's verified operation, not a synchronous transaction covering
every ambiguous capture or a guaranteed physical-deletion deadline.
Do not claim remote deletion is complete while its state is pending or blocked.

The scheduled Worker prunes canonical raw events older than 180 days in
bounded batches of 5,000; diagnostics have a 30-day limit. An unfinished backlog
does not count as a successful retention pass. Desktop occurrence age is also
enforced during ingestion and pruning, so offline delivery does not
reset its retention clock. `bun run analytics:report` exposes the bounded
30-day aggregate breakdown of desktop diagnostics alongside maintenance health;
no access to a user's computer is required. Copies already in PostHog follow
PostHog's own retention until that project is deleted; do not advertise a
PostHog deletion deadline.

Website visitors, desktop installations, sessions, and future Scient accounts use separate opaque identifiers. The service-authenticated `POST /v1/identity/link` endpoint can connect a website visitor to an account after Scient's account service has authenticated that user. Desktop linking is rejected until its per-installation erasure model is qualified. Browser and desktop clients cannot claim account identity. Website linking preserves consent and is stored only in D1.

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

This test connects the built desktop worker to a loopback gateway, checks
forbidden-data removal and the stored runtime-source metadata,
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

`POSTHOG_PERSONAL_API_KEY` and `IDENTITY_LINK_TOKEN` are Cloudflare Worker
secrets and must never be committed. The personal key is used only for queued
PostHog deletion and needs the reviewed person read/write scopes for lookup,
submission, and verification; `POSTHOG_PROJECT_ID` selects the project and is
committed as non-secret Worker configuration. The old `POSTHOG_PROJECT_TOKEN`
secret is no longer read and can be deleted. If the
deletion key or project ID is absent, accepted erasures remain queued in D1. If
the identity-link token is absent, account linking returns `503` while ordinary
ingestion continues.

Before activating an owner-approved rollout:

1. Apply the approved migrations and deploy the reviewed Worker with the
   desktop ingestion gate false. Website Pages deployment is not Worker deployment.
2. Verify `/health` against the exact deployed revision: required schema and a
   recent successful retention pass are checked, and the Worker version ID, tag,
   and creation time identify the deployed artifact. Configured secrets are not
   proof of valid permissions. Tag production uploads with the reviewed Git commit.
3. Verify asynchronous PostHog erasure with synthetic identifiers; an arbitrary
   delay or repeat-delete loop is not proof.
4. Exercise authorized synthetic end-to-end delivery,
   rejection, erasure, retry and retention. Never use
   live researchers' records for a test or expose credentials in logs.
5. Complete human privacy-copy/consent/cohort review. Enable the approved
   ingestion gate only after qualification. A desktop release is still needed;
   packaged apps are on by default, and `SCIENT_ANALYTICS_ENABLED=false` is the
   only off switch.

An upload costs one D1 round trip. Each upload logs its status, event count and stage
durations (`read_ms`, `rate_limit_ms`, `d1_ms`, `total_ms`) without identifiers.
A rejected upload's response and log carry a closed `reason` and `stage`
(`headers`, `body`, `batch`, `event`, `privacy` or `size`), listed in
`REJECTION_STAGES` in `workers/events/src/index.ts`. The log adds the batch
size, the rejected event's position, the client's `appVersion`, `buildChannel`
and `contractRevision` when they match their formats, and a user-agent family.
Nothing is authenticated when a batch is rejected, so it never logs event names,
property keys or values, identifiers, tokens or IP addresses. A failed upload logs `failed_step`
(`body`, `token`, `validation`, `rate-limit` or `storage`), the error's class
and name, and a closed `error_kind` for storage errors, never the error's
message. Desktop's uploader ignores the body of an unsuccessful response.

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

## Product insights

`bun run analytics:insights` reads an aggregate-only product report from D1:
feature observations/repeat days, provider/model terminal usage, reported token
counts and coverage, latest observed installation state, successful install
operations, submitted prompts (total and per UTC day), and terminal outcomes. It uses
revision-3 through revision-7 Product/Diagnostic participants on stable, beta and
nightly channels and the previous 30 complete UTC days.
Unknown token totals remain null; cache/reasoning subsets are not added again.
Submitted prompts count accepted V2 run admissions (including queued work) and
distinct accepted steering messages on an active run, not
provider acknowledgements or completed answers. Restart continuations and
legacy queue hydration and queued-to-steer promotions do not create new submissions. Submission tracking absent
in older releases cannot be reconstructed from terminal events. Installation
state is the latest observation in the reporting window; an install operation
count is a separate measure. Historical `other` cannot be attributed to Scient Agent.
Ready observations are not a current sign-in inventory, installations are not
people, and observed population is not feature eligibility. See the desktop
analytics document for producer meanings and omissions.

`bun run analytics:report` lists pending or blocked erasures and missing or
stale maintenance; it is not a claim of end-to-end healthy delivery.
Maintenance rows have a status and timestamp, not an event count.

### Account analytics activation

Revision 11 accepts provider account/profile observations. `IDENTITY_ANALYTICS_ENABLED`
is committed as `true` in both the Pages and event Worker configurations. Existing
usage ingestion stays independent. With this flag off, new identity events
are acknowledged and discarded rather than queued for later activation.

Migration 0007 must be applied before deploying the compatible gateway. Website
Pages deployment and event Worker deployment are separate operations. Qualify
storage, retention and synthetic observation handling before the desktop release.
The owner authorized production migration and activation on 10 November 2026,
with the public privacy-wording review to follow preparation and activation.

With activation enabled, dedicated account, profile, device-hash and request-network
observations remain in Cloudflare. Token-authenticated
installation deletion removes its observations too. Usage follows two-year inactivity
retention; diagnostic events expire after 60 days. The fallback 180/30-day
retention path applies only when identity analytics is disabled. Local desktop outbox retention
is a separate bounded delivery policy.

Migration 0007 backfills daily event/active-installation totals and maintains them
transactionally on new event insertion. Retry IDs do not inflate counts. Daily
country dimensions count distinct installation/day/IP network observations, not
people. Aggregate totals survive individual deletion; temporary membership rows
do not. The raw observations and email/device association views support analysis;
`analytics_download_installation_candidates` explicitly labels same-IP/time matches
as tentative and never merges identities. Shared accounts, networks and computers
must not be presented as proof of one human.

Provider capability and desktop behavior are documented in the dependent desktop
PR. The public privacy wording is being reviewed separately with the owner.
