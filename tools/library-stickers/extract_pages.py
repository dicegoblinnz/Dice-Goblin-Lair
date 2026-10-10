#!/usr/bin/env python3
"""Pulls the library-sticker GraphQL pages out of this session's log (so nothing is retyped by hand) and saves the
products, one entry per product ID. Usage: python3 extract_pages.py session.jsonl out.json"""
import json
import sys


def tool_texts(path):
    for line in open(path, encoding='utf-8'):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        content = (entry.get('message') or {}).get('content')
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and part.get('type') == 'tool_result':
                body = part.get('content')
                if isinstance(body, list):
                    yield ''.join(x.get('text', '') for x in body if isinstance(x, dict))
                elif isinstance(body, str):
                    yield body


products, pages = {}, []
for text in tool_texts(sys.argv[1]):
    if '"collectionByIdentifier"' not in text:
        continue
    try:
        data = json.loads(text)
    except ValueError:
        continue
    if not isinstance(data, dict) or 'data' not in data:
        continue  # a schema lookup that only names the field
    conn = data['data']['collectionByIdentifier']['products']
    pages.append((len(conn['nodes']), conn['pageInfo']))
    for node in conn['nodes']:
        products[node['id']] = node

json.dump(list(products.values()), open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
for n, info in pages:
    print(n, 'nodes, next page:', info['hasNextPage'], info['endCursor'])
print(len(products), 'distinct products saved to', sys.argv[2])
