#!/usr/bin/env python3
"""
Build every icon asset for Minutes from one set of SVG definitions.

    python3 scripts/build-icons.py

Outputs (paths relative to the repo root):
    build/icon.svg                     master, 512 viewBox, dark shell
    build/icon.png                     1024 x 1024
    build/icon-256.png                 256 x 256
    build/icon.ico                     16 / 24 / 32 / 48 / 64 / 128 / 256 layers
    resources/tray-icon.png            32 x 32, mark only, ink on transparent
    resources/tray-icon-recording.png  32 x 32, same + recording dot
    resources/tray-icon-16.png         16 x 16 variants of the two above
    resources/tray-icon-recording-16.png

Requires: pillow, cairosvg   (pip install --break-system-packages pillow cairosvg)

Every size is rasterised from vector by cairosvg at its own pixel size; nothing is
produced by scaling a bitmap. Sizes of 24 px and below use the "hinted" mark, a
variant whose strokes and rule pitch sit on the 16 px pixel grid (2 px strokes,
3 px pitch, tighter corner) so the small layers stay crisp.
"""
import io
import os
import struct

import cairosvg
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
RES = os.path.join(ROOT, "resources")

INK = "#1F1D1A"    # warm near-black
PAPER = "#F4F1EA"  # warm paper
RADIUS = 113       # ~22% of 512, Windows-friendly corner

# ---------------------------------------------------------------------------
# The mark. 512 x 512 coordinate space, stroked, round caps and joins.
# A short tick at 12 o'clock sweeps through a quarter arc into the first note
# rule; two shorter rules sit beneath it.
# ---------------------------------------------------------------------------
MARK_PATHS = [
    "M160 104 V112 A96 96 0 0 0 256 208 H352",
    "M160 304 H320",
    "M160 400 H288",
]
MARK_STROKE = 56

# Pixel-hinted variant for 16 px and 24 px rasters (1 px @16 = 32 units).
HINTED_PATHS = [
    "M160 104 V160 A48 48 0 0 0 208 208 H352",
    "M160 304 H320",
    "M160 400 H288",
]
HINTED_STROKE = 64

# Recording dot for the tray icon: sits in the clear space right of the third rule.
REC_DOT = (376, 400, 44)        # cx, cy, r
REC_DOT_HINTED = (384, 400, 60)  # larger so it survives 16 px


def group(paths, stroke, color):
    inner = "".join(f'<path d="{d}"/>' for d in paths)
    return (
        f'<g fill="none" stroke="{color}" stroke-width="{stroke}" '
        f'stroke-linecap="round" stroke-linejoin="round">{inner}</g>'
    )


def icon_svg(bg=INK, fg=PAPER, hinted=False, size_attr=True):
    paths, sw = (HINTED_PATHS, HINTED_STROKE) if hinted else (MARK_PATHS, MARK_STROKE)
    wh = ' width="512" height="512"' if size_attr else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"{wh}>'
        f'<rect width="512" height="512" rx="{RADIUS}" fill="{bg}"/>'
        f"{group(paths, sw, fg)}</svg>"
    )


def tray_svg(color=INK, recording=False, hinted=False):
    paths, sw = (HINTED_PATHS, HINTED_STROKE) if hinted else (MARK_PATHS, MARK_STROKE)
    dot = ""
    if recording:
        cx, cy, r = REC_DOT_HINTED if hinted else REC_DOT
        dot = f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}"/>'
    # Tray glyphs are drawn larger in their box than the app icon mark (no shell
    # to clear), so the 512 space is cropped to the mark's bounds plus padding.
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 48 352 416">'
        f"{group(paths, sw, color)}{dot}</svg>"
    )


def raster(svg, px):
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def write_ico(path, images):
    """Write a multi-layer ICO with PNG-compressed entries (Vista+ format, which
    is what electron-builder / Windows expect, including the 256 px layer)."""
    entries = []
    for im in images:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        entries.append((im.width, im.height, buf.getvalue()))
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_entries, blobs = [], []
    for w, h, data in entries:
        dir_entries.append(
            struct.pack(
                "<BBBBHHII",
                0 if w >= 256 else w,
                0 if h >= 256 else h,
                0, 0, 1, 32, len(data), offset,
            )
        )
        blobs.append(data)
        offset += len(data)
    with open(path, "wb") as f:
        f.write(header + b"".join(dir_entries) + b"".join(blobs))


def main():
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(RES, exist_ok=True)

    # Master SVG
    with open(os.path.join(BUILD, "icon.svg"), "w") as f:
        f.write(icon_svg())

    # PNGs
    raster(icon_svg(), 1024).save(os.path.join(BUILD, "icon.png"))
    raster(icon_svg(), 256).save(os.path.join(BUILD, "icon-256.png"))

    # ICO: each layer rasterised at its own size
    layers = []
    for px in (16, 24, 32, 48, 64, 128, 256):
        layers.append(raster(icon_svg(hinted=px <= 24), px))
    write_ico(os.path.join(BUILD, "icon.ico"), layers)

    # Tray icons: ink on transparent
    raster(tray_svg(), 32).save(os.path.join(RES, "tray-icon.png"))
    raster(tray_svg(recording=True), 32).save(os.path.join(RES, "tray-icon-recording.png"))
    raster(tray_svg(hinted=True), 16).save(os.path.join(RES, "tray-icon-16.png"))
    raster(tray_svg(recording=True, hinted=True), 16).save(
        os.path.join(RES, "tray-icon-recording-16.png")
    )
    print("icons written to build/ and resources/")


if __name__ == "__main__":
    main()
