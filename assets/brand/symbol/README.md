# Scient symbol: Möbius strip

Reference files for the next Scient symbol. They are stored here ahead of the migration: the
website, the desktop app and the social profiles still use the previous symbol
([`public/scient-symbol.svg`](../../../public/scient-symbol.svg)) until each is migrated.

The three reference symbols are `scient-symbol-color.svg`, `scient-symbol-black.svg` and
`scient-symbol-white.svg`. Every other file here is derived from the same outlines by `build.py`.

## Colors

| Coloring | Values                                       | Use                                   |
| -------- | -------------------------------------------- | ------------------------------------- |
| Color    | Blue `#549EC1` blending into coral `#F3A382` | Light and dark backgrounds            |
| Black    | Ink `#252B32`                                | Light backgrounds, one-color printing |
| White    | `#FFFFFF`                                    | Dark backgrounds and photographs      |

## Files

| Path                                                  | What                                                        | Use                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `scient-symbol-{color,black,white}.svg`               | Exact masters, 512-unit box, no padding                     | Anything 48 px and up: web, documents, print                            |
| `scient-symbol-mono.svg`                              | The one-color master with `fill="currentColor"`             | Inline in app UI so it takes the text color                             |
| `small/scient-symbol-<coloring>-<16\|20\|24\|32>.svg` | Pixel-fitted drawings, one per size                         | UI icons at exactly that size (also `mono`)                             |
| `png/scient-symbol-<coloring>-<size>.png`             | Transparent PNGs, 16 to 1024 px                             | Where SVG is not accepted; for a 2x screen take the file twice the size |
| `pdf/scient-symbol-<coloring>.pdf`                    | Vector PDFs                                                 | Print and design tools                                                  |
| `favicon.ico`                                         | 16, 32 and 48 px, color                                     | Website favicon                                                         |
| `preview.html`                                        | All colorings and sizes; written by `build.py`, not tracked | Review at 100% browser zoom                                             |

The symbol fills its box, so add your own clear space: at least a quarter of the symbol's width
on every side.

## Construction

The shape is an orthographic projection of the standard Möbius strip

    x = (1 + v cos(t/2)) cos t,  y = (1 + v cos(t/2)) sin t,  z = v sin(t/2),  |v| ≤ 0.36

turned 0.45 rad about the z axis and viewed from 57°.

`build.py` unions a 4096-step mesh of the surface and fits each outline with cubic Béziers by
least squares. Nodes sit on the corners and on the horizontal and vertical extremes.

The silhouette is 31 segments and stays within 0.02 units of the 512-unit box (0.004%) of the mesh.

## Color blend

In the color drawing the color changes along the strip itself. The near side is blue, the far side
is coral, and the two are mixed in OKLCH, so the transition passes through lavender and pink and not
grey.

The amount of coral at each point is a mix of two blends: a soft blend that keeps the coral on
the far side, and a full loop in which the color travels once around the whole strip. The share of
the full loop is 54% on the left side of the symbol and 65% on the right, changing smoothly between.

SVG has no gradient that follows a curve, so the strip is painted as thin quads along its length,
360 to a turn in the master and 120 in the small drawings, inside clip paths made from the exact
outlines:

- The quads are painted in order and without anti-aliasing. Each shows for one pitch, so the result
  is an even staircase of colors about one 8-bit level apart, with no joints showing.
- A base coat of wider quads reaches past the outline, so every edge pixel is fully painted.
- At the twist the strip folds over itself. The part in front is a separate layer with its own
  outline, so the fold has a clean edge.
- The clip paths alone anti-alias the edges, exactly as in the one-color drawings.

The blend is a design choice. A Möbius strip has one side, so the two colors do not mean two sides.
The black, white and `currentColor` drawings are single flat colors.

## Small sizes

Each `small/` drawing fills its box and has the hole's four extremes moved onto pixel edges, with
the hole rounded outward so it stays open. They are optical adaptations and depart slightly from
the exact projection. On a standard-density screen a curved edge at 16 px is still anti-aliased;
the fitting sharpens the extremes and opens the hole, it does not make the edge hard.

## Rebuild

Needs shapely, Google Chrome and ImageMagick.

    python3 -m venv .venv && .venv/bin/pip install shapely && .venv/bin/python build.py
