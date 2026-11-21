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

The `scientfactory-release-mirror` worker (`workers/release-mirror/`) runs against the
`scient-downloads` R2 bucket, the same bucket that serves Scient Agent's copies. It runs at three
minutes past every ten (off the round minutes, when many Workers reach GitHub at once), and as
soon as a release is published: the desktop release workflow calls its authenticated
`POST /sync?channel=stable|beta` (see [Run on publish](#run-on-publish)). A run publishes the
Stable update feed first, then the Stable pointer below, then the Beta feed, so the pointer step
normally finds every Stable installer already verified against both digests instead of hashing
it again. When the feed step fails and the pointer step copies the installers alone, the next
feed run reads them back once to check their SHA-512. The pointer step also refuses a GitHub
handoff older than the pointer it read, so a stale answer cannot move the pointer back.
GitHub answers of 429 or a gateway error are retried up to three attempts, honoring `Retry-After`
up to 30 seconds. Each run:

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
   handoff. The macOS manifest must offer ZIPs and DMGs for both x64 and arm64;
   Windows must offer the x64 NSIS EXE and Linux the x64 AppImage. Extra Linux
   architecture manifests and their listed packages, including debs, are copied too.
   Every file must be a bare file name with the handoff's size, and ZIP/EXE payloads
   must have differential blockmaps.
4. Copies every payload, blockmap and manifest into `scient-desktop/<tag>/` with immutable
   writes. Payloads also match the manifest's SHA-512 while streaming. An existing object
   needs a matching SHA-512 verification receipt or is streamed from R2 and hashed before
   reuse; a matching handoff SHA-256 alone is insufficient.
5. Rejects a candidate older than any observed platform manifest, then writes
   `scient-desktop/updates/<channel>/<manifest>` last with a compare-and-swap on the
   observed version. A stale source cannot regress a later promotion. The feed copy changes
   file URLs to `../../<tag>/<name>` and adds release name/notes from the Atom entry;
   sizes and SHA-512s remain unchanged.

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

## Run on publish

The desktop release workflow (`.github/workflows/release.yml` in `scient-desktop`) calls
`POST https://<worker>.workers.dev/sync?channel=<stable|beta>` right after it publishes a Stable
or Beta release, with `Authorization: Bearer` and the token held as the worker secret
`MIRROR_SYNC_TOKEN` and the desktop repository secret `RELEASE_MIRROR_SYNC_TOKEN` (the address is
`RELEASE_MIRROR_SYNC_URL`). The worker answers 404 while the secret is unset, 401 for any other
token, and otherwise streams one JSON object per line: each step's result, a heartbeat every 15
seconds while it copies, and finally `{"message":"Release mirror finished","failures":n}`. The
run lasts only while the caller stays connected, since an HTTP invocation has no wall-time limit
but stops when its client leaves; whatever it copied stays, and the next scheduled run continues
from the bucket. The scheduled runs remain the fallback whenever the call fails.

The worker allows 5 minutes of CPU per invocation (`limits.cpu_ms`). Hashing one channel's
release (about 1.8 GB, SHA-256 by R2 and SHA-512 while streaming) takes about 40 seconds; with
the default 30 seconds, and the Stable pointer step's installers hashed a second time by the
feed step, the first run per release was cut short, and a release reached the feeds two or three
runs (20–30 minutes) after it was published.

## Why

Before this, every cold edge cache asked GitHub for the handoff while the visitor waited,
and any refusal or error ended in a JSON 503. In November 2026 roughly a quarter of the
download attempts on some days failed that way, each in about 0.3 seconds, during bursts
of simultaneous requests against an expired cache. GitHub's status was not recorded, so
the specific refusal is unknown; the mirror and the release-page fallback remove the
dependency rather than tune around it.
