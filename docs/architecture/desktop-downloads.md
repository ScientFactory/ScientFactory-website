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

## The update feeds

The same worker publishes the desktop app's generic electron-updater feeds:

| Channel | Feed URL (`generic` provider)                                       | Source                                                                                 |
| ------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Stable  | `https://downloads.scientfactory.com/scient-desktop/updates/stable` | `ScientFactory/scient-desktop`, GitHub's latest release                                |
| Beta    | `https://downloads.scientfactory.com/scient-desktop/updates/beta`   | `ScientFactory/scient-desktop-beta`, the newest `-beta.` tag in its releases Atom feed |

Each run, per channel (`workers/release-mirror/src/updateFeed.ts`):

1. Lists the channel's feed objects, recording each version, before asking GitHub anything.
2. Reads and validates the channel's handoff (`parseChannelHandoff`): the channel's version
   shape, the official source repository, and that channel's distribution. If every channel
   manifest already offers this release (`tag` and the manifest's SHA-256 in its metadata),
   the run ends here.
3. Downloads the release's channel manifests (`latest.yml`, `latest-mac.yml`,
   `latest-linux.yml`, or the `beta*` set) and accepts them only if size and SHA-256 match the
   handoff. Every file a manifest names must be a bare file name the handoff lists, with the
   same size.
4. Copies every payload (macOS ZIPs and DMGs, the NSIS EXE, the AppImage), every blockmap, and
   the manifests themselves into `scient-desktop/<tag>/`, with the same immutable writes as the
   installers. Payloads must also hash to the manifest's SHA-512 while streaming; the last chunk
   is held back until it does, so a mismatched copy never completes.
5. Writes `scient-desktop/updates/<channel>/<manifest>` last, each as a compare-and-swap on the
   version seen in step 1. The feed copy differs from the release's manifest only in two ways:
   every file URL becomes `../../<tag>/<name>`, which electron-updater resolves against the feed
   URL to the version directory, and `releaseName`/`releaseNotes` are added from the release's
   Atom entry, which is what GitHub's provider showed before. Sizes and SHA-512s are untouched.

Nothing is redirected: an old version's objects stay at their own paths, and the updater finds
the previous version's blockmap by substituting its version into the new file's path, which
the version directories satisfy for every release mirrored since the feed began. Two runs that
race can leave platforms on different releases for one interval; each platform's manifest is
self-consistent, and the next run moves the rest.

Caching (C1): versioned objects carry `public, max-age=31536000, immutable`; feed manifests and
`stable.json` carry `no-store`, and clients add a random `noCache` query to every check. A
response for a missing object is not one the worker writes, so the zone's cache rules decide
how long a 404 is kept (see the runbook in the README).

Deploy the worker with `bun run mirror:deploy`. The Pages project reads the bucket through
its `DESKTOP_DOWNLOADS` binding in `wrangler.jsonc`.

## Why

Before this, every cold edge cache asked GitHub for the handoff while the visitor waited,
and any refusal or error ended in a JSON 503. In November 2026 roughly a quarter of the
download attempts on some days failed that way, each in about 0.3 seconds, during bursts
of simultaneous requests against an expired cache. GitHub's status was not recorded, so
the specific refusal is unknown; the mirror and the release-page fallback remove the
dependency rather than tune around it.
