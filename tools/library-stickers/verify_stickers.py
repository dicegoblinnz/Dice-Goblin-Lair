#!/usr/bin/env python3
"""Checks a sticker PDF the way the printer will see it.

Every page 150 x 100 mm; nothing but pure black and white; every sticker's ink inside its 4 mm margin; every QR code
scanned from a 203 dpi one-bit render (a thermal printer's resolution) and matched to the game it should hold.

Usage: python3 verify_stickers.py stickers.pdf games.json [render_dir]
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

MM = 72 / 25.4
DPI = 203


def main(pdf, games_path, render_dir=None):
    games = sorted(json.load(open(games_path, encoding='utf-8')), key=lambda g: g['code'])
    reader = PdfReader(pdf)
    problems = []

    want_pages = (len(games) + 1) // 2
    if len(reader.pages) != want_pages:
        problems.append(f'{len(reader.pages)} pages, expected {want_pages}')

    colours = set()
    for n, page in enumerate(reader.pages, 1):
        w, h = float(page.mediabox.width) / MM, float(page.mediabox.height) / MM
        if abs(w - 150) > 0.01 or abs(h - 100) > 0.01:
            problems.append(f'page {n} is {w:.2f} x {h:.2f} mm')
        data = page.get_contents().get_data().decode('latin-1')
        for m in re.finditer(r'([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+(rg|RG)\b', data):
            colours.add(tuple(float(v) for v in m.groups()[:3]))
        for m in re.finditer(r'([-\d.]+)\s+(g|G)\b', data):
            colours.add((float(m.group(1)),) * 3)
    off = [c for c in colours if c not in {(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)}]
    if off:
        problems.append(f'colours other than black and white: {off}')

    out = render_dir or tempfile.mkdtemp(prefix='stickers-')
    subprocess.run(['pdftoppm', '-r', str(DPI), '-mono', '-png', pdf, os.path.join(out, 'v203')], check=True)
    pngs = sorted((f for f in os.listdir(out) if f.startswith('v203')), key=lambda f: int(re.findall(r'\d+', f)[-1]))

    margin_px = 4 * DPI / 25.4
    tolerance = 0.6 * DPI / 25.4  # anti-aliasing and rounding at 203 dpi
    scanned = 0
    for n, name in enumerate(pngs):
        img = Image.open(os.path.join(out, name)).convert('L')
        ink = np.array(img) < 128
        H, W = ink.shape
        half = W // 2
        for side in range(2):
            idx = n * 2 + side
            if idx >= len(games):
                continue
            game = games[idx]
            x0, x1 = side * half, (side + 1) * half
            region = ink[:, x0:x1].copy()
            # leave out the dashed cut line, which sits on the shared edge
            if side == 0:
                region[:, -int(1.2 * DPI / 25.4):] = False
            else:
                region[:, :int(1.2 * DPI / 25.4)] = False
            ys, xs = np.nonzero(region)
            if len(xs):
                left, right = xs.min(), half - 1 - xs.max()
                top, bottom = ys.min(), H - 1 - ys.max()
                tight = min(left, right, top, bottom)
                if tight < margin_px - tolerance:
                    problems.append(f"{game['code']}: ink {tight * 25.4 / DPI:.2f} mm from the edge "
                                    f"(left {left * 25.4 / DPI:.1f}, right {right * 25.4 / DPI:.1f}, "
                                    f"top {top * 25.4 / DPI:.1f}, bottom {bottom * 25.4 / DPI:.1f})")
            crop = img.crop((x0, 0, x1, H))
            found = [r.text for r in zxingcpp.read_barcodes(crop) if r.format == zxingcpp.BarcodeFormat.QRCode]
            if found != [game['qr']]:
                problems.append(f"{game['code']}: QR read {found}, expected {[game['qr']]}")
            else:
                scanned += 1

    print(f'{len(reader.pages)} pages, {len(games)} stickers, {scanned} QR codes scanned and matched')
    print('colours used:', sorted(colours))
    if problems:
        print(f'{len(problems)} problem(s):')
        for p in problems:
            print(' -', p)
        sys.exit(1)
    print('all good')


if __name__ == '__main__':
    main(*sys.argv[1:4])
