#!/usr/bin/env python3
"""Keep stakeholder-types.json honest.

Each dashboard declares which stakeholder types it uses in its ROSTER_TYPE_TO_LANE map.
stakeholder-types.json carries a `usage` index of the same thing so the admin panel (via
the relay) can refuse to remove a type a dashboard still relies on. Two copies of one
fact drift, so this script checks them against each other and fails loudly.

    python3 _dev/check-types.py           # verify; exit 1 on any mismatch
    python3 _dev/check-types.py --write   # rebuild `usage` from the dashboards, add any
                                          # keys missing from `types` (name = key)

Run it after adding or removing a type in any dashboard, and before pushing.
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
TYPES = ROOT / 'stakeholder-types.json'
DASHBOARDS = sorted(p for p in ROOT.glob('*-dashboard.html'))

def dashboard_types(path):
    s = path.read_text(encoding='utf-8')
    m = re.search(r'const ROSTER_TYPE_TO_LANE = \{(.*?)\};', s, re.S)
    if not m:
        sys.exit(f'{path.name}: no ROSTER_TYPE_TO_LANE found')
    return sorted(set(re.findall(r"'([^']+)'\s*:\s*'\w+'", m.group(1))))

def main():
    write = '--write' in sys.argv
    actual = {p.name.replace('-dashboard.html', ''): dashboard_types(p) for p in DASHBOARDS}
    doc = json.loads(TYPES.read_text(encoding='utf-8')) if TYPES.exists() else {'types': [], 'usage': {}}
    known = {t['key'] for t in doc.get('types', [])}
    problems = []

    for dash, keys in actual.items():
        recorded = sorted(doc.get('usage', {}).get(dash, []))
        if recorded != keys:
            problems.append(f'usage[{dash}] is {recorded}, dashboard uses {keys}')
        for k in keys:
            if k not in known:
                problems.append(f'{dash} uses "{k}" which is not in types')
    for dash in doc.get('usage', {}):
        if dash not in actual:
            problems.append(f'usage has "{dash}" but no such dashboard exists')

    if write:
        for dash, keys in actual.items():
            for k in keys:
                if k not in known:
                    doc.setdefault('types', []).append({'key': k, 'name': k}); known.add(k)
        doc['types'] = sorted(doc['types'], key=lambda t: t['name'].lower())
        doc['usage'] = {d: keys for d, keys in sorted(actual.items())}
        TYPES.write_text(json.dumps(doc, indent=2) + '\n', encoding='utf-8')
        print(f'wrote {TYPES.name}: {len(doc["types"])} types, usage for {", ".join(doc["usage"])}')
        return

    if problems:
        print('stakeholder-types.json is out of sync with the dashboards:')
        for p in problems: print('  -', p)
        print('\nRun with --write to rebuild usage from the dashboards.')
        sys.exit(1)
    print(f'stakeholder-types.json OK: {len(known)} types, usage matches all {len(actual)} dashboards')

if __name__ == '__main__':
    main()
