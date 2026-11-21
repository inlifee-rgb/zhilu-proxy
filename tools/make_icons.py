#!/usr/bin/env python3
"""Generate extension PNG icons from the REAL MIAO brand SVG, stdlib only.

Rasterizes SVG <path> (M/L/C/Q/Z, absolute+relative) AND <ellipse>/<circle>
with a scanline fill + disk stroke on a supersampled canvas, then box-downsamples
to 16/32/48/128 PNG. No Pillow / cairosvg needed — pure Python standard library.

Note: <ellipse> matters — the MIAO logo's OPEN eye, eye highlight and blush are
ellipses. Older versions only handled <path>, which dropped the open eye and made
the logo look closed-eyed. Fixed 2026-11-21.

Source: tools/brand/miao-app-icon.svg (vendored copy of MIAO brand asset)
"""
from __future__ import annotations

import re
import struct
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SVG = Path(__file__).resolve().parent / "brand" / "miao-app-icon.svg"
SS = 4                 # supersample factor
N = 128 * SS           # 512x512 master canvas (SVG viewBox is 512)

# ---------- color ----------
NAMED_COLORS = {
    "white": "#FFFFFF", "black": "#000000", "red": "#FF0000",
    "transparent": "none",
}

def hexcolor(s: str):
    if not s or s == "none":
        return None
    s = s.strip()
    s = NAMED_COLORS.get(s.lower(), s).lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) == 8:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), int(s[7:9], 16))
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 255)

# ---------- SVG path tokenizer ----------
TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")

def parse_path(d: str):
    """Return list of subpaths; each subpath is a list of (x,y) sampled points."""
    toks = TOKEN.findall(d)
    i = 0
    subpaths, cur = [], []
    x = y = 0.0
    sx = sy = 0.0
    cmd = None
    nums = []

    def take(n):
        nonlocal i
        out = [float(v) for v in toks[i:i + n]]
        i += n
        return out

    def bezier3(p0, p1, p2, p3, steps=18):
        out = []
        for k in range(1, steps + 1):
            t = k / steps
            u = 1 - t
            out.append((
                u**3 * p0[0] + 3 * u*u*t * p1[0] + 3 * u*t*t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u*u*t * p1[1] + 3 * u*t*t * p2[1] + t**3 * p3[1],
            ))
        return out

    def bezier2(p0, p1, p2, steps=14):
        out = []
        for k in range(1, steps + 1):
            t = k / steps
            u = 1 - t
            out.append((
                u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0],
                u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1],
            ))
        return out

    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd = t
            i += 1
            if cmd in "Zz":
                if cur:
                    subpaths.append(cur)
                    cur = []
                x, y = sx, sy
                continue
        if cmd is None:
            i += 1
            continue
        c = cmd.upper()
        rel = cmd.islower()

        if c == "M":
            nx, ny = take(2)
            if rel: nx += x; ny += y
            if cur: subpaths.append(cur)
            cur = [(nx, ny)]
            x, y = sx, sy = nx, ny
            cmd = "l" if rel else "L"
        elif c == "L":
            nx, ny = take(2)
            if rel: nx += x; ny += y
            cur.append((nx, ny)); x, y = nx, ny
        elif c == "H":
            (nx,) = take(1)
            if rel: nx += x
            cur.append((nx, y)); x = nx
        elif c == "V":
            (ny,) = take(1)
            if rel: ny += y
            cur.append((x, ny)); y = ny
        elif c == "C":
            a = take(6)
            p1 = (a[0] + x, a[1] + y) if rel else (a[0], a[1])
            p2 = (a[2] + x, a[3] + y) if rel else (a[2], a[3])
            p3 = (a[4] + x, a[5] + y) if rel else (a[4], a[5])
            cur.extend(bezier3((x, y), p1, p2, p3)); x, y = p3
        elif c == "S":
            a = take(4)
            p2 = (a[0] + x, a[1] + y) if rel else (a[0], a[1])
            p3 = (a[2] + x, a[3] + y) if rel else (a[2], a[3])
            cur.extend(bezier3((x, y), (x, y), p2, p3)); x, y = p3
        elif c == "Q":
            a = take(4)
            p1 = (a[0] + x, a[1] + y) if rel else (a[0], a[1])
            p2 = (a[2] + x, a[3] + y) if rel else (a[2], a[3])
            cur.extend(bezier2((x, y), p1, p2)); x, y = p2
        elif c == "T":
            a = take(2)
            p2 = (a[0] + x, a[1] + y) if rel else (a[0], a[1])
            cur.extend(bezier2((x, y), (x, y), p2)); x, y = p2
        elif c == "A":
            take(7)  # arcs not used in this asset; skip safely
        else:
            i += 1
    if cur:
        subpaths.append(cur)
    return [p for p in subpaths if len(p) >= 2]

# ---------- SVG tree walk (inherit group attrs + transform) ----------
def collect_paths(svg_path: Path):
    root = ET.parse(svg_path).getroot()
    shapes = []
    def walk(elem, inherited):
        attrs = dict(inherited)
        for k in ("fill", "stroke", "stroke-width", "transform"):
            if k in elem.attrib:
                attrs[k] = elem.attrib[k]
        if elem.tag.endswith("path") and "d" in elem.attrib:
            out = dict(attrs)
            out["d"] = elem.attrib["d"]
            shapes.append(out)
        elif elem.tag.endswith("ellipse"):
            out = dict(attrs)
            out["_ellipse"] = (
                float(elem.attrib.get("cx", 0)), float(elem.attrib.get("cy", 0)),
                float(elem.attrib.get("rx", 0)), float(elem.attrib.get("ry", 0)),
            )
            shapes.append(out)
        elif elem.tag.endswith("circle"):
            r = float(elem.attrib.get("r", 0))
            out = dict(attrs)
            out["_ellipse"] = (
                float(elem.attrib.get("cx", 0)), float(elem.attrib.get("cy", 0)), r, r,
            )
            shapes.append(out)
        for ch in elem:
            walk(ch, attrs)
    walk(root, {})
    return shapes, root.attrib

def apply_transform(points, transform):
    if not transform:
        return points
    m = re.search(r"translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)", transform)
    s = re.search(r"scale\(\s*([-\d.]+)(?:[ ,]+([-\d.]+))?\s*\)", transform)
    tx, ty = (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)
    sx, sy = (float(s.group(1)), float(s.group(2) or s.group(1))) if s else (1.0, 1.0)
    return [(x * sx + tx, y * sy + ty) for (x, y) in points]

# Ellipse -> closed point ring via 4 cubic Beziers (kappa approximation).
KAPPA = 0.5522847498307936

def ellipse_points(cx, cy, rx, ry, steps=24):
    """Sample an ellipse outline into a closed ring of points."""
    if rx <= 0 or ry <= 0:
        return []
    k = KAPPA
    # 4 quadrant cubic segments in absolute coords
    segs = [
        ((cx + rx, cy), (cx + rx, cy + k * ry), (cx + k * rx, cy + ry), (cx, cy + ry)),
        ((cx, cy + ry), (cx - k * rx, cy + ry), (cx - rx, cy + k * ry), (cx - rx, cy)),
        ((cx - rx, cy), (cx - rx, cy - k * ry), (cx - k * rx, cy - ry), (cx, cy - ry)),
        ((cx, cy - ry), (cx + k * rx, cy - ry), (cx + rx, cy - k * ry), (cx + rx, cy)),
    ]
    out = []
    for p0, p1, p2, p3 in segs:
        for n in range(1, steps + 1):
            t = n / steps
            u = 1 - t
            out.append((
                u**3 * p0[0] + 3 * u*u*t * p1[0] + 3 * u*t*t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u*u*t * p1[1] + 3 * u*t*t * p2[1] + t**3 * p3[1],
            ))
    return out

# ---------- raster primitives ----------
def setpx(px, x, y, color):
    if 0 <= x < N and 0 <= y < N:
        i = (y * N + x) * 4
        px[i], px[i+1], px[i+2], px[i+3] = color

def fill(px, points, color):
    ys = [p[1] for p in points]
    y0 = max(0, int(min(ys))); y1 = min(N - 1, int(max(ys)))
    n = len(points)
    for py in range(y0, y1 + 1):
        sy = py + 0.5
        xs = []
        for i in range(n):
            x1, ya = points[i]; x2, yb = points[(i + 1) % n]
            if (ya <= sy < yb) or (yb <= sy < ya):
                xs.append(x1 + (sy - ya) * (x2 - x1) / (yb - ya))
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            xa, xb = int(xs[k]), int(xs[k + 1])
            for x in range(max(0, xa), min(N - 1, xb) + 1):
                setpx(px, x, py, color)

def disk(px, cx, cy, r, color):
    x0 = max(0, int(cx - r - 1)); x1 = min(N - 1, int(cx + r + 1))
    y0 = max(0, int(cy - r - 1)); y1 = min(N - 1, int(cy + r + 1))
    r2 = r * r
    for y in range(y0, y1 + 1):
        dy = y + 0.5 - cy
        for x in range(x0, x1 + 1):
            dx = x + 0.5 - cx
            if dx*dx + dy*dy <= r2:
                setpx(px, x, y, color)

def stroke(px, subpaths, color, width):
    r = max(0.6, width / 2.0)
    for pts in subpaths:
        for (x, y) in pts:
            disk(px, x, y, r, color)
        # connect sampled points so long segments stay continuous
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            steps = max(1, int(max(abs(x2-x1), abs(y2-y1)) / max(1.0, r)))
            for k in range(1, steps):
                t = k / steps
                disk(px, x1 + (x2-x1)*t, y1 + (y2-y1)*t, r, color)

# ---------- png ----------
def png(size, data):
    raw = b"".join(b"\x00" + bytes(data[y*size*4:(y+1)*size*4]) for y in range(size))
    def chunk(tag, payload):
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))

def downsample(px, size):
    step = N // size
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for yy in range(y*step, (y+1)*step):
                for xx in range(x*step, (x+1)*step):
                    i = (yy*N + xx) * 4
                    a = px[i+3]
                    for k in range(3):
                        acc[k] += px[i+k] * a   # premultiplied for correct AA
                    acc[3] += a
            j = (y*size + x) * 4
            if acc[3]:
                for k in range(3):
                    out[j+k] = acc[k] // acc[3]
                out[j+3] = acc[3] // (step*step)
    return out

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    shapes, root_attrs = collect_paths(SVG)
    px = bytearray(N * N * 4)
    vb = [float(v) for v in root_attrs.get("viewBox", "0 0 512 512").split()]
    scale = N / vb[2] if vb[2] else 1.0
    count = 0
    for sh in shapes:
        if "_ellipse" in sh:
            ring = ellipse_points(*sh["_ellipse"])
            subs = [apply_transform(ring, sh.get("transform"))] if ring else []
        else:
            subs = parse_path(sh["d"])
            subs = [apply_transform(p, sh.get("transform")) for p in subs]
        # scale from viewBox units to canvas pixels
        subs = [[(x*scale, y*scale) for (x, y) in p] for p in subs]
        fill_c = hexcolor(sh.get("fill", "#000000"))
        if fill_c:
            for p in subs:
                fill(px, p, fill_c)
        stroke_c = hexcolor(sh.get("stroke"))
        try:
            sw = float(sh.get("stroke-width", "1")) * scale
        except ValueError:
            sw = 1.0
        if stroke_c:
            stroke(px, subs, stroke_c, sw)
        count += 1
    print(f"Rasterized {count} paths from {SVG.name}")
    for size in (16, 32, 48, 128):
        target = OUT / f"icon{size}.png"
        target.write_bytes(png(size, downsample(px, size)))
        print(f"OK {target.name} {target.stat().st_size} bytes")
    # favicon.ico (single 32x32 image in ICO container)
    ico = OUT / "favicon.ico"
    img32 = png(32, downsample(px, 32))
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(img32), 6 + 16)
    ico.write_bytes(header + entry + img32)
    print(f"OK {ico.name} {ico.stat().st_size} bytes")

if __name__ == "__main__":
    main()
