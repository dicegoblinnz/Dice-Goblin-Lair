#!/usr/bin/env python3
"""Turns the library products pulled from Shopify into the sticker generator's games.json.

Reads the product pages and the recommended-age-group labels straight from this session's log (via
extract_pages.py's products.json and the age-group lookup), so nothing is retyped by hand.

Usage: python3 build_games.py products.json session.jsonl games.json
"""
import json
import sys


def age_labels(session_log):
    labels = {}
    for line in open(session_log, encoding='utf-8'):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        content = (entry.get('message') or {}).get('content')
        if not isinstance(content, list):
            continue
        for part in content:
            if not (isinstance(part, dict) and part.get('type') == 'tool_result'):
                continue
            body = part.get('content')
            text = ''.join(x.get('text', '') for x in body if isinstance(x, dict)) if isinstance(body, list) else str(body)
            if '"shopify--recommended-age-group"' not in text:
                continue
            try:
                data = json.loads(text)
            except ValueError:
                continue
            for node in (data.get('data') or {}).get('nodes') or []:
                if node and node.get('type') == 'shopify--recommended-age-group':
                    fields = {f['key']: f['value'] for f in node['fields']}
                    labels[node['id']] = fields.get('label') or node['displayName']
    return labels


def main(products_path, session_log, out):
    products = json.load(open(products_path, encoding='utf-8'))
    labels = age_labels(session_log)
    games = []
    for p in products:
        if not p.get('c'):
            continue  # the membership products sit in the collection too
        code = p['c']['v'].strip()
        variant = (p['variants']['nodes'] or [{}])[0]
        qr = (variant.get('b') or '').strip() or (variant.get('k') or '').strip() or code
        title = p['t']
        if title.endswith(' (Library)'):
            title = title[:-len(' (Library)')]
        ages = None
        if p.get('a'):
            ids = json.loads(p['a']['v'])
            missing = [i for i in ids if i not in labels]
            if missing:
                raise SystemExit(f'no label for age group {missing} ({code})')
            ages = labels[ids[0]] if ids else None
        games.append({
            'title': title.strip(),
            'code': code,
            'qr': qr,
            'players': (p.get('p') or {}).get('v'),
            'time': (p.get('m') or {}).get('v'),
            'ages': ages,
            'status': p['s'],
            'productId': p['id'],
        })
    games.sort(key=lambda g: g['code'])
    json.dump(games, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'{len(games)} games written to {out} ({len(labels)} age-group labels)')


if __name__ == '__main__':
    main(*sys.argv[1:4])
