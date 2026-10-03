# Scient brand assets

Canonical export files for ScientFactory marketing and social profiles. These files are source
assets for reuse; they are kept outside `public/` so adding them does not create new website routes.

## Logo

- `logo/scient-profile-picture-1024x1024.png` — square profile image for social accounts.
- The editable symbol remains [`public/scient-symbol.svg`](../../public/scient-symbol.svg).

## Next symbol

- [`symbol/`](symbol/README.md) — reference files for the Möbius-strip symbol that will replace the
  current one: color, black and white SVG masters, with pixel-fitted small sizes, PNG and PDF
  exports. Nothing on the website uses them yet.

## Link preview

- `public/og-image.png` (1200x630) — the image shown when a scientfactory.com link is shared
  (WhatsApp, Slack, X, LinkedIn). The symbol and wordmark are centred so a square crop keeps both.
  Bump the `?v=` query in `src/layouts/Layout.astro` whenever the file changes.

## Social headers

- `social/scient-x-header-clean-3000x1000.png` — preferred high-resolution X header upload.
- `social/scient-x-header-clean-1500x500.png` — standard-size X header fallback.

Both headers use the approved line:

> Research tools and AI agents in one connected workspace.

The two exports have the same 3:1 composition. Prefer the 3000x1000 PNG when the platform accepts
it; use the 1500x500 PNG when exact recommended dimensions are required.
