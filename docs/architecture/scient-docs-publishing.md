# Scient Docs Publishing Architecture

Status: Active
Owner: Yaacov
Created: 2026-08-28
Last updated: 2026-08-30
Purpose: Defines the website-owned transport, provenance, failure, correction, and rollback contract for publishing canonical Scient Desktop Help.
Doc type: Architecture decision

## Authority

`scient-desktop/docs/user/` owns Help prose. The website owns selection,
transport, rendering, navigation, search, accessibility, source/version
display, and deployment. `docs/scient-docs-manifest.json` is the reviewed
publication selection; it is not a second prose source. `scient-agent` is
outside this publishing pass.

## Selected Transport

The website build reads a committed manifest that pins:

- a full immutable `ScientFactory/scient-desktop` commit;
- every selected `docs/user/` source path;
- a SHA-256 digest for each source page;
- stable or preview channel and truthful applicability wording; and
- corpus defaults plus page-level topic, title, summary, navigation priority,
  and surface metadata.

CI and ordinary builds fetch each page from GitHub's immutable raw-commit URL.
Local development may set `SCIENT_DOCS_SOURCE_ROOT` to an exact checkout at the
same commit; the generator rejects a different head, and page hashes still
apply. Generated files are ignored build products. The website never commits a
hand-maintained prose copy.

This transport was selected in the pilot and retained for the complete
desktop-first corpus because it remains small, independently deployable, exact,
auditable, and reversible without introducing a package registry or release
artifact before one is justified. Re-evaluate it if corpus size, availability,
rate limits, private sources, or release engineering make raw-commit transport
materially unreliable.

## Build And Safety Contract

`scripts/sync-scient-docs.mjs` validates the manifest, fetches exact content,
checks every digest and H1, rejects executable/unsafe raw Markdown patterns,
rewrites selected relative Help links to stable public routes, and sends
unselected relative Help links to the exact GitHub source. It generates:

- Astro Markdown pages under stable `/docs/<slug>/` routes;
- exact raw Markdown under `/docs/raw/<slug>.md`;
- `/docs/index.json` with title, summary, topic, channel, applicability, page
  URL, raw URL, source path/revision/URL, and search text; and
- the metadata used by client-side topic/text search, navigation, and the
  compact source footer.

Missing content, a changed hash, unsafe content, a mutable/non-full revision,
duplicate routing, an unqualified stable manifest, or a wrong local checkout
fails the build. There is no stale cache fallback that could silently publish
the wrong content. The previously deployed website remains live while CI or a
preview exposes the failure.

## Preview, Stable, And Corrections

A preview manifest may pin an exact documentation or application PR head. The
website labels every page as preview, shows what it applies to, and links to the
exact source. It must not be presented as stable released behavior.

A stable manifest must name at least one reviewed desktop release tag and pin
the exact Help revision that truthfully describes it. A release triggers a
reviewed website manifest PR; publication should complete within 24 hours. A
Help-only correction uses a desktop documentation PR followed by a dependent
website manifest PR and deployment, without requiring a new app binary. Its
applicability text continues to name the releases the corrected prose
describes.

Rollback reverts the manifest pin or website publishing change. It never
rewrites canonical desktop Help. A reverted or failed deployment leaves the
last successful public corpus in place and visible through ordinary website
deployment history.

## Current corpus and deferred scope

The stable manifest selects all 34 current desktop-first Help pages qualified
for Scient Desktop v0.6.8 at the exact corrected Help source revision. Scient
has no public mobile-specific Help corpus. Directory membership still does not
imply publication, and future Help owners require factual qualification before
entering the manifest.

A documentation MCP and any larger metadata schema remain separate decisions.
Evaluate MCP only after stable HTML, raw Markdown, the index, and search reveal
a concrete agent-retrieval gap.
