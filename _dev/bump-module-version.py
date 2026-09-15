#!/usr/bin/env python3
"""Cache-bust dashboard-data.js.

Every page loads dashboard-data.js with a ?v= query. Browsers and the Pages CDN cache
the script by URL, so a page shipped alongside a changed module can otherwise run
against a STALE cached copy and fail on a function that doesn't exist yet — which
shows up as a page stuck on "Loading…" with the real error only in the console.

Run this after ANY change to dashboard-data.js, before committing:

    python3 _dev/bump-module-version.py

It rewrites the query on every include to the module's content hash, so the URL
changes exactly when the file does and never otherwise.
"""
import hashlib, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
digest = hashlib.sha256((ROOT / 'dashboard-data.js').read_bytes()).hexdigest()[:10]
pat = re.compile(r'(<script src="(?:\.\./)?dashboard-data\.js)(\?v=[0-9a-f]+)?(")')
changed = 0
for p in list(ROOT.glob('*.html')) + [ROOT / '_dev' / 'dashboard-template.html']:
    s = p.read_text(encoding='utf-8')
    new, n = pat.subn(lambda m: f'{m.group(1)}?v={digest}{m.group(3)}', s)
    if n and new != s:
        p.write_text(new, encoding='utf-8'); changed += 1
print(f'dashboard-data.js?v={digest} — {changed} file(s) updated')
if '--check' in sys.argv and changed:
    sys.exit('includes were stale; run without --check and commit')
