"""Every library board game's box size: BoardGameGeek's printings where it has them (classify.py), a few corrected
from what's known about the box the library will have, and educated guesses for the rest (Mo, 11 Oct 2026: "find
out and at the worst case scenario make an educated guess")."""
import json

import os
HERE = os.path.dirname(os.path.abspath(__file__))
GAMES = os.path.join(HERE, '..', 'games-2026-10-10.json')

# BGG's majority picks the wrong box for these
OVERRIDES = {
    'DGL56-095': ('S', 'the standard Munchkin card-game box; BGG mixes in bigger printings'),
    'DGL56-097': ('M', 'the Deluxe box with a board; BGG only sizes the plain card game'),
    'DGL56-054': ('L', 'the Complete Collection is a huge box; BGG only sizes base Everdell'),
    'DGL7+-060': ('S', 'the standard 24 cm box; BGG also lists an outsized printing'),
    'DGL56-127': ('M', 'the retail box (7 cm); the Kickstarter box was thicker'),
}

# no sizes on BGG: educated guesses from the kind of product
GUESSES = {
    'DGL12-006': 'M', 'DGL12-013': 'S', 'DGL12-015': 'S', 'DGL12-018': 'M', 'DGL12-028': 'S', 'DGL12-031': 'S',
    'DGL12-038': 'S', 'DGL34-026': 'S', 'DGL34-036': 'M', 'DGL34-037': 'S', 'DGL34-042': 'M', 'DGL34-048': 'M',
    'DGL34-074': 'M', 'DGL34-088': 'M', 'DGL34-099': 'M', 'DGL34-107': 'S', 'DGL34-109': 'S', 'DGL34-127': 'M',
    'DGL34-140': 'M', 'DGL56-005': 'L', 'DGL56-024': 'L', 'DGL56-043': 'L', 'DGL56-051': 'S', 'DGL56-052': 'S',
    'DGL56-063': 'S', 'DGL56-082': 'S', 'DGL56-088': 'L', 'DGL56-092': 'L', 'DGL56-136': 'M', 'DGL7+-004': 'S',
    'DGL7+-008': 'S', 'DGL7+-030': 'M', 'DGL7+-040': 'S', 'DGL7+-041': 'S', 'DGL7+-042': 'S', 'DGL7+-044': 'L',
    'DGL7+-048': 'S', 'DGL7+-051': 'S', 'DGL7+-070': 'M', 'DGL7+-080': 'M', 'DGL7+-081': 'M', 'DGL7+-086': 'S',
    'DGL7+-093': 'M', 'DGLF-007': 'S', 'DGLF-020': 'S', 'DGLF-026': 'M', 'DGLF-030': 'M', 'DGLF-032': 'S',
    'DGLF-041': 'M', 'DGLF-043': 'S', 'DGLF-055': 'M',
}


def main():
    games = json.load(open(GAMES, encoding='utf-8'))
    bgg = json.load(open(os.path.join(HERE, 'classified.json')))
    merged = json.load(open(os.path.join(HERE, 'bgg-printings.json')))
    out = {}
    for g in games:
        code = g['code']
        if code.startswith('DGLRPG'):
            continue
        b = bgg.get(code)
        row = {'title': g['title'], 'bgg_id': (b or merged.get(code, {})).get('bgg_id')}
        if code in OVERRIDES:
            size, why = OVERRIDES[code]
            row.update(size=size, source='corrected', why=why, dims_cm=b and b['dims_cm'], kg=b and b['kg'])
        elif b:
            source = 'BGG' if b['lang'] == 'en' else 'BGG (other-language printings)'
            if len(b['split']) > 1:
                source += f", printings split {'/'.join(f'{k}{v}' for k, v in sorted(b['split'].items()))}"
            row.update(size=b['size'], source=source, dims_cm=b['dims_cm'], kg=b['kg'])
        elif code in GUESSES:
            row.update(size=GUESSES[code], source='guess', dims_cm=None, kg=None)
        else:
            raise SystemExit(f'no size for {code} {g["title"]}')
        out[code] = row
    json.dump(out, open(os.path.join(HERE, 'final-sizes.json'), 'w'), ensure_ascii=False, indent=0)
    from collections import Counter
    print(len(out), 'sized:', Counter(r['size'] for r in out.values()),
          '| sources:', Counter(r['source'].split(',')[0] for r in out.values()))


if __name__ == '__main__':
    main()
