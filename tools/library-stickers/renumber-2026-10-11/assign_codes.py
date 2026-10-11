"""New library codes (Mo, 11 Oct 2026): section, then box size, then the game's place in that run in A–Z order.

DGL34-022 Catan, a medium box, becomes DGL34-M0nn. Within each section and size the games are numbered 001 up in
alphabetical order (a leading "The" ignored, as today), so the numbers run along the shelf. RPG books keep their codes
(DGLRPG-001 and so on): they're one size. Each copy's QR code holds its new code, except the one copy whose barcode
is its ISBN, which keeps it."""
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import library_stickers as ls  # noqa: E402

GAMES = os.path.join(HERE, '..', 'games-2026-10-10.json')
SIZES = os.path.join(HERE, 'final-sizes.json')


def sort_key(title):
    t = ls.sticker_title(title)
    t = unicodedata.normalize('NFKD', t).encode('ascii', 'ignore').decode()
    t = re.sub(r'^the\s+', '', t.strip(), flags=re.I)
    return re.sub(r'[^a-z0-9 ]+', '', t.lower())


def main(out):
    ls.load_fonts(sys.argv[2] if len(sys.argv) > 2 else '/home/claude/dice-goblin-website/assets')  # for sticker_title
    games = json.load(open(GAMES, encoding='utf-8'))
    sizes = json.load(open(SIZES, encoding='utf-8'))
    groups = {}
    for g in games:
        section = g['code'].split('-')[0]
        size = '' if section == 'DGLRPG' else sizes[g['code']]['size']
        groups.setdefault((section, size), []).append(g)
    rows = []
    for (section, size), members in groups.items():
        if section == 'DGLRPG':
            members.sort(key=lambda g: g['code'])
            for g in members:
                rows.append({**row_of(g, None), 'new_code': g['code'], 'size': ''})
            continue
        members.sort(key=lambda g: (sort_key(g['title']), g['code']))
        for n, g in enumerate(members, 1):
            rows.append({**row_of(g, sizes[g['code']]), 'new_code': f'{section}-{size}{n:03d}', 'size': size})
    for r in rows:
        r['new_qr'] = r['new_code'] if r['old_qr'] == r['old_code'] else r['old_qr']
    rows.sort(key=lambda r: ls.shelf_order(r['new_code']))
    codes = [r['new_code'] for r in rows]
    assert len(codes) == len(set(codes)) == len(games), 'codes must be unique, one per game'
    json.dump(rows, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    from collections import Counter
    print(len(rows), 'games;', Counter((r['old_code'].split('-')[0], r['size']) for r in rows))
    print('kept a non-code barcode:', [(r['old_code'], r['new_code'], r['old_qr']) for r in rows if r['new_qr'] != r['new_code']])


def row_of(g, s):
    return {'old_code': g['code'], 'title': g['title'], 'players': g.get('players'), 'time': g.get('time'),
            'ages': g.get('ages'), 'old_qr': g['qr'], 'productId': g.get('productId'), 'status': g.get('status'),
            'source': s['source'] if s else 'RPG book', 'why': (s or {}).get('why'),
            'dims_cm': (s or {}).get('dims_cm') if s and s['source'] != 'corrected' else None,
            'kg': (s or {}).get('kg') if s and s['source'] != 'corrected' else None, 'bgg_id': (s or {}).get('bgg_id')}


if __name__ == '__main__':
    main(sys.argv[1])
