# ScientFactory Website

The source of truth for [scientfactory.com](https://scientfactory.com), including the public Scient pages and desktop download experience.

## Repository role

- `main` is the production website branch.
- Pull requests receive CI validation and Cloudflare preview deployments.
- A successful merge to `main` triggers the production Cloudflare Pages deployment.
- Desktop binaries are not built here. Download metadata comes from the latest published release in [`ScientFactory/scient-desktop`](https://github.com/ScientFactory/scient-desktop/releases).

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

`POSTHOG_PROJECT_TOKEN` and `IDENTITY_LINK_TOKEN` are Cloudflare Worker secrets and must never be committed. If the PostHog token is absent, ingestion continues and events remain queued in D1 for later delivery. If the identity-link token is absent, account linking returns `503` while ordinary ingestion continues.

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
