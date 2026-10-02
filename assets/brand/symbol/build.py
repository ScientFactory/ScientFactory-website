"""Builds the Scient symbol kit: exact SVG masters, pixel-fitted small sizes, PNGs, PDFs and a favicon.

The shape is the orthographic projection of the standard Möbius strip
    x = (1 + v cos(t/2)) cos t,  y = (1 + v cos(t/2)) sin t,  z = v sin(t/2),  |v| <= 0.36
turned 0.45 rad about z and viewed from 57 degrees.
A fine mesh of the surface is unioned, then each outline is fitted with a few cubic Beziers whose
nodes sit on the corners and on the horizontal and vertical extremes.

Needs shapely, Google Chrome and ImageMagick:
    python3 -m venv .venv && .venv/bin/pip install shapely && .venv/bin/python build.py
"""
import math as m
import subprocess
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

OUT = Path(__file__).parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HALF_WIDTH, SPIN, ELEVATION = 0.36, 0.45, m.radians(57)
ACCENT_END = 35 * 2 * m.pi / 128  # the accent runs along the strip from t = 0 to this ruling
LAP = 0.23  # how far the body continues behind each straight edge of the accent
BOX, STEPS, TOLERANCE = 512, 4096, 0.02
BLUE, CORAL, INK, WHITE = "#4D9ABF", "#F09082", "#252B32", "#FFFFFF"
COLORINGS = [("color", BLUE, CORAL), ("black", INK, INK), ("white", WHITE, WHITE)]
SMALL_SIZES = (16, 20, 24, 32)
PNG_SIZES = (16, 20, 24, 32, 48, 64, 128, 256, 512, 1024)


def project(t, v):
    r = 1 + v * m.cos(t / 2)
    x, y, z = r * m.cos(t), r * m.sin(t), v * m.sin(t / 2)
    x, y = x * m.cos(SPIN) - y * m.sin(SPIN), x * m.sin(SPIN) + y * m.cos(SPIN)
    return x, -(y * m.sin(ELEVATION) + z * m.cos(ELEVATION))


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
strip, accent = region(0, 2 * m.pi + 0.02, STEPS), region(0, ACCENT_END, STEPS // 4)
# In the two-color drawing the body is cut away under the accent, except for a lap behind each
# straight edge, so no background shows at the joint and no blue fringes the accent's curved edges.
body = strip.difference(region(LAP, ACCENT_END - LAP, STEPS // 4))
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


def paths(mapping, label):
    return {k: outline(g, f"{label} {k}", mapping) for k, g in (("strip", strip), ("body", body), ("accent", accent))}


MASTER = paths(master_map(), "master")
SMALL = {n: paths(fitted_map(n), f"{n}px") for n in SMALL_SIZES}


def symbol(body_color, accent_color, size=BOX, d=MASTER, standalone=True):
    two = accent_color != body_color
    accent_path = f'<path fill="{accent_color}" d="{d["accent"]}"/>' if two else ""
    head = '<title>Scient</title>' if standalone else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {BOX} {BOX}">{head}'
            f'<path fill="{body_color}" d="{d["body"] if two else d["strip"]}"/>{accent_path}</svg>')


def best(body_color, accent_color, size):
    """The pixel-fitted drawing where one exists, the exact master otherwise."""
    return symbol(body_color, accent_color, size, SMALL.get(size, MASTER), standalone=False)


def chrome(*args):
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", *args],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


for folder in ("small", "png", "pdf"):
    (OUT / folder).mkdir(exist_ok=True)
tmp = OUT / ".tmp.html"
for slug, body_color, acc in COLORINGS + [("mono", "currentColor", "currentColor")]:
    (OUT / f"scient-symbol-{slug}.svg").write_text(symbol(body_color, acc) + "\n")
    for n in SMALL_SIZES:
        (OUT / "small" / f"scient-symbol-{slug}-{n}.svg").write_text(symbol(body_color, acc, n, SMALL[n]) + "\n")
    if slug == "mono":
        continue
    # PNGs: one transparent sprite at 1x, then cropped, so every size is rendered by the same engine.
    x, cells, boxes = 0, "", []
    for n in PNG_SIZES:
        cells += f'<div style="position:absolute;left:{x}px;top:0">{best(body_color, acc, n)}</div>'
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
    tmp.write_text(f'<style>@page{{size:{BOX}px {BOX}px;margin:0}}body{{margin:0}}svg{{display:block}}</style>{symbol(body_color, acc)}')
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


def card(title, body_color, acc, dark):
    sizes = "".join(f"<div>{best(body_color, acc, n)}<span>{n}</span></div>" for n in (96, 64, 48, 32, 24, 20, 16))
    return (f'<div class="card{" dark" if dark else ""}"><h2>{title}</h2><div class="big">{best(body_color, acc, 220)}</div>'
            f'<div class="sizes">{sizes}</div><div class="picker">{best(body_color, acc, 16)}<span>Scient Agent</span></div></div>')


cards = (card("Color · on light", BLUE, CORAL, False) + card("Color · on dark", BLUE, CORAL, True)
         + card("Black", INK, INK, False) + card("White", WHITE, WHITE, True))
(OUT / "preview.html").write_text(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Scient symbol</title>'
    f"<style>{CSS}</style><main><header><h1>Scient symbol</h1>"
    "<p>Sizes are in pixels. 16 to 32 use the pixel-fitted drawings; judge them at 100% zoom.</p></header>"
    f'<div class="grid">{cards}</div></main></html>')
