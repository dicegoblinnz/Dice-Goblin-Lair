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
  band  the DICE GOBLIN wordmark across the top, above the name; the QR code is smaller to make room.
The logos are the theme's own PNGs, turned into black and white and traced into solid shapes, so they print crisp.

Usage: python3 library_stickers.py games.json stickers.pdf [fonts_dir] [layout_report.json] [--logo=qr|band]
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
QR_LOGO_VERSION, QR_LOGO_HOLE = 5, 11
BAND_W, BAND_GAP = 58 * mm, 2.6 * mm
LOGOS = {}  # 'gobgob' / 'wordmark' -> the theme's PNG, set by load_logos


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


def title_lines_allowed(size):
    return 1 + int((TITLE_HEIGHT - size * TITLE_TOP) / (size * TITLE_LEAD) + 1e-6)


def title_at(text, size, max_w):
    """(awkward breaks, lines) for the name at size, or None if it doesn't fit the title's room."""
    lines = wrap(text, 'Display', size, max_w)
    if len(lines) > title_lines_allowed(size) or any(width(l, 'Display', size) > max_w for l in lines):
        return None
    return balance(text, 'Display', size, len(lines), max_w)


def fit_title(text, max_w):
    """The biggest size the name fits at, in as many lines as the title's room holds at that size. Up to
    TITLE_GIVE points smaller is worth it when that saves an awkward break or a line ('Dungeons & Dragons:' /
    'Adventure Begins', not 'Dungeons &' / 'Dragons:' / 'Adventure Begins')."""
    size = TITLE_SIZE
    while size >= TITLE_MIN:
        if title_at(text, size, max_w):
            options = []
            s = size
            while s >= max(TITLE_MIN, size - TITLE_GIVE):
                found = title_at(text, s, max_w)
                if found:
                    options.append(((found[0], len(found[1]), -s), found[1], s))
                s -= 0.5
            _, lines, chosen = min(options, key=lambda o: o[0])
            return [line.replace(JOIN, ' ') for line in lines], chosen
        size -= 0.5
    print(f'  name cut short: {text}', file=sys.stderr)
    lines = [l.replace(JOIN, ' ') for l in wrap(text, 'Display', TITLE_MIN, max_w)[:title_lines_allowed(TITLE_MIN)]]
    last = lines[-1]
    while last and width(last + '…', 'Display', TITLE_MIN) > max_w:
        last = last[:-1].rstrip()
    lines[-1] = last + '…'
    return lines, TITLE_MIN


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


TRACED = {}  # logo name -> (curves, width, height) in the traced bitmap's pixels


def traced_logo(name):
    """The logo as solid black shapes: the theme's PNG enlarged twice over, laid on white, every pixel darker than
    LOGO_THRESHOLD black (the outlines, Gobgob's hood; the bright green and the bag go white), then traced into curves,
    so it prints crisp at any size and the PDF holds it once."""
    if name not in TRACED:
        im = Image.open(LOGOS[name]).convert('RGBA')
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
    if form not in DRAWN_FORMS:
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
        DRAWN_FORMS.add(form)
    k = width / w_px
    c.saveState()
    c.translate(x, y)
    c.scale(k, k)
    c.doForm(form)
    c.restoreState()
    return h_px * k


DRAWN_FORMS = set()


def draw_qr(c, value, x, y, size, logo=False):
    """A QR code as solid black squares, its 4-module quiet zone inside size. Error correction H, so a scuffed
    sticker still scans. Each row's runs are one rectangle, so no hairlines show between modules. logo: Gobgob in the
    middle, on QR_LOGO_HOLE x QR_LOGO_HOLE modules left white, half a module clear all round."""
    if logo:
        qr = segno.make(value, error='h', version=QR_LOGO_VERSION, boost_error=False)
    else:
        qr = segno.make(value, error='h', micro=False, boost_error=False)
    rows = [list(r) for r in qr.matrix]
    n = len(rows)
    module = size / (n + 8)
    if logo:
        h0 = (n - QR_LOGO_HOLE) // 2
        for r in range(h0, h0 + QR_LOGO_HOLE):
            for col in range(h0, h0 + QR_LOGO_HOLE):
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
        # Gobgob as big as fits inside the white square, half a module clear all round
        room = (QR_LOGO_HOLE - 1) * module
        w = min(room, room * room / logo_height('gobgob', room))
        h = logo_height('gobgob', w)
        mid_x = x + (4 + n / 2) * module
        mid_y = y + size - (4 + n / 2) * module
        draw_logo(c, 'gobgob', mid_x - w / 2, mid_y - h / 2, w)
    return qr


def draw_sticker(c, x0, game, logo=None):
    """The game's name at the top, the shelf code and its details along the bottom, and the QR code as big as
    possible in the middle (Mo, 10 Oct: no heading or footer, everything bigger). logo: None, 'qr' (Gobgob in the
    QR code) or 'band' (the wordmark above the name)."""
    left, right = x0 + MARGIN, x0 + LABEL_W - MARGIN
    inner = right - left
    cx = x0 + LABEL_W / 2
    top, bottom = PAGE_H - MARGIN, MARGIN
    qr_box = QR_BOX
    if logo == 'band':
        band_h = logo_height('wordmark', BAND_W)
        draw_logo(c, 'wordmark', cx - BAND_W / 2, top - band_h, BAND_W)
        top -= band_h + BAND_GAP
        qr_box -= band_h + BAND_GAP
    c.setFillColorRGB(*BLACK)

    # The game's name, the top of its first line's ink at the top margin
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
    draw_qr(c, game['qr'], cx - qr_size / 2, qr_y, qr_size, logo=logo == 'qr')
    return {'title_lines': lines, 'title_size': size, 'stats_lines': stats_lines, 'stats_size': stats_size,
            'shelf_size': shelf_size, 'code_size': code_size, 'qr_mm': qr_size / mm}


def cut_line(c):
    c.saveState()
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.25 * mm)
    c.setDash(1.6 * mm, 1.6 * mm)
    c.line(LABEL_W, 0, LABEL_W, PAGE_H)
    c.restoreState()


def build(games, out, fonts_dir, report=None, logo=None):
    load_fonts(fonts_dir)
    load_logos(fonts_dir)
    games = sorted(games, key=lambda g: g['code'])
    c = canvas.Canvas(out, pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle('Dice Goblin library stickers')
    c.setAuthor('Dice Goblin')
    c.setSubject('Library game stickers, 75 x 100 mm, two per 150 x 100 mm page')
    layout = []
    for i in range(0, len(games), 2):
        pair = games[i:i + 2]
        for j, game in enumerate(pair):
            info = draw_sticker(c, j * LABEL_W, game, logo)
            layout.append({'code': game['code'], 'page': i // 2 + 1, **info})
        cut_line(c)
        c.showPage()
    c.save()
    if report:
        json.dump(layout, open(report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return games


if __name__ == '__main__':
    flags = [a for a in sys.argv[1:] if a.startswith('--logo=')]
    args = [a for a in sys.argv[1:] if not a.startswith('--logo=')]
    logo = flags[-1].split('=', 1)[1] if flags else None
    if logo not in (None, 'qr', 'band'):
        sys.exit('--logo is qr or band')
    games = json.load(open(args[0], encoding='utf-8'))
    fonts = args[2] if len(args) > 2 else '/home/claude/dice-goblin-website/assets'
    report = args[3] if len(args) > 3 else None
    done = build(games, args[1], fonts, report, logo)
    print(f'{len(done)} stickers on {(len(done) + 1) // 2} pages: {args[1]}')
