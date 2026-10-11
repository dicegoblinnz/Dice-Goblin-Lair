#!/usr/bin/env python3
"""Checks the logo option samples as the printer and a phone would see them: every QR code read from the 203 dpi
one-bit render (zxing and OpenCV), and from 'phone photos' of each sticker (a lower resolution, blurred, turned and
tilted), every sticker's ink inside its 4 mm margin, and nothing but black and white in the page or its forms."""
import os
import re
import subprocess
import sys
import tempfile

import cv2
import numpy as np
import zxingcpp
from PIL import Image, ImageFilter
from pypdf import PdfReader

DPI = 203
EXPECT = ['DGL56-004', 'DGL7+-001']


def reads(img):
    z = [r.text for r in zxingcpp.read_barcodes(img) if r.format == zxingcpp.BarcodeFormat.QRCode]
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(np.array(img.convert('L')))
    return z, text


def phone(crop, scale, blur, angle, tilt):
    """A rough phone photo: fewer pixels, soft focus, turned, and seen a little from one side."""
    g = crop.convert('L')
    g = g.resize((int(g.width * scale), int(g.height * scale)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(blur))
    g = g.rotate(angle, expand=True, fillcolor=255)
    a = np.array(g)
    h, w = a.shape
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    d = tilt * w
    dst = np.float32([[d, 0], [w - d, d], [w, h - d], [0, h]])
    a = cv2.warpPerspective(a, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=255)
    noise = np.random.default_rng(1).normal(0, 6, a.shape)
    return Image.fromarray(np.clip(a + noise, 0, 255).astype(np.uint8))


def main(pdf):
    problems = []
    reader = PdfReader(pdf)
    colours = set()
    for page in reader.pages:
        streams = [page.get_contents().get_data()]
        xobjects = page['/Resources'].get('/XObject', {})
        for name in xobjects:
            streams.append(xobjects[name].get_object().get_data())
        for data in streams:
            text = data.decode('latin-1')
            for m in re.finditer(r'([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+(rg|RG)\b', text):
                colours.add(tuple(float(v) for v in m.groups()[:3]))
            for m in re.finditer(r'([-\d.]+)\s+(g|G)\b', text):
                colours.add((float(m.group(1)),) * 3)
            if re.search(r'/Im\d|BI\b', text):
                problems.append('an image is embedded (the logos should be shapes)')
    off = [c for c in colours if c not in {(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)}]
    if off:
        problems.append(f'colours other than black and white: {off}')
    out = tempfile.mkdtemp(prefix='logo-samples-')
    subprocess.run(['pdftoppm', '-r', str(DPI), '-mono', '-png', pdf, os.path.join(out, 'p')], check=True)
    pages = sorted(f for f in os.listdir(out) if f.startswith('p'))
    margin_px, tolerance = 4 * DPI / 25.4, 0.6 * DPI / 25.4
    tries = 0
    for n, name in enumerate(pages, 1):
        img = Image.open(os.path.join(out, name)).convert('L')
        ink = np.array(img) < 128
        H, W = ink.shape
        half = W // 2
        for side in range(2):
            want = EXPECT[side]
            crop = img.crop((side * half, 0, (side + 1) * half, H))
            region = ink[:, side * half:(side + 1) * half].copy()
            if side == 0:
                region[:, -int(1.2 * DPI / 25.4):] = False
            else:
                region[:, :int(1.2 * DPI / 25.4)] = False
            ys, xs = np.nonzero(region)
            tight = min(xs.min(), half - 1 - xs.max(), ys.min(), H - 1 - ys.max())
            if tight < margin_px - tolerance:
                problems.append(f'page {n} {want}: ink {tight * 25.4 / DPI:.2f} mm from the edge')
            z, cvt = reads(crop)
            if z != [want] or cvt != want:
                problems.append(f'page {n} {want}: printed copy read zxing {z}, opencv {cvt!r}')
            for scale in (0.6, 0.8):
                for blur in (0.6, 1.2):
                    for angle in (-12, 0, 9):
                        for tilt in (0, 0.06):
                            tries += 1
                            photo = phone(crop, scale, blur, angle, tilt)
                            pz, pc = reads(photo)
                            if want not in pz and pc != want:
                                problems.append(f'page {n} {want}: a phone photo (scale {scale}, blur {blur}, {angle} degrees, tilt {tilt}) read nothing')
    print(f'{len(pages)} pages; {tries} phone photos tried; colours used: {sorted(colours)}')
    if problems:
        print(f'{len(problems)} problem(s):')
        for p in problems:
            print(' -', p)
        sys.exit(1)
    print('all good')


if __name__ == '__main__':
    main(sys.argv[1])
