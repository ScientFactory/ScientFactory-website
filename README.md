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

Cloudflare D1 stores four anonymous website event types:

- `page_viewed`
- `download_clicked`
- `download_failed`
- `outbound_link_clicked`

The implementation intentionally stores no IP address, cookie, fingerprint, referrer, or persistent visitor identifier. Counts therefore represent events rather than unique visitors. `download_failed` is limited to a failure in ScientFactory's redirect service; the website cannot observe a transfer failure after GitHub begins serving an installer.

The production binding is `DOWNLOAD_DB`, backed by the `scientfactory-downloads` D1 database. New events use the shared `analytics_events` table; the earlier `site_events` table remains as read-only historical data. Apply new migrations before deploying code that depends on them:

```sh
bun run db:migrate
```

To view the lifetime event summary plus 30-day download, outbound-link, and failure breakdowns:

```sh
bun run analytics:report
```

Local and Cloudflare preview hosts do not write events, which keeps production counts free of development traffic.

## Analytics gateway

The Worker under `workers/events` is ScientFactory's first-party telemetry gateway. Desktop clients submit bounded event batches to `https://events.scientfactory.com/v1/events`; the Worker stores them in D1 first and can then forward anonymous copies to the ScientFactory EU PostHog project. PostHog is an optional analysis layer rather than the primary event store.

Generate binding types and validate the Worker with:

```sh
bun run events:types
bun run events:typecheck
```

Deploy the Worker only from an approved production change:

```sh
bun run events:deploy
```

`POSTHOG_PROJECT_TOKEN` is a Cloudflare Worker secret and must never be committed. If it is absent, ingestion continues and events remain queued in D1 for later delivery.
