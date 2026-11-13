# Desktop downloads

`GET /api/download/<asset>` (`functions/api/download/[asset].ts`) counts a download
intent and redirects to the Stable installer for one platform. It never answers with
an error page: when no installer can be resolved it redirects to
`https://github.com/ScientFactory/scient-desktop/releases/latest`, which lists every
installer, and records `download_failed` with the reason, GitHub's HTTP status or error
name, elapsed time, attempts, and `fallback: "release_page"`.

## Where the release comes from

`resolveLatestDesktopRelease` (`functions/_lib/latest-release.ts`) tries, in order:

1. The data-center edge cache (five minutes).
2. **ScientFactory's mirror**, while the release mirror worker has confirmed it within the
   last six hours. Installers redirect to `downloads.scientfactory.com`. GitHub is not
   contacted.
3. **GitHub's latest release handoff**
   (`releases/latest/download/scient-release-handoff.json`). A missing response, timeout or
   5xx is retried once; a 4xx, including a 403/429 refusal, is not. Each attempt has four
   seconds.
4. The mirror however old it is, when GitHub fails.

Every source is validated by `parseReleaseHandoff` (`src/lib/release-handoff.ts`): the
official provenance repository, the four required installers, sizes and SHA-256 digests.
Redirect targets must pass `isOfficialDesktopReleaseDownload`: the canonical GitHub release
download path, or `downloads.scientfactory.com/scient-desktop/v<semver>/<installer>`.

## The mirror

The `scientfactory-release-mirror` worker (`workers/release-mirror/`) runs every ten minutes
against the `scient-downloads` R2 bucket, the same bucket that serves Scient Agent's copies.
Each run:

1. Reads GitHub's latest handoff and validates it.
2. For each required installer, keeps an existing `scient-desktop/<tag>/<name>` whose size
   and recorded SHA-256 match. A missing installer is streamed from the GitHub release into
   R2 with the handoff's SHA-256 and `If-None-Match: *`; R2 refuses the write when the bytes
   do not match. An existing installer with a different digest is never replaced: the run
   fails, because the current pointer and year-long caches may still serve those bytes. A
   changed installer needs a new release tag.
3. Writes `scient-desktop/stable.json` last, as a compare-and-swap on the pointer version the
   run observed at its start: the handoff, GitHub's Last-Modified, `mirroredAt`, and
   `checkedAt`. If another run wrote the pointer meanwhile, this run reports `superseded`
   and leaves it, so a slow run that saw an older release cannot undo a newer promotion.

A failed run leaves the previous pointer untouched, so the pointer only names installers
that are in the bucket. Older versions stay in the bucket.

Deploy the worker with `bun run mirror:deploy`. The Pages project reads the bucket through
its `DESKTOP_DOWNLOADS` binding in `wrangler.jsonc`.

## Why

Before this, every cold edge cache asked GitHub for the handoff while the visitor waited,
and any refusal or error ended in a JSON 503. In November 2026 roughly a quarter of the
download attempts on some days failed that way, each in about 0.3 seconds, during bursts
of simultaneous requests against an expired cache. GitHub's status was not recorded, so
the specific refusal is unknown; the mirror and the release-page fallback remove the
dependency rather than tune around it.
