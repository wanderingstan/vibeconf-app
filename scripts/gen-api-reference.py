#!/usr/bin/env python3
"""Render docs/api/openapi.yaml as docs/api/reference.md.

The spec is the source of truth; this page is for reading in the repo
without an OpenAPI viewer. Run from anywhere:

    python3 scripts/gen-api-reference.py

Needs PyYAML (`pip install pyyaml`)."""
import os, re, sys
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.join(HERE, '..', 'docs', 'api', 'openapi.yaml')
OUT = os.path.join(HERE, '..', 'docs', 'api', 'reference.md')

doc = yaml.safe_load(open(SPEC))
schemas = doc['components']['schemas']


def deref(node):
    if isinstance(node, dict) and '$ref' in node:
        name = node['$ref'].split('/')[-1]
        inner, _ = deref(schemas[name])
        return inner, name
    return node, None


def typ(s):
    s, name = deref(s)
    if name and name in schemas and (schemas[name].get('enum') or schemas[name].get('type') == 'object'):
        return f'[{name}](#{name.lower()})'
    t = s.get('type')
    if isinstance(t, list):
        t = ' or '.join(str(x) for x in t)
    if 'enum' in s:
        return ' or '.join(f'`{v}`' for v in s['enum'])
    if 'const' in s:
        return f'`{s["const"]}`'
    if t == 'array':
        return f'array of {typ(s.get("items", {}))}'
    if 'oneOf' in s:
        return ' or '.join(typ(x) for x in s['oneOf'])
    return t or 'any'


def props_table(schema, required=None, indent=''):
    schema, _ = deref(schema)
    required = set(required or schema.get('required', []))
    rows = []
    for k, v in (schema.get('properties') or {}).items():
        v2, _ = deref(v)
        desc = (v2.get('description') or '').replace('\n', ' ').strip()
        req = ' (required)' if k in required else ''
        rows.append(f'| `{k}`{req} | {typ(v)} | {desc} |')
    if not rows:
        return ''
    return '| Field | Type | |\n| --- | --- | --- |\n' + '\n'.join(rows) + '\n'


out = []
w = out.append
info = doc['info']
w(f'# {info["title"]}: endpoint reference\n')
# The intro's skip link points at Scalar's tag anchor; here the tag is a heading.
info = dict(info, description=(info.get('description') or '').replace('(#tag/discovery)', '(#discovery)'))
w(f'Generated from [`openapi.yaml`](openapi.yaml) (version {info["version"]}) by `scripts/gen-api-reference.py`. Do not edit by hand; edit the spec.\n')
w('Base URL `http://127.0.0.1:7865` unless the endpoint says otherwise. Every request needs `Authorization: Bearer <token>` unless marked open. See the [guide](README.md) for the model, and the [explorer](https://vibeconferencing.com/api) for try-it.\n')

tags = [t['name'] for t in doc.get('tags', [])]
by_tag = {t: [] for t in tags}
for path, item in doc['paths'].items():
    servers = item.get('servers')
    for method in ('get', 'post', 'put', 'delete', 'patch'):
        op = item.get(method)
        if not op:
            continue
        tag = (op.get('tags') or ['Other'])[0]
        by_tag.setdefault(tag, []).append((method.upper(), path, op, item, servers or op.get('servers')))

w('## Contents\n')
for t in by_tag:
    if by_tag[t]:
        w(f'- [{t}](#{t.lower().replace(" ", "-")})')
w('')

for t in by_tag:
    ops = by_tag[t]
    if not ops:
        continue
    desc = next((x.get('description', '') for x in doc.get('tags', []) if x['name'] == t), '')
    w(f'## {t}\n')
    if desc:
        w(desc + '\n')
    for method, path, op, item, servers in ops:
        w(f'### `{method} {path}`\n')
        open_route = op.get('security') == []
        bits = []
        if servers:
            bits.append(f'on `{servers[0]["url"]}`')
        if open_route:
            bits.append('no token needed')
        w(f'**{op.get("summary", "")}**' + (f' ({", ".join(bits)})' if bits else '') + '\n')
        if op.get('description'):
            w(op['description'].strip() + '\n')
        params = (item.get('parameters') or []) + (op.get('parameters') or [])
        if params:
            w('Parameters:\n')
            w('| Name | In | Type | |\n| --- | --- | --- | --- |')
            for p in params:
                if '$ref' in p:
                    p = doc['components']['parameters'][p['$ref'].split('/')[-1]]
                d = (p.get('description') or '').replace('\n', ' ').strip()
                req = ' (required)' if p.get('required') else ''
                w(f'| `{p["name"]}`{req} | {p["in"]} | {typ(p.get("schema", {}))} | {d} |')
            w('')
        rb = op.get('requestBody')
        if rb:
            content = rb['content'].get('application/json', {})
            schema = content.get('schema', {})
            w('Request body (`application/json`):\n')
            s2, name = deref(schema)
            if name:
                w(f'[{name}](#{name.lower()})\n')
            elif 'oneOf' in s2:
                for alt in s2['oneOf']:
                    a2, an = deref(alt)
                    w(f'*{a2.get("title") or an or "Option"}*\n')
                    w(props_table(a2))
            else:
                w(props_table(s2))
            exs = content.get('examples') or ({'example': {'value': content['example']}} if 'example' in content else {})
            for ename, ex in exs.items():
                w(f'Example{" (" + ex.get("summary", ename) + ")" if ex.get("summary") else ""}:\n')
                import json
                w('```json\n' + json.dumps(ex['value'], indent=2, ensure_ascii=False) + '\n```\n')
        w('Responses:\n')
        w('| Status | |\n| --- | --- |')
        for code, r in op.get('responses', {}).items():
            r2 = r
            if '$ref' in r:
                r2 = doc['components']['responses'][r['$ref'].split('/')[-1]]
            d = (r2.get('description') or '').replace('\n', ' ').strip()
            sch = (r2.get('content') or {}).get('application/json', {}).get('schema')
            link = ''
            if sch:
                _, name = deref(sch)
                if name:
                    link = f' → [{name}](#{name.lower()})'
            w(f'| `{code}` | {d}{link} |')
        w('')

w('## Schemas\n')
for name, s in schemas.items():
    w(f'### {name}\n')
    if s.get('description'):
        w(s['description'].strip() + '\n')
    if 'enum' in s:
        w('One of: ' + ', '.join(f'`{v}`' for v in s['enum']) + '\n')
        continue
    if 'oneOf' in s and not s.get('properties'):
        w('One of: ' + ', '.join(f'[{a["$ref"].split("/")[-1]}](#{a["$ref"].split("/")[-1].lower()})' for a in s['oneOf'] if '$ref' in a) + '\n')
        continue
    if 'allOf' in s:
        w('Extends: ' + ', '.join(f'[{a["$ref"].split("/")[-1]}](#{a["$ref"].split("/")[-1].lower()})' for a in s['allOf'] if '$ref' in a) + '\n')
    t = props_table(s)
    if t:
        w(t)

open(OUT, 'w').write('\n'.join(out))
print(f'wrote {os.path.relpath(OUT)}: {len(out)} lines')
