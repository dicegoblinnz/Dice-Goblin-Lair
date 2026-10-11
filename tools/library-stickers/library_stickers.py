#!/usr/bin/env python3
"""Library game stickers for Dice Goblin's thermal sticker printer.

Each page is landscape 150 x 100 mm and holds two 75 x 100 mm stickers with a dashed cut line
between them. Pure black on white (no greys), so a thermal printer prints it cleanly.

Each sticker: the game's name, a QR code holding the copy's barcode (what Shopify POS and My Lair find the copy
by, the same value the website's QR code holds), the shelf code in big type, the shelf, and players / play time /
ages. No heading or footer, so all of it can be big (Mo, 10 Oct).

The Dice Goblin logo (Mo, 11 Oct: "have a dice goblin logo on it even in black and white"), two ways to choose from:
  qr    Gobgob in the middle of the QR code. The code is a bigger QR version (5) so the logo covers under a tenth
        of it, and it still reads with an 11 mm scuff anywhere on it, as today's plain code does.
  qr-stacked  the stacked DICE / Gobgob / GOBLIN logo in the middle of the QR code instead (Mo's pick to try,
        11 Oct), in a taller white space (11 x 13 modules) that reads as well in the tests.
  band  the DICE GOBLIN wordmark across the top, above the name; the QR code is smaller to make room.
The logos are the theme's own PNGs, turned into black and white and traced into solid shapes, so they print crisp.

Spine labels (Mo, 11 Oct: "print the core and the spine and have 2 games at once"): with --spine each game's spine
label prints under its own sticker, in a 30 mm square either side of the middle cut line along the bottom of the page.
The stickers above are 70 mm tall, with the name on two lines and a smaller QR code.

Usage: python3 library_stickers.py games.json stickers.pdf [fonts_dir] [layout_report.json] [--logo=qr|qr-stacked|band] [--spine]
games.json is a list of {title, code, qr, players, time, ages}; code is the shelf code (custom.library_code),
qr the variant barcode (else SKU, else the shelf code).
"""
import json
import os
import re
import sys
import tempfile
from itertools import combinations

import numpy as np
import potrace
import segno
from fontTools.merge import Merger
from fontTools.ttLib import TTFont as FTFont
from PIL import Image
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.pdfgen.canvas import FILL_EVEN_ODD

PAGE_W, PAGE_H = 150 * mm, 100 * mm
LABEL_W = 75 * mm
MARGIN = 4 * mm  # clear space on every side of a sticker, the cut line included
BLACK = (0, 0, 0)

SHELVES = {
    'DGL12': '1–2 players',
    'DGL34': '3–4 players',
    'DGL56': '5–6 players',
    'DGL7+': '7+ players',
    'DGLF': 'Kids and family',
    'DGLRPG': 'RPG books',
}

# Cap heights (font units per 1000) from the fonts' OS/2 tables, for centring text optically
CAP = {'Display': 0.688, 'Body': 0.701, 'BodyMedium': 0.697}
# The tallest ink in the display font's plain letters, digits and brackets (f, l, parentheses), above the capitals
TITLE_TOP = 0.737

# Type sizes (points): the biggest each line starts at, and the smallest it may shrink to
TITLE_SIZE, TITLE_MIN, TITLE_LINES, TITLE_LEAD = 17, 10, 3, 1.12
CODE_SIZE, CODE_MIN = 29, 14
SHELF_SIZE, SHELF_MIN = 12, 8
STATS_SIZE, STATS_MIN, STATS_LEAD = 11.5, 10, 1.2
STATS_GAP, CODE_GAP, QR_GAP = 5.6 * mm, 3.4 * mm, 1 * mm
DESCENDER_ROOM = 1.3 * mm

# The room three lines of the name take at full size. A long name gets smaller lines (four once they're small)
# in the same room, so every QR code can be the same size.
TITLE_HEIGHT = TITLE_SIZE * TITLE_TOP + (TITLE_LINES - 1) * TITLE_SIZE * TITLE_LEAD

TITLE_GIVE = 1  # points of name size worth giving up for a better line break

# Subscript digits (the ₂ in CO₂) aren't in the fonts, so they're drawn as small, lowered ordinary digits
SUBSCRIPTS = {chr(0x2080 + i): str(i) for i in range(10)}
SUB_SCALE, SUB_DROP = 0.62, 0.14

# Names that read badly split over two lines, kept whole when a game's name wraps
KEEP_TOGETHER = ['Harry Potter', 'Star Wars', 'Star Trek', 'New Zealand', 'New York', 'Hong Kong', "Da Vinci's",
                 'Dungeons & Dragons', 'Sherlock Holmes', 'Here & Now', '12 Player', 'Rick and Morty', 'Kingdom Hearts',
                 'Strategy Game']
KEEP_PATTERNS = [r'\d+(?:st|nd|rd|th) [Ee]dition', r'\([^()\s]+(?: [^()\s]+){0,2}\)']  # '5th Edition', '(Core Rulebook)'
JOIN = '\ue000'  # stands in for a space inside a kept name while wrapping


def bottom_block_top(stats_lines, stats_size, shelf_size, code_size):
    """Where the shelf code's capitals end, building up from the bottom margin: details, shelf, shelf code."""
    y = MARGIN + DESCENDER_ROOM
    if stats_lines:
        y += (stats_lines - 1) * stats_size * STATS_LEAD + STATS_GAP
    return y + shelf_size * CAP['Body'] + CODE_GAP + code_size * CAP['Display']


# Every QR code is the same size: as big as a full sticker (three lines of name and every detail on one line)
# has room for. The few stickers whose details need two lines get a slightly smaller one.
QR_BOX = (PAGE_H - MARGIN - TITLE_HEIGHT - QR_GAP) - (bottom_block_top(1, STATS_SIZE, SHELF_SIZE, CODE_SIZE) + QR_GAP)

# The logo (11 Oct). In the QR code: version 5 (37 modules) at error correction H, with the middle 11 x 11 modules
# left white for Gobgob (no alignment pattern sits there in version 5). In tests it read with a scuff of up to 11 mm
# anywhere on it, and from blurred, turned and tilted 'phone photos' nearly as often as today's plain version 1 code
# (a bigger hole or version 6 read noticeably less often). Across the top: the wordmark, BAND_W wide.
LOGO_THRESHOLD = 0.32  # how dark a colour has to be to print black (Gobgob's hood and outlines, not the bright green)
QR_LOGO_VERSION = 5
# The white space in the middle for each logo, in modules (across, down): Gobgob is square, the stacked DICE GOBLIN
# logo is taller than it's wide (11 x 13 read as well as 11 x 11 in the tests, up to a 9 mm scuff; 13 x 15 didn't)
QR_LOGO_HOLES = {'gobgob': (11, 11), 'stacked': (11, 13)}
BAND_W, BAND_GAP = 58 * mm, 2.6 * mm
LOGOS = {}  # 'gobgob' / 'wordmark' -> the theme's PNG, set by load_logos

# Spine labels (--spine, 11 Oct). The bottom SPINE_STRIP of each page holds the two games' spine labels, each in a
# SPINE_PIECE square either side of the middle cut line, so it sits under its own sticker. The label inside is
# SPINE_SIZE square with its outline printed, so it fits a 3 cm spine and looks finished however it's cut out. The
# stickers above are 70 mm tall: the name gets two lines' room and the shelf line goes (the spine label says it).
SPINE_STRIP = 30 * mm
SPINE_PIECE = 30 * mm
SPINE_SIZE = 25 * mm
SPINE_BAND = 8.2 * mm  # the black band across the label's top
SPINE_RADIUS = 1.8 * mm
SPINE_LINE = 0.8  # points: the outline, about two printer dots
SPINE_TITLE_SIZE, SPINE_TITLE_MIN = 15, 9
SPINE_TITLE_HEIGHT = SPINE_TITLE_SIZE * TITLE_TOP + SPINE_TITLE_SIZE * TITLE_LEAD  # two lines at full size
SPINE_CODE_SIZE = 22
SPINE_SECTIONS = {  # the black band: the section big, then a small word
    'DGL12': ('1–2', 'PLAYERS'),
    'DGL34': ('3–4', 'PLAYERS'),
    'DGL56': ('5–6', 'PLAYERS'),
    'DGL7+': ('7+', 'PLAYERS'),
    'DGLF': ('KIDS', '& FAMILY'),
    'DGLRPG': ('RPG', 'BOOKS'),
}


def spine_block_top(stats_lines, stats_size, code_size):
    """With spine labels: where the shelf code's capitals end, building up from the sticker's bottom margin (just
    above the spine labels): details, then the shelf code."""
    y = SPINE_STRIP + MARGIN + DESCENDER_ROOM
    if stats_lines:
        y += (stats_lines - 1) * stats_size * STATS_LEAD + STATS_GAP
    return y + code_size * CAP['Display']


# The QR code with spine labels: as big as a full 70 mm sticker has room for (two lines of name, the details on one line)
SPINE_QR_BOX = (PAGE_H - MARGIN - SPINE_TITLE_HEIGHT - QR_GAP) - (spine_block_top(1, STATS_SIZE, SPINE_CODE_SIZE) + QR_GAP)


def load_fonts(fonts_dir):
    """The theme's own fonts (Archivo Black, Poppins), latin and latin-ext subsets merged into one TTF each."""
    out = tempfile.mkdtemp(prefix='dg-fonts-')
    for name, base in (('Display', 'archivo-black-400'), ('Body', 'poppins-600'), ('BodyMedium', 'poppins-500')):
        parts = []
        for suffix in ('', '-latin-ext'):
            src = os.path.join(fonts_dir, f'{base}{suffix}.woff2')
            if os.path.exists(src):
                font = FTFont(src)
                font.flavor = None
                ttf = os.path.join(out, f'{base}{suffix}.ttf')
                font.save(ttf)
                parts.append(ttf)
        path = parts[0]
        if len(parts) > 1:
            merged = Merger().merge(parts)
            path = os.path.join(out, f'{base}-merged.ttf')
            merged.save(path)
        pdfmetrics.registerFont(TTFont(name, path))
        ttf = FTFont(path)
        cmap, glyf, upm = ttf.getBestCmap(), ttf['glyf'], ttf['head'].unitsPerEm
        GLYPH_TOPS[name] = {code: getattr(glyf[g], 'yMax', 0) / upm for code, g in cmap.items()}


GLYPH_TOPS = {}  # font name -> {code point: top of the glyph's ink, in ems}


def ink_top(text, font):
    """How far above the baseline the line's ink reaches, in ems: an accent (the macron in SHŌBU) or a tall
    lowercase letter goes above the capitals."""
    tops = GLYPH_TOPS[font]
    return max([tops.get(ord(ch), 0) for ch in text.replace(JOIN, ' ')] + [CAP[font]])


def runs(text):
    """text as (string, is_subscript) runs."""
    out = []
    for ch in text.replace(JOIN, ' '):
        sub = ch in SUBSCRIPTS
        ch = SUBSCRIPTS.get(ch, ch)
        if out and out[-1][1] == sub:
            out[-1] = (out[-1][0] + ch, sub)
        else:
            out.append((ch, sub))
    return out


def width(text, font, size):
    return sum(pdfmetrics.stringWidth(s, font, size * SUB_SCALE if sub else size) for s, sub in runs(text))


def draw_centred(c, cx, y, text, font, size):
    x = cx - width(text, font, size) / 2
    for s, sub in runs(text):
        run_size = size * SUB_SCALE if sub else size
        c.setFont(font, run_size)
        c.drawString(x, y - size * SUB_DROP if sub else y, s)
        x += pdfmetrics.stringWidth(s, font, run_size)


def drawable(text, font):
    glyphs = pdfmetrics.getFont(font).face.charToGlyph
    return all(ch.isspace() or ch in SUBSCRIPTS or ord(ch) in glyphs for ch in text)


def sticker_title(title):
    """The name as the display font can draw it. A name partly in a script the font lacks, like
    '스플렌더: Pokémon (Splendor: Pokémon)', uses its bracketed name; otherwise only what the font can't draw is left out."""
    if drawable(title, 'Display'):
        return title
    bracket = re.search(r'\(([^()]+)\)\s*$', title)
    if bracket and drawable(bracket.group(1), 'Display'):
        return bracket.group(1).strip()
    kept = ''.join(ch for ch in title if drawable(ch, 'Display'))
    return re.sub(r'\s+', ' ', kept).strip(' :–-')


def words(text):
    """Words for wrapping. Names and phrases that read badly split ('Star / Wars', 'New / Zealand', '5th / Edition',
    a short bracket) stay whole, and a lone dash, colon or ampersand stays at the end of the line before it."""
    for phrase in KEEP_TOGETHER:
        text = text.replace(phrase, phrase.replace(' ', JOIN))
    for pattern in KEEP_PATTERNS:
        text = re.sub(pattern, lambda m: m.group(0).replace(' ', JOIN), text)
    out = []
    for word in text.split():
        if out and word in ('–', '—', '-', ':', '&', '·'):
            out[-1] += ' ' + word
        else:
            out.append(word)
    return out


def wrap(text, font, size, max_w):
    """Greedy word wrap; a word longer than the line is left whole (the caller shrinks the size)."""
    lines, line = [], ''
    for word in words(text):
        trial = f'{line} {word}'.strip()
        if line and width(trial, font, size) > max_w:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    return lines


def natural_break(line, next_line):
    """A break after a colon, dash or exclamation, or before a bracket, follows the name's own phrasing."""
    return line.endswith((':', '–', '—', '-', ',', '!', '?')) or next_line.startswith('(')


def balance(text, font, size, n, max_w):
    """(awkward breaks, lines): text split into n lines that each fit max_w, breaking at the name's own colons,
    dashes and brackets where it can, then as evenly as it can, so centred lines don't end on one stray word
    ('Caverna:' / 'The Cave Farmers', not 'Caverna: The Cave' / 'Farmers'). None if n lines can't fit."""
    ws = words(text)
    best = None
    for cuts in combinations(range(1, len(ws)), n - 1):
        bounds = (0,) + cuts + (len(ws),)
        lines = [' '.join(ws[a:b]) for a, b in zip(bounds, bounds[1:])]
        widths = [width(line, font, size) for line in lines]
        if max(widths) > max_w:
            continue
        awkward = sum(0 if natural_break(a, b) else 1 for a, b in zip(lines, lines[1:]))
        cost = (awkward, max(widths) - 0.5 * min(widths))
        if best is None or cost < best[0]:
            best = (cost, lines)
    return (best[0][0], best[1]) if best else None


def title_lines_allowed(size, room=TITLE_HEIGHT):
    return 1 + int((room - size * TITLE_TOP) / (size * TITLE_LEAD) + 1e-6)


def title_at(text, size, max_w, room=TITLE_HEIGHT):
    """(awkward breaks, lines) for the name at size, or None if it doesn't fit the title's room."""
    lines = wrap(text, 'Display', size, max_w)
    if len(lines) > title_lines_allowed(size, room) or any(width(l, 'Display', size) > max_w for l in lines):
        return None
    return balance(text, 'Display', size, len(lines), max_w)


def fit_title(text, max_w, start=TITLE_SIZE, smallest=TITLE_MIN, room=TITLE_HEIGHT):
    """The biggest size the name fits at, in as many lines as the title's room holds at that size. Up to
    TITLE_GIVE points smaller is worth it when that saves an awkward break or a line ('Dungeons & Dragons:' /
    'Adventure Begins', not 'Dungeons &' / 'Dragons:' / 'Adventure Begins')."""
    size = start
    while size >= smallest:
        if title_at(text, size, max_w, room):
            options = []
            s = size
            while s >= max(smallest, size - TITLE_GIVE):
                found = title_at(text, s, max_w, room)
                if found:
                    options.append(((found[0], len(found[1]), -s), found[1], s))
                s -= 0.5
            _, lines, chosen = min(options, key=lambda o: o[0])
            return [line.replace(JOIN, ' ') for line in lines], chosen
        size -= 0.5
    print(f'  name cut short: {text}', file=sys.stderr)
    lines = [l.replace(JOIN, ' ') for l in wrap(text, 'Display', smallest, max_w)[:title_lines_allowed(smallest, room)]]
    last = lines[-1]
    while last and width(last + '…', 'Display', smallest) > max_w:
        last = last[:-1].rstrip()
    lines[-1] = last + '…'
    return lines, smallest


def fit_size(text, font, max_w, start, smallest):
    size = start
    while size > smallest and width(text, font, size) > max_w:
        size -= 0.25
    return size


def fit_stats(parts, max_w):
    """Players, play time and ages on one line if it fits at a readable size, else over two lines."""
    one = ' · '.join(parts)
    size = fit_size(one, 'BodyMedium', max_w, STATS_SIZE, STATS_MIN)
    if width(one, 'BodyMedium', size) <= max_w:
        return [one], size
    # split where the two lines come out most even
    best = None
    for k in range(1, len(parts)):
        lines = [' · '.join(parts[:k]), ' · '.join(parts[k:])]
        widest = max(width(l, 'BodyMedium', STATS_SIZE) for l in lines)
        if not best or widest < best[0]:
            best = (widest, lines)
    lines = best[1]
    size = STATS_SIZE
    while size > STATS_MIN and max(width(l, 'BodyMedium', size) for l in lines) > max_w:
        size -= 0.25
    return lines, size


def ages_label(ages):
    """Like the website's stats: '10 years or older' is 10+, '8-12 years' is 8–12, a word like Teens stays."""
    if not ages:
        return ''
    text = str(ages).strip()
    if 'or older' in text:
        return 'Ages ' + text.replace(' years or older', '').replace(' year or older', '').strip() + '+'
    if text[:1].isdigit():
        return 'Ages ' + text.replace(' years', '').replace('-', '–').strip()
    return text


def players_label(players):
    if not players:
        return ''
    text = str(players).strip()
    return f'{text} player' if text == '1' else f'{text} players'


def load_logos(assets_dir):
    LOGOS['gobgob'] = os.path.join(assets_dir, 'gobgob-480.png')
    LOGOS['wordmark'] = os.path.join(assets_dir, 'dg-wordmark-960.png')
    # the stacked DICE / Gobgob / GOBLIN logo: Mo's full-size file (11 Oct) when it's here, else the theme's
    own = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dg-logo-stacked.png')
    LOGOS['stacked'] = own if os.path.exists(own) else os.path.join(assets_dir, 'dg-logo-stacked-640.png')


TRACED = {}  # logo name -> (curves, width, height) in the traced bitmap's pixels


def traced_logo(name):
    """The logo as solid black shapes: the theme's PNG enlarged twice over, laid on white, every pixel darker than
    LOGO_THRESHOLD black (the outlines, Gobgob's hood; the bright green and the bag go white), then traced into curves,
    so it prints crisp at any size and the PDF holds it once."""
    if name not in TRACED:
        im = Image.open(LOGOS[name]).convert('RGBA')
        im = im.crop(im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox() or (0, 0, im.width, im.height))
        flat = Image.alpha_composite(Image.new('RGBA', im.size, (255, 255, 255, 255)), im).convert('RGB')
        big = flat.resize((im.width * 2, im.height * 2), Image.LANCZOS)
        rgb = np.asarray(big, dtype=float) / 255
        lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
        # (potracer traces the False pixels, so the light ones are passed as True)
        curves = potrace.Bitmap(lum >= LOGO_THRESHOLD).trace(
            turdsize=12, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY, alphamax=1.0, opticurve=True, opttolerance=0.2)
        TRACED[name] = (list(curves), big.width, big.height)
    return TRACED[name]


def logo_height(name, width):
    _, w_px, h_px = traced_logo(name)
    return width * h_px / w_px


def draw_logo(c, name, x, y, width):
    """The logo, width wide, its bottom left corner at (x, y), as one Form XObject drawn once per PDF."""
    curves, w_px, h_px = traced_logo(name)
    form = f'logo-{name}'
    drawn = c.__dict__.setdefault('dice_goblin_forms', set())  # forms are per PDF, so building twice works
    if form not in drawn:
        # the form is the logo at its bitmap's size in points, y up
        c.beginForm(form, 0, 0, w_px, h_px)
        c.setFillColorRGB(*BLACK)
        path = c.beginPath()
        for curve in curves:
            path.moveTo(curve.start_point.x, h_px - curve.start_point.y)
            for seg in curve.segments:
                if seg.is_corner:
                    path.lineTo(seg.c.x, h_px - seg.c.y)
                    path.lineTo(seg.end_point.x, h_px - seg.end_point.y)
                else:
                    path.curveTo(seg.c1.x, h_px - seg.c1.y, seg.c2.x, h_px - seg.c2.y, seg.end_point.x, h_px - seg.end_point.y)
            path.close()
        c.drawPath(path, stroke=0, fill=1, fillMode=FILL_EVEN_ODD)
        c.endForm()
        drawn.add(form)
    k = width / w_px
    c.saveState()
    c.translate(x, y)
    c.scale(k, k)
    c.doForm(form)
    c.restoreState()
    return h_px * k


def draw_qr(c, value, x, y, size, logo=None):
    """A QR code as solid black squares, its 4-module quiet zone inside size. Error correction H, so a scuffed
    sticker still scans. Each row's runs are one rectangle, so no hairlines show between modules. logo ('gobgob' or
    'stacked'): that logo in the middle, on its QR_LOGO_HOLES modules left white, half a module clear all round."""
    if logo:
        qr = segno.make(value, error='h', version=QR_LOGO_VERSION, boost_error=False)
    else:
        qr = segno.make(value, error='h', micro=False, boost_error=False)
    rows = [list(r) for r in qr.matrix]
    n = len(rows)
    module = size / (n + 8)
    if logo:
        cols_w, rows_h = QR_LOGO_HOLES[logo]
        r0, c0 = (n - rows_h) // 2, (n - cols_w) // 2
        for r in range(r0, r0 + rows_h):
            for col in range(c0, c0 + cols_w):
                rows[r][col] = 0
    c.setFillColorRGB(*BLACK)
    for r, row in enumerate(rows):
        col = 0
        while col < n:
            if row[col]:
                start = col
                while col < n and row[col]:
                    col += 1
                c.rect(x + (4 + start) * module, y + size - (4 + r + 1) * module, (col - start) * module, module, stroke=0, fill=1)
            else:
                col += 1
    if logo:
        # the logo as big as fits inside the white space, half a module clear all round
        room_w, room_h = (cols_w - 1) * module, (rows_h - 1) * module
        w = room_w
        if logo_height(logo, w) > room_h:
            w = room_w * room_h / logo_height(logo, room_w)
        h = logo_height(logo, w)
        mid_x = x + (4 + n / 2) * module
        mid_y = y + size - (4 + n / 2) * module
        draw_logo(c, logo, mid_x - w / 2, mid_y - h / 2, w)
    return qr


def draw_sticker(c, x0, game, logo=None, spine=False):
    """The game's name at the top, the shelf code and its details along the bottom, and the QR code as big as
    possible in the middle (Mo, 10 Oct: no heading or footer, everything bigger). logo: None, 'qr' (Gobgob in the
    QR code), 'qr-stacked' (the stacked DICE GOBLIN logo in the QR code) or 'band' (the wordmark above the name).
    spine: the sticker stops above the spine labels' strip, with two lines' room for the name and no shelf line."""
    left, right = x0 + MARGIN, x0 + LABEL_W - MARGIN
    inner = right - left
    cx = x0 + LABEL_W / 2
    top, bottom = PAGE_H - MARGIN, (SPINE_STRIP if spine else 0) + MARGIN
    qr_box = SPINE_QR_BOX if spine else QR_BOX
    if logo == 'band':
        band_h = logo_height('wordmark', BAND_W)
        draw_logo(c, 'wordmark', cx - BAND_W / 2, top - band_h, BAND_W)
        top -= band_h + BAND_GAP
        qr_box -= band_h + BAND_GAP
    c.setFillColorRGB(*BLACK)

    # The game's name, the top of its first line's ink at the top margin
    if spine:
        lines, size = fit_title(sticker_title(game['title']), inner, SPINE_TITLE_SIZE, SPINE_TITLE_MIN, SPINE_TITLE_HEIGHT)
    else:
        lines, size = fit_title(sticker_title(game['title']), inner)
    lead = size * TITLE_LEAD
    first = top - size * ink_top(lines[0], 'Display')
    for i, line in enumerate(lines):
        draw_centred(c, cx, first - i * lead, line, 'Display', size)
    title_bottom = first - (len(lines) - 1) * lead

    # From the bottom up: players / time / ages, the shelf, then the shelf code in big type
    shelf = game['code'].split('-')[0]
    shelf_line = f'Shelf {shelf} · {SHELVES[shelf]}' if shelf in SHELVES else f'Shelf {shelf}'
    parts = [p for p in (players_label(game.get('players')), (game.get('time') or '').strip(), ages_label(game.get('ages'))) if p]
    y = bottom + DESCENDER_ROOM
    stats_lines, stats_size = fit_stats(parts, inner) if parts else ([], STATS_SIZE)
    for line in reversed(stats_lines):
        draw_centred(c, cx, y, line, 'BodyMedium', stats_size)
        y += stats_size * STATS_LEAD
    if stats_lines:
        y += STATS_GAP - stats_size * STATS_LEAD
    if spine:
        shelf_size = None
        code_size = fit_size(game['code'], 'Display', inner, SPINE_CODE_SIZE, CODE_MIN)
        draw_centred(c, cx, y, game['code'], 'Display', code_size)
        code_top = spine_block_top(len(stats_lines), stats_size, code_size)
    else:
        shelf_size = fit_size(shelf_line, 'Body', inner, SHELF_SIZE, SHELF_MIN)
        draw_centred(c, cx, y, shelf_line, 'Body', shelf_size)
        y += shelf_size * CAP['Body'] + CODE_GAP
        code_size = fit_size(game['code'], 'Display', inner, CODE_SIZE, CODE_MIN)
        draw_centred(c, cx, y, game['code'], 'Display', code_size)
        code_top = bottom_block_top(len(stats_lines), stats_size, shelf_size, code_size)

    # The QR code, centred in the space between the name and the shelf code
    room = (title_bottom - QR_GAP) - (code_top + QR_GAP)
    qr_size = min(qr_box, room)
    qr_y = code_top + QR_GAP + (room - qr_size) / 2
    draw_qr(c, game['qr'], cx - qr_size / 2, qr_y, qr_size, logo={'qr': 'gobgob', 'qr-stacked': 'stacked'}.get(logo))
    return {'title_lines': lines, 'title_size': size, 'stats_lines': stats_lines, 'stats_size': stats_size,
            'shelf_size': shelf_size, 'code_size': code_size, 'qr_mm': qr_size / mm}


SIZE_ORDER = {'S': 0, 'M': 1, 'L': 2}  # box sizes, top shelf down


def shelf_order(code):
    """A sort key that puts codes in shelf order: by section, then small, medium and large boxes, then number.
    'DGL34-S007' comes before 'DGL34-M001'; today's codes without a size letter sort by number."""
    shelf, _, rest = code.partition('-')
    letter = rest[:1] if rest[:1] in SIZE_ORDER and rest[1:].isdigit() else ''
    number = rest[1:] if letter else rest
    return (shelf, SIZE_ORDER.get(letter, -1), int(number) if number.isdigit() else -1, code)


def spine_parts(code):
    """What a shelf code's spine label says: 'DGL34-M052' is ('3–4', 'PLAYERS', 'M052'): the section in the band,
    then the size letter and number."""
    shelf, _, rest = code.partition('-')
    big, small = SPINE_SECTIONS.get(shelf, (shelf, ''))
    return big, small, rest or code


def spine_piece_x(side):
    """The left edge of a game's spine label square: the first game's sits just left of the middle cut line, the
    second's just right of it, so each is under its own sticker."""
    return LABEL_W - SPINE_PIECE if side == 0 else LABEL_W


def draw_spine(c, x, y, code):
    """The spine label, SPINE_SIZE square, its bottom left corner at (x, y): the section in a black band across the
    top, the size letter and number as big as fits, then the full code small. Black and white only."""
    s, r, band = SPINE_SIZE, SPINE_RADIUS, SPINE_BAND
    big, small, main = spine_parts(code)
    c.saveState()
    outline = c.beginPath()
    outline.roundRect(x, y, s, s, r)
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(SPINE_LINE)
    c.drawPath(outline, stroke=1, fill=0)
    c.saveState()
    clip = c.beginPath()
    clip.roundRect(x, y, s, s, r)
    c.clipPath(clip, stroke=0, fill=0)
    c.setFillColorRGB(*BLACK)
    c.rect(x, y + s - band, s, band, stroke=0, fill=1)
    c.restoreState()
    # the section, in white on the band: '3–4' big, 'PLAYERS' small
    room, gap = s - 3 * mm, 1.1 * mm if small else 0
    big_size = 14
    while width(big, 'Display', big_size) + gap + width(small, 'Body', big_size * 5.4 / 14) > room:
        big_size -= 0.1
    small_size = big_size * 5.4 / 14
    total = width(big, 'Display', big_size) + gap + width(small, 'Body', small_size)
    base = y + s - band / 2 - big_size * CAP['Display'] / 2
    c.setFillColorRGB(1, 1, 1)
    sx = x + (s - total) / 2
    c.setFont('Display', big_size)
    c.drawString(sx, base, big)
    if small:
        c.setFont('Body', small_size)
        c.drawString(sx + width(big, 'Display', big_size) + gap, base, small)
    # the size letter and number, then the full code
    c.setFillColorRGB(*BLACK)
    code_size, code_base = 6.2, y + 2.5 * mm
    main_size = fit_size(main, 'Display', s - 3 * mm, 22, 8)
    middle = (y + s - band + code_base + code_size * CAP['Body']) / 2
    draw_centred(c, x + s / 2, middle - main_size * CAP['Display'] / 2, main, 'Display', main_size)
    code_size = fit_size(code, 'Body', s - 3 * mm, code_size, 4)
    draw_centred(c, x + s / 2, code_base, code, 'Body', code_size)
    c.restoreState()


def cut_line(c, spine=False):
    """The dashed lines to cut along: down the middle, and with spine labels, across above them and round each one."""
    c.saveState()
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.25 * mm)
    c.setDash(1.6 * mm, 1.6 * mm)
    c.line(LABEL_W, 0, LABEL_W, PAGE_H)
    if spine:
        c.line(0, SPINE_STRIP, PAGE_W, SPINE_STRIP)
        c.line(LABEL_W - SPINE_PIECE, 0, LABEL_W - SPINE_PIECE, SPINE_STRIP)
        c.line(LABEL_W + SPINE_PIECE, 0, LABEL_W + SPINE_PIECE, SPINE_STRIP)
    c.restoreState()


def build(games, out, fonts_dir, report=None, logo=None, spine=False):
    load_fonts(fonts_dir)
    load_logos(fonts_dir)
    games = sorted(games, key=lambda g: shelf_order(g['code']))
    c = canvas.Canvas(out, pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle('Dice Goblin library stickers')
    c.setAuthor('Dice Goblin')
    c.setSubject('Library game stickers with their spine labels, two games per 150 x 100 mm page' if spine
                 else 'Library game stickers, 75 x 100 mm, two per 150 x 100 mm page')
    layout = []
    for i in range(0, len(games), 2):
        pair = games[i:i + 2]
        for j, game in enumerate(pair):
            info = draw_sticker(c, j * LABEL_W, game, logo, spine)
            if spine:
                inset = (SPINE_PIECE - SPINE_SIZE) / 2
                draw_spine(c, spine_piece_x(j) + inset, (SPINE_STRIP - SPINE_SIZE) / 2, game['code'])
            layout.append({'code': game['code'], 'page': i // 2 + 1, **info})
        cut_line(c, spine)
        c.showPage()
    c.save()
    if report:
        json.dump(layout, open(report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return games


if __name__ == '__main__':
    flags = [a for a in sys.argv[1:] if a.startswith('--logo=')]
    spine = '--spine' in sys.argv[1:]
    args = [a for a in sys.argv[1:] if not a.startswith('--logo=') and a != '--spine']
    logo = flags[-1].split('=', 1)[1] if flags else None
    if logo not in (None, 'qr', 'qr-stacked', 'band'):
        sys.exit('--logo is qr, qr-stacked or band')
    games = json.load(open(args[0], encoding='utf-8'))
    fonts = args[2] if len(args) > 2 else '/home/claude/dice-goblin-website/assets'
    report = args[3] if len(args) > 3 else None
    done = build(games, args[1], fonts, report, logo, spine)
    print(f'{len(done)} stickers on {(len(done) + 1) // 2} pages: {args[1]}')
