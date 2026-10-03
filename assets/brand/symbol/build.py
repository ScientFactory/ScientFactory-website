"""Builds the Scient symbol kit: exact SVG masters, pixel-fitted small sizes, PNGs, PDFs and a favicon.

The shape is the orthographic projection of the standard Möbius strip
    x = (1 + v cos(t/2)) cos t,  y = (1 + v cos(t/2)) sin t,  z = v sin(t/2),  |v| <= 0.36
turned 0.45 rad about z and viewed from 57 degrees.
A fine mesh of the surface is unioned, then the outline is fitted with a few cubic Beziers whose
nodes sit on the corners and on the horizontal and vertical extremes.

The color drawing paints the strip as thin slices along its length, masked by that outline, so the
color changes along the strip itself. Blue covers the near side and peach the far side; colors are
mixed in OKLCH, and the transition passes through a soft grey-blue.

Needs shapely, Google Chrome and ImageMagick:
    python3 -m venv .venv && .venv/bin/pip install shapely && .venv/bin/python build.py
"""
import itertools
import math as m
import subprocess
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, MultiPoint, Polygon
from shapely.ops import unary_union

OUT = Path(__file__).parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HALF_WIDTH, SPIN, ELEVATION = 0.36, 0.45, m.radians(57)
FAR_SIDE = 35 * m.pi / 128  # the value of t at the middle of the far side, where the peach is purest
BOX, STEPS, TOLERANCE = 512, 4096, 0.02
BLUE, PEACH, INK, WHITE = "#5BA2C2", "#F8AC8B", "#252B32", "#FFFFFF"
# Share of the full-loop blend mixed into the soft blend, on the left and right sides of the symbol.
LOOP_SHARE_LEFT, LOOP_SHARE_RIGHT = 0.54, 0.65
# How much further the peach reaches before the blend begins, on each side of the symbol.
PEACH_REACH_LEFT, PEACH_REACH_RIGHT = m.radians(4), m.radians(12)
SLICES, SMALL_SLICES = 360, 120
COLORINGS = [("color", None), ("black", INK), ("white", WHITE)]
SMALL_SIZES = (16, 20, 24, 32)
PNG_SIZES = (16, 20, 24, 32, 48, 64, 128, 256, 512, 1024)


def project(t, v):
    r = 1 + v * m.cos(t / 2)
    x, y, z = r * m.cos(t), r * m.sin(t), v * m.sin(t / 2)
    x, y = x * m.cos(SPIN) - y * m.sin(SPIN), x * m.sin(SPIN) + y * m.cos(SPIN)
    return x, -(y * m.sin(ELEVATION) + z * m.cos(ELEVATION))


def depth(t, v):
    """Distance toward the viewer of the same point."""
    r = 1 + v * m.cos(t / 2)
    y = r * m.cos(t) * m.sin(SPIN) + r * m.sin(t) * m.cos(SPIN)
    return -y * m.cos(ELEVATION) + v * m.sin(t / 2) * m.sin(ELEVATION)


def to_oklch(hex_color):
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    r, g, b = (c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b))
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    md = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    lightness = 0.2104542553 * l + 0.7936177850 * md - 0.0040720468 * s
    a = 1.9779984951 * l - 2.4285922050 * md + 0.4505937099 * s
    bb = 0.0259040371 * l + 0.7827717662 * md - 0.8086757660 * s
    return lightness, m.hypot(a, bb), m.atan2(bb, a)


def from_oklch(lightness, chroma, hue):
    a, bb = chroma * m.cos(hue), chroma * m.sin(hue)
    l = (lightness + 0.3963377774 * a + 0.2158037573 * bb) ** 3
    md = (lightness - 0.1055613458 * a - 0.0638541728 * bb) ** 3
    s = (lightness - 0.0894841775 * a - 1.2914855480 * bb) ** 3
    rgb = (4.0767416621 * l - 3.3077115913 * md + 0.2309699292 * s,
           -1.2684380046 * l + 2.6097574011 * md - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * md + 1.7076147010 * s)
    out = "#"
    for c in rgb:
        c = min(1.0, max(0.0, c))
        out += f"{round((12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055) * 255):02X}"
    return out


def mix(a, b, f):
    """Blend two hex colors in OKLCH, midway between the path that turns the hue through green and the
    path that turns it through purple. Blue and peach are almost opposite, so the two paths are almost
    mirror images and their midpoint keeps a steady hue while the chroma follows cos(pi f): the blend
    passes through a soft grey-blue instead of either green or purple."""
    (l1, c1, h1), (l2, c2, h2) = to_oklch(a), to_oklch(b)
    through_green = (h2 - h1) % (2 * m.pi) - 2 * m.pi
    return from_oklch(l1 + (l2 - l1) * f, (c1 + (c2 - c1) * f) * m.cos(m.pi * f), h1 + (through_green + m.pi) * f)


def peach_amount(t):
    """How much peach the strip carries at t, from 0 (blue) to 1.

    Two blends are mixed. The soft blend keeps the peach on the far side and fades it out over about
    74 degrees of the strip on each side. The full loop is a cosine around the whole strip. The share of
    full loop is larger on the right side of the symbol than on the left and changes smoothly between.

    The blend is read from a point nearer the far side, by up to PEACH_REACH_* in the middle of each
    side, so the peach reaches further before it fades. The shift is zero at the top and the bottom.
    """
    s = (t - FAR_SIDE + m.pi) % (2 * m.pi) - m.pi  # negative on the right of the symbol
    t += (PEACH_REACH_RIGHT if s < 0 else -PEACH_REACH_LEFT) * m.sin(s) ** 2
    away = abs(t - FAR_SIDE) % (2 * m.pi)
    away = min(away, 2 * m.pi - away)
    f = min(1.0, max(0.0, (away - 0.35 * FAR_SIDE) / (1.5 * FAR_SIDE)))
    soft = 1 - f * f * (3 - 2 * f)
    loop = (1 + m.cos(t - FAR_SIDE)) / 2
    side = m.sin(t - FAR_SIDE)  # +1 on the left of the symbol, -1 on the right
    share = (LOOP_SHARE_LEFT + LOOP_SHARE_RIGHT) / 2 - (LOOP_SHARE_RIGHT - LOOP_SHARE_LEFT) / 2 * side
    return soft + share * (loop - soft)


def region(t0, t1, steps):
    """Union of the projected surface between two rulings."""
    tris = []
    for i in range(steps):
        a, b = t0 + (t1 - t0) * i / steps, t0 + (t1 - t0) * (i + 1) / steps
        p00, p10, p11, p01 = project(a, -HALF_WIDTH), project(b, -HALF_WIDTH), project(b, HALF_WIDTH), project(a, HALF_WIDTH)
        for tri in ((p00, p10, p11), (p00, p11, p01)):
            poly = Polygon(tri)
            if poly.area > 1e-12:
                tris.append(poly if poly.is_valid else poly.buffer(0))
    return unary_union(tris)


def unit(v):
    n = float(np.hypot(*v))
    return v / n if n else v


def bezier(ctrl, u):
    u = np.asarray(u)[:, None]
    return (1 - u) ** 3 * ctrl[0] + 3 * (1 - u) ** 2 * u * ctrl[1] + 3 * (1 - u) * u ** 2 * ctrl[2] + u ** 3 * ctrl[3]


def fit_span(pts, t0, t1, out):
    """Schneider's least-squares cubic fit of a dense polyline with fixed end tangents; splits where needed."""
    p0, p3 = pts[0], pts[-1]
    along = unit(p3 - p0)
    # A straight edge: the mesh gives it only a handful of points, sometimes with a tiny jog at a corner.
    if len(pts) <= 8 or np.abs((pts - p0) @ np.array([-along[1], along[0]])).max() < TOLERANCE / 2:
        out.append(np.array([p0, p0 + (p3 - p0) / 3, p3 - (p3 - p0) / 3, p3]))
        return
    chord = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
    u = chord / chord[-1]
    ctrl = err = worst = None
    for _ in range(8):
        b1, b2 = 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u ** 2
        a1, a2 = b1[:, None] * t0, -b2[:, None] * t1
        rhs = pts - (((1 - u) ** 3 + b1)[:, None] * p0 + (b2 + u ** 3)[:, None] * p3)
        c = np.array([[np.sum(a1 * a1), np.sum(a1 * a2)], [np.sum(a1 * a2), np.sum(a2 * a2)]])
        x = np.array([np.sum(a1 * rhs), np.sum(a2 * rhs)])
        det = np.linalg.det(c)
        h1, h2 = np.linalg.solve(c, x) if abs(det) > 1e-9 else (chord[-1] / 3,) * 2
        if h1 <= 1e-6 or h2 <= 1e-6:
            h1 = h2 = chord[-1] / 3
        ctrl = np.array([p0, p0 + h1 * t0, p3 - h2 * t1, p3])
        delta = bezier(ctrl, u) - pts
        dist = np.hypot(*delta.T)
        worst, err = int(np.argmax(dist)), float(dist.max())
        if err <= TOLERANCE:
            break
        d1 = 3 * ((1 - u) ** 2)[:, None] * (ctrl[1] - ctrl[0]) + 6 * ((1 - u) * u)[:, None] * (ctrl[2] - ctrl[1]) + 3 * (u ** 2)[:, None] * (ctrl[3] - ctrl[2])
        d2 = 6 * (1 - u)[:, None] * (ctrl[2] - 2 * ctrl[1] + ctrl[0]) + 6 * u[:, None] * (ctrl[3] - 2 * ctrl[2] + ctrl[1])
        den = np.sum(d1 * d1, axis=1) + np.sum(delta * d2, axis=1)
        u = np.clip(u - np.where(np.abs(den) > 1e-12, np.sum(delta * d1, axis=1) / den, 0), 0, 1)
    if err > TOLERANCE and len(pts) > 8:
        k = min(max(worst, 3), len(pts) - 4)
        mid = unit(pts[min(k + 3, len(pts) - 1)] - pts[max(k - 3, 0)])
        fit_span(pts[: k + 1], t0, mid, out)
        fit_span(pts[k:], mid, t1, out)
    else:
        out.append(ctrl)


def fit_ring(points):
    """Closed dense polyline -> list of cubic Beziers with nodes at corners and extremes."""
    pts = np.array(points)
    n = len(pts)
    step = np.hypot(*(np.roll(pts, -1, axis=0) - pts).T)
    cum = np.concatenate([[0], np.cumsum(step)])
    total = cum[-1]

    def at(s):
        s = s % total
        i = min(int(np.searchsorted(cum, s, side="right")) - 1, n - 1)
        f = (s - cum[i]) / step[i] if step[i] else 0
        return pts[i] + f * (pts[(i + 1) % n] - pts[i])

    window = 1.2
    back = np.array([unit(pts[i] - at(cum[i] - window)) for i in range(n)])
    fwd = np.array([unit(at(cum[i] + window) - pts[i]) for i in range(n)])
    turn = np.abs(np.arctan2(back[:, 0] * fwd[:, 1] - back[:, 1] * fwd[:, 0], np.sum(back * fwd, axis=1)))

    def near(i, j, d):
        gap = abs(cum[i] - cum[j])
        return min(gap, total - gap) < d

    corners = []
    for i in np.argsort(-turn):
        if turn[i] < m.radians(28):
            break
        if not any(near(i, j, 4 * window) for j in corners):
            corners.append(int(i))
    knots = {i: None for i in corners}  # index -> forced tangent for smooth nodes
    mid = unit_rows(fwd + back)
    for axis, tangent in ((0, np.array([0.0, 1.0])), (1, np.array([1.0, 0.0]))):
        sign = np.sign(mid[:, axis])
        for i in np.nonzero(sign * np.roll(sign, 1) < 0)[0]:
            i = int(i)
            if not any(near(i, j, 12) for j in knots):
                knots[i] = tangent * (1 if mid[i] @ tangent > 0 else -1)
    order = sorted(knots)
    curves = []
    for a, b in zip(order, order[1:] + [order[0] + n]):
        idx = [k % n for k in range(a, b + 1)]
        span = pts[idx]
        t0 = knots[a] if knots[a] is not None else unit(at(cum[a] + 0.4) - pts[a])
        end = b % n
        t1 = knots[end] if knots[end] is not None else unit(pts[end] - at(cum[end] - 0.4))
        fit_span(span, t0, t1, curves)
    line = LineString(np.vstack([pts, pts[:1]]))
    samples = np.vstack([bezier(c, np.linspace(0, 1, 24)) for c in curves])
    dists = [line.distance(LineString([p, p + 1e-9])) for p in samples]
    return curves, len(corners), max(dists)


def unit_rows(v):
    return v / np.maximum(np.hypot(*v.T), 1e-12)[:, None]


def num(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def path_data(curves):
    d = f"M{num(curves[0][0][0])} {num(curves[0][0][1])}"
    for c in curves:
        if np.allclose(c[1], c[0] + (c[3] - c[0]) / 3) and np.allclose(c[2], c[3] - (c[3] - c[0]) / 3):
            d += f"L{num(c[3][0])} {num(c[3][1])}"
        else:
            d += "C" + " ".join(f"{num(x)} {num(y)}" for x, y in c[1:])
    return d + "Z"


# The strip is meshed slightly past a full turn so its two ends overlap and leave no slit at t = 0.
strip = region(0, 2 * m.pi + 0.02, STEPS)
minx, miny, maxx, maxy = strip.bounds
hx0, hy0, hx1, hy1 = max(strip.convex_hull.difference(strip).geoms, key=lambda g: g.area).bounds


def master_map():
    scale = BOX / max(maxx - minx, maxy - miny)
    ox, oy = BOX / 2 - scale * (minx + maxx) / 2, BOX / 2 - scale * (miny + maxy) / 2
    return lambda x, y: (ox + scale * x, oy + scale * y)


def fitted_map(size):
    """Grid-fit for one pixel size: the outline fills the box and the hole's four extremes sit on
    pixel edges, so those edges render as full pixels. The hole is rounded outward to stay open."""
    px = BOX / size
    nat = lambda v, lo, hi: (v - lo) / (hi - lo) * size
    xk = [(minx, 0.0), (hx0, m.floor(nat(hx0, minx, maxx) + 0.35) * px), (hx1, m.ceil(nat(hx1, minx, maxx) - 0.35) * px), (maxx, float(BOX))]
    yk = [(miny, 0.0), (hy0, m.floor(nat(hy0, miny, maxy) + 0.35) * px), (hy1, m.ceil(nat(hy1, miny, maxy) - 0.35) * px), (maxy, float(BOX))]

    def warp(v, keys):
        for (a, fa), (b, fb) in zip(keys, keys[1:]):
            if v <= b or (b, fb) == keys[-1]:
                return fa + (v - a) * (fb - fa) / (b - a)

    return lambda x, y: (warp(x, xk), warp(y, yk))


def outline(shape, label, mapping):
    polys = [shape] if shape.geom_type == "Polygon" else list(shape.geoms)
    d, count, worst = "", 0, 0.0
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            pts = []
            for x, y in ring.coords[:-1]:
                q = mapping(x, y)
                if not pts or m.dist(q, pts[-1]) > 1e-6:
                    pts.append(q)
            if len(pts) < 4 or abs(Polygon(pts).area) < 1:  # mesh slivers at the fold
                continue
            curves, _, err = fit_ring(pts)
            d, count, worst = d + path_data(curves), count + len(curves), max(worst, err)
    print(f"{label}: {count} segments, max error {worst:.3f} of {BOX} ({worst / BOX:.4%})")
    return d


def edge_on():
    """The value of t near the twist where the strip is seen exactly edge-on."""
    def turn(t):
        (x0, y0), (x1, y1) = project(t - 1e-4, 0), project(t + 1e-4, 0)
        (ax, ay), (bx, by) = project(t, -HALF_WIDTH), project(t, HALF_WIDTH)
        return (x1 - x0) * (by - ay) - (y1 - y0) * (bx - ax)

    lo, hi = m.pi - 0.6, m.pi + 0.6
    assert turn(lo) * turn(hi) < 0
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if turn(lo) * turn(mid) > 0 else (lo, mid)
    return (lo + hi) / 2


# At the twist the strip folds over itself. The part in front is drawn as its own layer with its own
# exact outline, so the fold has a clean edge; the rest of the strip lies behind it.
FOLD, FRONT_SPAN, UNDERLAP = edge_on(), 1.2, 0.1
if depth(FOLD - 0.35, 0) > depth(FOLD + 0.35, 0):
    FRONT, BACK = (FOLD - FRONT_SPAN, FOLD), (FOLD, FOLD - FRONT_SPAN + 2 * m.pi + UNDERLAP)
else:
    FRONT, BACK = (FOLD, FOLD + FRONT_SPAN), (FOLD + FRONT_SPAN - UNDERLAP, FOLD + 2 * m.pi)
front = region(*FRONT, STEPS // 4)


def quads(mapping, t0, t1, count, lap, grow=0.0):
    """The strip between t0 and t1 as colored quads in order of t, `count` to a full turn. Each quad
    covers `lap` pitches and is painted over by the next, so each shows for exactly one pitch. None
    passes t1, where the fold is. `grow` widens every quad on screen by that many units."""
    dt, v, out = 2 * m.pi / count, HALF_WIDTH + 0.02, ""
    for i in range(m.ceil((t1 - t0) / dt)):
        a = t0 + i * dt
        b = min(a + lap * dt, t1)
        pts = [mapping(*project(t, w)) for t, w in ((a, -v), (b, -v), (b, v), (a, v))]
        if grow:
            pts = list(MultiPoint(pts).convex_hull.buffer(grow, join_style=2).exterior.coords)[:-1]
        color = mix(BLUE, PEACH, peach_amount((a + min(a + dt, t1)) / 2))
        out += '<path fill="{}" d="M{}Z"/>'.format(color, " ".join(f"{x:.1f} {y:.1f}" for x, y in pts))
    return out


def layer(mapping, span, count, grow):
    """Two coats, both drawn without anti-aliasing: overlapping anti-aliased quads would let a little of
    whatever lies beneath show at every joint. The base coat is wider quads grown past the outline, so
    every pixel the outline touches is painted. The top coat is the fine quads that give the smooth
    blend. The masks alone anti-alias the edges."""
    return f'<g shape-rendering="crispEdges">{quads(mapping, *span, 120, 3, grow)}{quads(mapping, *span, count, 1.9)}</g>'


def drawing(mapping, label, slice_count, grow):
    return {"strip": outline(strip, label, mapping), "front": outline(front, f"{label} front layer", mapping),
            "back_layer": layer(mapping, BACK, slice_count, grow), "front_layer": layer(mapping, FRONT, slice_count, grow)}


# The base coat must reach at least a pixel past the outline at the smallest size a drawing is used at.
# The master is also used for app icons of any size, so it allows for 16 px.
MASTER = drawing(master_map(), "master", SLICES, BOX / 16 * 1.25)
SMALL = {n: drawing(fitted_map(n), f"{n}px", SMALL_SLICES, BOX / n * 1.25) for n in SMALL_SIZES}
mask_ids = itertools.count()


def symbol(fill, size=BOX, d=MASTER, standalone=True, for_pdf=False):
    """One SVG. `fill` is a color for the one-color drawings and None for the blue-to-peach drawing.
    Inline copies get their own mask ids, because each size has its own outline. `for_pdf` uses clip
    paths in place of masks: a PDF stores a mask as a bitmap, and a clip path as a vector outline."""
    head = "<title>Scient</title>" if standalone else ""
    if fill is None:
        name = "scient" if standalone else f"scient{next(mask_ids)}"
        if for_pdf:
            mask = lambda part: f'<clipPath id="{name}-{part}"><path d="{d[part]}"/></clipPath>'
        else:
            mask = lambda part: (f'<mask id="{name}-{part}" maskUnits="userSpaceOnUse" x="0" y="0" width="{BOX}" height="{BOX}">'
                                 f'<path fill="#fff" d="{d[part]}"/></mask>')
        by = "clip-path" if for_pdf else "mask"
        # Everything sits inside one mask of the outline, so the edge has exactly the coverage of the
        # one-color drawings. (A clip path would do the same job, but Chrome renders its edge heavier.)
        # The front layer is painted twice: first unmasked beneath the back layer, so the pixels along
        # its outer edge are already opaque, then inside its own mask on top, which draws the fold.
        body = (f'{mask("strip")}{mask("front")}<g {by}="url(#{name}-strip)">{d["front_layer"]}{d["back_layer"]}'
                f'<g {by}="url(#{name}-front)">{d["front_layer"]}</g></g>')
    else:
        body = f'<path fill="{fill}" d="{d["strip"]}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {BOX} {BOX}">{head}{body}</svg>'


def best(fill, size):
    """The pixel-fitted drawing where one exists, the exact master otherwise."""
    return symbol(fill, size, SMALL.get(size, MASTER), standalone=False)


def chrome(*args):
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", *args],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


for folder in ("small", "png", "pdf"):
    (OUT / folder).mkdir(exist_ok=True)
tmp = OUT / ".tmp.html"
for slug, fill in COLORINGS + [("mono", "currentColor")]:
    (OUT / f"scient-symbol-{slug}.svg").write_text(symbol(fill) + "\n")
    for n in SMALL_SIZES:
        (OUT / "small" / f"scient-symbol-{slug}-{n}.svg").write_text(symbol(fill, n, SMALL[n]) + "\n")
    if slug == "mono":
        continue
    # PNGs: one transparent sprite at 1x, then cropped, so every size is rendered by the same engine.
    x, cells, boxes = 0, "", []
    for n in PNG_SIZES:
        cells += f'<div style="position:absolute;left:{x}px;top:0">{best(fill, n)}</div>'
        boxes.append((n, x))
        x += n + 8
    tmp.write_text(f'<body style="margin:0;background:transparent">{cells}</body>')
    sprite = OUT / ".sprite.png"
    chrome("--force-device-scale-factor=1", "--default-background-color=00000000", f"--window-size={x},{max(PNG_SIZES)}",
           f"--screenshot={sprite}", f"file://{tmp}")
    for n, left in boxes:
        subprocess.run(["magick", str(sprite), "-crop", f"{n}x{n}+{left}+0", "+repage", "-strip",
                        str(OUT / "png" / f"scient-symbol-{slug}-{n}.png")], check=True)
    sprite.unlink()
    tmp.write_text(f'<style>@page{{size:{BOX}px {BOX}px;margin:0}}body{{margin:0}}svg{{display:block}}</style>{symbol(fill, for_pdf=True)}')
    chrome("--no-pdf-header-footer", f"--print-to-pdf={OUT / 'pdf' / f'scient-symbol-{slug}.pdf'}", f"file://{tmp}")
tmp.unlink()
subprocess.run(["magick", *[str(OUT / "png" / f"scient-symbol-color-{n}.png") for n in (16, 32, 48)], str(OUT / "favicon.ico")], check=True)

CSS = """*{box-sizing:border-box}body{margin:0;background:#eceef2;color:#222938;font:15px system-ui,-apple-system,sans-serif}
main{width:1180px;padding:24px;margin:auto}h1{font-size:24px;margin:0 0 6px}header p{margin:0;color:#566171}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-top:20px}
.card{background:#fff;border-radius:14px;padding:22px;text-align:center}.card.dark{background:#171b22;color:#eef0f6}
h2{font-size:13px;margin:0 0 18px;text-transform:uppercase;letter-spacing:.06em;opacity:.6}
.sizes{display:flex;gap:16px;justify-content:center;align-items:flex-end;margin-top:22px}
.sizes div{display:flex;flex-direction:column;align-items:center;gap:8px;font-size:11px}.sizes span{opacity:.6}
.picker{display:inline-flex;align-items:center;gap:8px;font-size:13px;border:1px solid #e3e6ec;border-radius:8px;padding:7px 12px;margin-top:18px}
.dark .picker{border-color:#343b48}svg{display:block}.big{display:flex;justify-content:center}"""


def card(title, fill, dark):
    sizes = "".join(f"<div>{best(fill, n)}<span>{n}</span></div>" for n in (96, 64, 48, 32, 24, 20, 16))
    return (f'<div class="card{" dark" if dark else ""}"><h2>{title}</h2><div class="big">{best(fill, 220)}</div>'
            f'<div class="sizes">{sizes}</div><div class="picker">{best(fill, 16)}<span>Scient Agent</span></div></div>')


cards = card("Color · on light", None, False) + card("Color · on dark", None, True) + card("Black", INK, False) + card("White", WHITE, True)
(OUT / "preview.html").write_text(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Scient symbol</title>'
    f"<style>{CSS}</style><main><header><h1>Scient symbol</h1>"
    "<p>Sizes are in pixels. 16 to 32 use the pixel-fitted drawings; judge them at 100% zoom.</p></header>"
    f'<div class="grid">{cards}</div></main></html>')
