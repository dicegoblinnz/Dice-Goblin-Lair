#!/usr/bin/env python3
"""Two logo options for the library stickers, side by side for Mo (11 Oct): page 1 has Gobgob in the QR code, page 2
the DICE GOBLIN wordmark across the top. The same two games on each page, so they compare directly.

Usage: python3 build_logo_samples.py samples.pdf [fonts_dir] [options, like qr,band or qr-stacked]
"""
import json
import sys

from reportlab.pdfgen import canvas

import library_stickers as ls

GAMES = [g for g in json.load(open('test-games.json', encoding='utf-8')) if g['code'] in ('DGL56-004', 'DGL7+-001')]


def main(out, fonts_dir='/home/claude/dice-goblin-website/assets', options='qr,band'):
    ls.load_fonts(fonts_dir)
    ls.load_logos(fonts_dir)
    c = canvas.Canvas(out, pagesize=(ls.PAGE_W, ls.PAGE_H), pageCompression=1)
    c.setTitle('Dice Goblin library stickers: two logo options')
    c.setAuthor('Dice Goblin')
    layout = []
    for page, logo in enumerate(options.split(','), 1):
        for j, game in enumerate(GAMES):
            info = ls.draw_sticker(c, j * ls.LABEL_W, game, logo)
            layout.append({'page': page, 'logo': logo, 'code': game['code'], 'qr_mm': round(info['qr_mm'], 1), 'title_size': info['title_size']})
        ls.cut_line(c)
        c.showPage()
    c.save()
    print(json.dumps(layout, indent=1))


if __name__ == '__main__':
    main(*sys.argv[1:4])
