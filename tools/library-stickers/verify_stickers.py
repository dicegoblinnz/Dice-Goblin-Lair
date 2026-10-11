#!/usr/bin/env python3
"""Checks a sticker PDF the way the printer will see it.

Every page 150 x 100 mm; nothing but pure black and white (the logos' shapes included); every QR code scanned from a
203 dpi one-bit render (a thermal printer's resolution) and matched to the game it should hold; and ink only where it
belongs, by layout (see library_stickers.LAYOUTS):
  box        every sticker's ink inside its 4 mm margin.
  box-label  the same for the stickers, which end above the spine labels' strip; each spine label inside its square
             with SPINE_CLEAR to spare, and nothing else in the strip.
  spine      each tall sticker's ink inside its cut piece with TALL_CLEAR to spare, and nothing in a page's empty places.

Usage: python3 verify_stickers.py stickers.pdf games.json [render_dir] [--layout=box|box-label|spine]
"""
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
import zxingcpp
from PIL import Image
from pypdf import PdfReader

from library_stickers import (LABEL_W, LAYOUTS, PAGE_W, SPINE_PIECE, SPINE_STRIP, TALL, shelf_order, spine_piece_x,
                              tall_pages)

MM = 72 / 25.4
DPI = 203
PT_PX = DPI / 72  # pixels per point at the printer's resolution
SPINE_CLEAR = 2.0  # mm of clear space round the spine label inside its square
TALL_CLEAR = 1.6  # mm of clear space inside a tall sticker's cut lines (its outline sits 2 mm in)
TOLERANCE = 0.6 * DPI / 25.4  # anti-aliasing and rounding at 203 dpi
DASH = int(1.2 * DPI / 25.4)  # half the width of the strip a dashed cut line is left out with
LINE = int(0.35 * DPI / 25.4) + 1  # the same for a tall sticker's cut lines: just the 0.25 mm line, so ink beside it shows


def colours_used(reader):
    """Every fill and stroke colour set in the pages and the forms they draw (the logos)."""
    colours = set()
    for page in reader.pages:
        streams = [page.get_contents().get_data()]
        xobjects = page['/Resources'].get('/XObject', {}) if '/Resources' in page else {}
        for name in xobjects:
            streams.append(xobjects[name].get_object().get_data())
        for data in streams:
            text = data.decode('latin-1')
            for m in re.finditer(r'([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+(rg|RG)\b', text):
                colours.add(tuple(float(v) for v in m.groups()[:3]))
            for m in re.finditer(r'([-\d.]+)\s+(g|G)\b', text):
                colours.add((float(m.group(1)),) * 3)
    return colours


def read_qr(crop):
    return [r.text for r in zxingcpp.read_barcodes(crop) if r.format == zxingcpp.BarcodeFormat.QRCode]


def clearance(region):
    """The ink's distance from the region's four edges, in pixels (None if there's no ink)."""
    ys, xs = np.nonzero(region)
    if not len(xs):
        return None
    return xs.min(), region.shape[1] - 1 - xs.max(), ys.min(), region.shape[0] - 1 - ys.max()


def check_box_page(n, img, ink, games, spine, problems):
    """Two 75 x 100 mm stickers (with spine labels underneath when spine). Returns the QR codes matched."""
    H, W = ink.shape
    half = W // 2
    margin_px = 4 * DPI / 25.4
    strip = int(round(SPINE_STRIP * PT_PX)) if spine else 0  # the spine labels' strip along the bottom
    scanned = 0
    if spine:
        # nothing in the strip but the spine labels and the cut lines
        rest = ink[H - strip:, :].copy()
        for side in range(2):
            px = int(round(spine_piece_x(side) * PT_PX))
            rest[:, px:px + int(round(SPINE_PIECE * PT_PX))] = False
        rest[:DASH, :] = False
        for x in (LABEL_W - SPINE_PIECE, LABEL_W, LABEL_W + SPINE_PIECE):
            xp = int(round(x * PT_PX))
            rest[:, max(0, xp - DASH):xp + DASH] = False
        if rest.any():
            problems.append(f'page {n + 1}: ink in the spine strip outside the spine labels')
    for side, game in enumerate(games):
        x0, x1 = side * half, (side + 1) * half
        region = ink[:H - strip, x0:x1].copy()
        # leave out the dashed cut lines, which sit on the shared edges
        if side == 0:
            region[:, -DASH:] = False
        else:
            region[:, :DASH] = False
        if spine:
            region[-DASH:, :] = False
            # the spine label: inside its square with SPINE_CLEAR to spare, cut lines left out
            px0 = int(round(spine_piece_x(side) * PT_PX))
            px1 = px0 + int(round(SPINE_PIECE * PT_PX))
            piece = ink[H - strip:, px0:px1].copy()
            piece[:LINE, :] = False
            piece[:, :LINE] = False
            piece[:, -LINE:] = False
            room = clearance(piece)
            if room is None:
                problems.append(f"{game['code']}: no spine label")
            elif min(room) < SPINE_CLEAR * DPI / 25.4 - TOLERANCE:
                problems.append(f"{game['code']}: spine label ink {min(room) * 25.4 / DPI:.2f} mm from its square's edge")
        room = clearance(region)
        if room and min(room) < margin_px - TOLERANCE:
            left, right, top, bottom = (v * 25.4 / DPI for v in room)
            problems.append(f"{game['code']}: ink {min(room) * 25.4 / DPI:.2f} mm from the edge "
                            f"(left {left:.1f}, right {right:.1f}, top {top:.1f}, bottom {bottom:.1f})")
        found = read_qr(img.crop((x0, 0, x1, H - strip)))
        if found != [game['qr']]:
            problems.append(f"{game['code']}: QR read {found}, expected {[game['qr']]}")
        else:
            scanned += 1
    return scanned


def check_tall_page(n, img, ink, kind, games, problems):
    """Three wide or five narrow tall stickers. Returns the QR codes matched."""
    H, W = ink.shape
    w = TALL[kind]['w']
    places = round(PAGE_W / w)
    scanned = 0
    for j in range(places):
        x0, x1 = int(round(j * w * PT_PX)), min(W, int(round((j + 1) * w * PT_PX)))
        region = ink[:, x0:x1].copy()
        if j > 0:
            region[:, :LINE] = False
        if j < places - 1:
            region[:, -LINE:] = False
        if j >= len(games):
            if region.any():
                problems.append(f'page {n + 1}: ink in empty place {j + 1}')
            continue
        game = games[j]
        room = clearance(region)
        if room is None:
            problems.append(f"{game['code']}: nothing printed")
            continue
        if min(room) < TALL_CLEAR * DPI / 25.4 - TOLERANCE:
            left, right, top, bottom = (v * 25.4 / DPI for v in room)
            problems.append(f"{game['code']}: ink {min(room) * 25.4 / DPI:.2f} mm from its cut lines "
                            f"(left {left:.1f}, right {right:.1f}, top {top:.1f}, bottom {bottom:.1f})")
        found = read_qr(img.crop((x0, 0, x1, H)))
        if found != [game['qr']]:
            problems.append(f"{game['code']}: QR read {found}, expected {[game['qr']]}")
        else:
            scanned += 1
    return scanned


def main(pdf, games_path, render_dir=None, layout='box'):
    games = sorted(json.load(open(games_path, encoding='utf-8')), key=lambda g: shelf_order(g['code']))
    if layout == 'spine':
        plan = tall_pages(games)
    else:
        plan = [(None, games[i:i + 2]) for i in range(0, len(games), 2)]
    reader = PdfReader(pdf)
    problems = []
    if len(reader.pages) != len(plan):
        problems.append(f'{len(reader.pages)} pages, expected {len(plan)}')
    for n, page in enumerate(reader.pages, 1):
        w, h = float(page.mediabox.width) / MM, float(page.mediabox.height) / MM
        if abs(w - 150) > 0.01 or abs(h - 100) > 0.01:
            problems.append(f'page {n} is {w:.2f} x {h:.2f} mm')
    colours = colours_used(reader)
    off = [c for c in colours if c not in {(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)}]
    if off:
        problems.append(f'colours other than black and white: {off}')

    out = render_dir or tempfile.mkdtemp(prefix='stickers-')
    os.makedirs(out, exist_ok=True)
    subprocess.run(['pdftoppm', '-r', str(DPI), '-mono', '-png', pdf, os.path.join(out, 'v203')], check=True)
    pngs = sorted((f for f in os.listdir(out) if f.startswith('v203')), key=lambda f: int(re.findall(r'\d+', f)[-1]))

    scanned = 0
    for n, (name, (kind, page_games)) in enumerate(zip(pngs, plan)):
        img = Image.open(os.path.join(out, name)).convert('L')
        ink = np.array(img) < 128
        if layout == 'spine':
            scanned += check_tall_page(n, img, ink, kind, page_games, problems)
        else:
            scanned += check_box_page(n, img, ink, page_games, layout == 'box-label', problems)

    print(f'{len(reader.pages)} pages, {len(games)} stickers, {scanned} QR codes scanned and matched')
    print('colours used:', sorted(colours))
    if problems:
        print(f'{len(problems)} problem(s):')
        for p in problems:
            print(' -', p)
        sys.exit(1)
    print('all good')


if __name__ == '__main__':
    flags = [a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--layout=')]
    layout = flags[-1] if flags else 'box'
    if layout not in LAYOUTS:
        sys.exit(f"--layout is {', '.join(LAYOUTS)}")
    main(*[a for a in sys.argv[1:] if not a.startswith('--')][:3], layout=layout)
