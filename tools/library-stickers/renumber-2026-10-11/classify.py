"""Box size (S, M, L) for every library board game from BoardGameGeek's version data.

Rules (Mo's guide, 11 Oct 2026, tightened on the data): small if the longest side is 24 cm or less, however thick
(a 20 x 13 x 12 cm box is still a small box); large if longer than 32 cm (Agricola-style 31.5 cm boxes stand on a
middle shelf), 3 kg or more, or thicker than 9 cm on a big footprint (over 27.5 cm: a thick 25 or 27 cm box is still a medium
one); medium otherwise. BGG lists every printing; the library's copies are recent
English ones, so the size is the majority across English printings from 2014 on (else all English, else any
language), with obvious data-entry errors left out. Allows half a centimetre for BGG's rounding."""
import json
import statistics
import sys

IN = 2.54
L_THICK, L_LONG, S_LONG, HEAVY_KG, BIG = 9.05, 32.5, 24.5, 3.0, 27.5


def plausible(v):
    dims = [v.get('l') or 0, v.get('w') or 0, v.get('d') or 0]
    return all(0.4 <= x <= 28 for x in dims)


def size_of(dims_cm, kg=0):
    a, b, c = sorted(dims_cm, reverse=True)
    if a <= S_LONG:
        return 'S'
    if (c > L_THICK and a > BIG) or a > L_LONG or kg >= HEAVY_KG:
        return 'L'
    return 'M'


def pick(versions):
    good = [v for v in versions if plausible(v)]
    for lang in ('en', 'any'):
        pool = [v for v in good if v.get('lang', 'en') == lang]
        if pool:
            recent = [v for v in pool if str(v.get('year') or '0')[:4].isdigit() and int(str(v['year'])[:4]) >= 2014]
            return (recent or pool), lang
    return [], None


def classify(versions):
    pool, lang = pick(versions)
    if not pool:
        return None
    votes = {}
    for v in pool:
        cm = [v['l'] * IN, v['w'] * IN, v['d'] * IN]
        kg = (v.get('wt') or 0) * 0.4536
        votes.setdefault(size_of(cm, kg), []).append(v)
    newest = max(pool, key=lambda v: str(v.get('year') or ''))
    top = max(votes.items(), key=lambda kv: (len(kv[1]), newest in kv[1]))
    size = top[0]
    chosen = top[1]
    med = [statistics.median(sorted([v['l'], v['w'], v['d']], reverse=True)[i] for v in chosen) * IN for i in range(3)]
    kgs = [(v.get('wt') or 0) * 0.4536 for v in chosen if (v.get('wt') or 0) > 0]
    return {'size': size, 'dims_cm': [round(x, 1) for x in med], 'kg': round(statistics.median(kgs), 2) if kgs else None,
            'versions_used': len(pool), 'agree': len(chosen), 'lang': lang,
            'split': {k: len(v) for k, v in votes.items()}}


if __name__ == '__main__':
    merged = json.load(open(sys.argv[1]))
    out = {}
    for code, g in merged.items():
        r = classify(g.get('versions', []))
        if r:
            out[code] = {'title': g['title'], 'bgg_id': g.get('bgg_id'), 'bgg_name': g.get('bgg_name'), **r}
    json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=0)
    from collections import Counter
    print(len(out), 'classified', Counter(r['size'] for r in out.values()))
