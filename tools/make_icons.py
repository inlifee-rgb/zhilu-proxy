#!/usr/bin/env python3
"""Generate extension PNG icons with Python stdlib only (no Pillow)."""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SCALE = 4
N = 128 * SCALE


def dist_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def inside_rounded(px, py, size, radius):
    cx = min(max(px, radius), size - radius)
    cy = min(max(py, radius), size - radius)
    return math.hypot(px - cx, py - cy) <= radius


def render_master():
    px = bytearray(N * N * 4)
    c = 64.0 * SCALE          # center
    r = 41.0 * SCALE          # globe radius
    route = [(17, 92), (43, 68), (59, 81), (111, 36)]
    route = [(x * SCALE, y * SCALE) for x, y in route]

    for y in range(N):
        for x in range(N):
            i = (y * N + x) * 4
            if not inside_rounded(x, y, N, 29 * SCALE):
                px[i + 3] = 0
                continue

            t = (x / N) * 0.55 + (y / N) * 0.45
            bg = (
                int(79 + (29 - 79) * t),
                int(141 + (78 - 141) * t),
                int(247 + (216 - 247) * t),
            )

            dx, dy = x - c, y - c
            d = math.hypot(dx, dy)
            # globe outline
            on_globe = abs(d - r) <= 2.3 * SCALE
            # meridian (vertical ellipse)
            rx = r * 0.43
            on_meridian = abs(((dx / rx) ** 2 + (dy / r) ** 2) - 1.0) < 0.075 and abs(dx) < rx * 1.05
            # equator
            on_equator = abs(dy) <= 1.9 * SCALE and abs(dx) < r * 0.97

            route_d = min(dist_seg(x, y, route[k][0], route[k][1], route[k + 1][0], route[k + 1][1])
                          for k in range(len(route) - 1))
            on_route = route_d <= 3.1 * SCALE

            color = bg
            if on_route:
                color = (191, 219, 254)
            if on_globe or on_meridian or on_equator:
                color = (255, 255, 255)

            px[i], px[i + 1], px[i + 2] = color
            px[i + 3] = 255
    return px


def downsample(px, size):
    step = 128 // size
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for yy in range(y * step, (y + 1) * step):
                for xx in range(x * step, (x + 1) * step):
                    i = (yy * N + xx) * 4
                    for k in range(4):
                        acc[k] += px[i + k]
            n = step * step
            j = (y * size + x) * 4
            for k in range(4):
                out[j + k] = acc[k] // n
    return out


def png(size, data):
    raw = b"".join(b"\x00" + bytes(data[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    def chunk(tag, payload):
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    master = render_master()
    for size in (16, 32, 48, 128):
        target = OUT / f"icon{size}.png"
        target.write_bytes(png(size, downsample(master, size)))
        print(f"OK {target.name} {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
