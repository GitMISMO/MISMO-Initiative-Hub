/* MISMO Initiative Hub — save relay
 *
 * One Lambda, one job: accept a dashboard save from someone who holds a valid key, and
 * commit it to the repository with the single GitHub token that lives here and nowhere
 * else. Nobody but the AWS account holder ever sees that token.
 *
 * WHO CAN DO WHAT
 * Keys are managed in the repository, not here. The file facilitators.json at the repo
 * root holds one admin and any number of facilitators, each as a display name plus the
 * SHA-256 hash of a generated passcode. This function reads that file from GitHub on
 * each request (cached briefly), so adding or removing a person is a commit — made in
 * the GitHub web UI, or by the admin panel through this relay — and needs no AWS access.
 *
 *   facilitator   save any dashboard, as themselves
 *   admin         everything a facilitator can do, plus read and write facilitators.json
 *
 * The file is public (the repo is), which is why it holds hashes and why passcodes must
 * be generated, never chosen. _dev/aws/key-helper.html generates them.
 *
 * ENVIRONMENT VARIABLES (set once, by whoever owns the AWS account)
 *   GITHUB_TOKEN     Fine-grained PAT owned by the repository's owner. This repo only,
 *                    Contents: Read and write. The only secret in the system.
 *   GITHUB_REPO      e.g. YourOrg/MISMO-Initiative-Hub
 *   GITHUB_BRANCH    e.g. main
 *   ALLOWED_ORIGIN   e.g. https://yourorg.github.io   (exactly, no trailing slash)
 *
 * ROUTES (all under the function URL; key in header X-Facilitator-Key as "Name:passcode")
 *   GET  /data/{id}       Fresh read of data/{id}.json with its blob SHA.   facilitator+
 *   PUT  /data/{id}       Commit a new version. Body: {content, sha}.       facilitator+
 *   GET  /facilitators    The list (with hashes — the panel resends them) + SHA. admin
 *   PUT  /facilitators    Replace the list. Body: {facilitators, sha}.      admin
 *                         The admin entry is preserved as-is; it cannot be changed
 *                         through this route, so the admin can't lock themselves out.
 *                         To rotate the admin key, edit facilitators.json directly.
 *   GET  /potential/{id}  Read data/potential/{id}.json with its SHA.       facilitator+
 *   PUT  /potential/{id}  Create or update one. Body: {content, sha}.       facilitator+
 *                         Validated (stage, engagement, stakeholder types against
 *                         stakeholder-types.json). On create, the id is added to
 *                         data/potential/index.json, which is what the hub lists.
 *   GET  /config/{name}   Read a global config file with its SHA.           admin
 *   PUT  /config/{name}   Replace it. Body: {content, sha}. Validated.      admin
 *                         Only names in CONFIG_FILES are served. For stakeholder-types,
 *                         the `usage` index is preserved from the current file, never
 *                         taken from the body — it is maintained by _dev/check-types.py.
 *   OPTIONS *             CORS preflight. Handled here — leave CORS DISABLED on the
 *                         function URL, or the browser gets duplicate headers.
 *
 * THE LOCK
 * Every PUT carries the SHA of the version the caller READ. It is forwarded to GitHub
 * untouched; GitHub refuses with 409 if anyone committed since, and that comes straight
 * back. This function must never fetch a fresh SHA on the caller's behalf.
 *
 * No AWS services are called and no data is stored here.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const FACILITATORS_PATH = 'facilitators.json';
const FACILITATORS_CACHE_MS = 30_000;              // revocation lands within half a minute
const MAX_BODY_BYTES = 1_000_000;                  // dashboards are ~10 KB; 1 MB is generous
const DASHBOARD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;   // data/<id>.json — no dots, no slashes
const RESERVED_IDS = new Set(['facilitators', 'stakeholder-types']);   // never dashboards
/* Global config files the admin may edit through /config/{name}, with a validator each. */
const CONFIG_FILES = {
  'stakeholder-types': {
    path: 'stakeholder-types.json',
    validate(body, current) {
      if (!body || !Array.isArray(body.types)) return { error: 'BAD_CONTENT' };
      const keys = new Set(), names = new Set(), types = [];
      for (const t of body.types) {
        const key = typeof t?.key === 'string' ? t.key.trim() : '';
        const name = typeof t?.name === 'string' ? t.name.trim() : '';
        if (!key || key.length > 80) return { error: 'BAD_KEY', key };
        if (!name || name.length > 80) return { error: 'BAD_NAME', key };
        if (keys.has(key)) return { error: 'DUPLICATE_KEY', key };
        if (names.has(name.toLowerCase())) return { error: 'DUPLICATE_NAME', key };
        keys.add(key); names.add(name.toLowerCase());
        types.push({ key, name });
      }
      // A type still referenced by a dashboard cannot be removed. usage comes from the
      // committed file, so the guard cannot be bypassed by editing the request.
      const usage = current?.usage && typeof current.usage === 'object' ? current.usage : {};
      for (const [dash, used] of Object.entries(usage)) {
        for (const k of used) if (!keys.has(k)) return { error: 'IN_USE', key: k, dashboard: dash };
      }
      return { content: { types, usage } };
    }
  }
};
const SHA256_HEX = /^[0-9a-f]{64}$/;
const POTENTIAL_INDEX = 'data/potential/index.json';
const STAGES = new Set(['not-started', 'in-progress', 'in-approvals', 'kickoff-set', 'launched']);
const ENGAGEMENTS = new Set(['not-contacted', 'declined', 'contacted', 'interested', 'committed']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LEADERSHIP_ROLES = new Set(['Chair', 'Vice-Chair', 'Architecture Representative', 'Information Management Representative', 'Education Representative']);

/* A potential-initiative record, checked field by field. Returns {content} or {error, …}.
 * `typeKeys` is the set of keys in stakeholder-types.json; anything else is refused so a
 * record can't reference a type the admin panel doesn't know about. */
function validatePotential(id, body, typeKeys) {
  if (!body || typeof body !== 'object') return { error: 'BAD_CONTENT' };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = str(body.name, 160);
  if (!name) return { error: 'BAD_NAME' };
  const stage = str(body.stage, 20) || 'not-started';
  if (!STAGES.has(stage)) return { error: 'BAD_STAGE', stage };
  const dateLogged = str(body.dateLogged, 10);
  if (dateLogged && !ISO_DATE.test(dateLogged)) return { error: 'BAD_DATE' };

  const stakeholderTypes = [];
  for (const t of Array.isArray(body.stakeholderTypes) ? body.stakeholderTypes : []) {
    const k = str(t, 80);
    if (!typeKeys.has(k)) return { error: 'UNKNOWN_TYPE', type: k };
    if (!stakeholderTypes.includes(k)) stakeholderTypes.push(k);
  }
  const organizations = [];
  for (const o of Array.isArray(body.organizations) ? body.organizations : []) {
    const org = str(o?.org, 120), type = str(o?.type, 80), engagement = str(o?.engagement, 20) || 'not-contacted';
    if (!org) return { error: 'BAD_ORG' };
    if (!typeKeys.has(type)) return { error: 'UNKNOWN_TYPE', type, org };
    if (!ENGAGEMENTS.has(engagement)) return { error: 'BAD_ENGAGEMENT', org };
    organizations.push({ org, type, engagement, contact: str(o?.contact, 160), barrier: str(o?.barrier, 400), notes: str(o?.notes, 2000) });
  }
  const leadership = [];
  for (const l of Array.isArray(body.leadership) ? body.leadership : []) {
    const name = str(l?.name, 120), title = str(l?.title, 120), company = str(l?.company, 120), role = str(l?.role, 60);
    if (!name) return { error: 'BAD_LEADER' };
    if (!LEADERSHIP_ROLES.has(role)) return { error: 'BAD_ROLE', name, role };
    leadership.push({ name, title, company, role });
  }
  const potentialSolutions = [];
  for (const x of Array.isArray(body.potentialSolutions) ? body.potentialSolutions : []) {
    const t = str(x, 400); if (t) potentialSolutions.push(t);
  }
  const updates = [];
  for (const u of Array.isArray(body.updates) ? body.updates : []) {
    const text = str(u?.text, 2000), by = str(u?.by, 120), at = str(u?.at, 40);
    if (!text) return { error: 'BAD_UPDATE' };
    if (at && !Number.isFinite(Date.parse(at))) return { error: 'BAD_UPDATE_DATE' };
    updates.push({ text, by, at: at || new Date().toISOString() });
  }
  updates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { content: {
    id, name, domain: str(body.domain, 80), stage,
    summary: str(body.summary, 4000), whyRaised: str(body.whyRaised, 4000),
    broughtBy: str(body.broughtBy, 200), dateLogged,
    potentialSolutions, leadership, stakeholderTypes, organizations, updates
  } };
}
const BLOB_SHA = /^[0-9a-f]{40}$/;

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/* ---------- GitHub ---------- */

async function github(method, path, body) {
  const res = await fetch(GITHUB_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'mismo-initiative-hub-save-relay'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* some errors have no body */ }
  return { status: res.status, json };
}

const decodeBase64Utf8 = (b64) => Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8');
const encodeBase64Utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8').toString('base64');

async function readFile(repo, branch, path) {
  const { status, json } = await github('GET', `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  if (status === 404) return { status, data: null, sha: null };
  if (status !== 200) return { status, data: null, sha: null, message: json?.message };
  let data;
  try { data = JSON.parse(decodeBase64Utf8(json.content)); } catch { return { status: 500, data: null, sha: null, corrupt: true }; }
  return { status, data, sha: json.sha };
}

/* ---------- facilitators ---------- */

let facilitatorsCache = { at: 0, value: null };

/* Reads facilitators.json from GitHub. Cached across invocations of a warm container for
 * FACILITATORS_CACHE_MS so a burst of saves doesn't burst the GitHub API; bypassed for
 * admin reads and after admin writes so the panel always sees the truth. */
async function loadFacilitators(repo, branch, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && facilitatorsCache.value && now - facilitatorsCache.at < FACILITATORS_CACHE_MS) return facilitatorsCache.value;
  const file = await readFile(repo, branch, FACILITATORS_PATH);
  const value = {
    sha: file.sha,
    admin: file.data?.admin || null,
    facilitators: Array.isArray(file.data?.facilitators) ? file.data.facilitators : [],
    missing: file.status === 404,
    error: file.status !== 200 && file.status !== 404 ? (file.corrupt ? 'CORRUPT' : `HTTP ${file.status}`) : null
  };
  facilitatorsCache = { at: now, value };
  return value;
}

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/* Constant-time comparison of two hex digests, so a passcode can't be guessed one
 * character at a time by timing the response. */
function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function isExpired(entry) {
  if (!entry.expires) return false;
  const t = Date.parse(entry.expires);
  return Number.isFinite(t) && t <= Date.now();
}

/* Returns { name, role } or { error } */
async function authenticate(headers, repo, branch) {
  const raw = headers['x-facilitator-key'] || '';
  const colon = raw.indexOf(':');
  if (colon <= 0) return { error: 'KEY_BAD' };
  const name = raw.slice(0, colon).trim();
  const pass = raw.slice(colon + 1).trim();
  if (!name || !pass) return { error: 'KEY_BAD' };

  const list = await loadFacilitators(repo, branch);
  if (list.error) return { error: 'FACILITATORS_UNREADABLE' };
  const digest = sha256hex(pass);

  const candidates = [];
  if (list.admin) candidates.push({ ...list.admin, role: 'admin' });
  for (const f of list.facilitators) candidates.push({ ...f, role: 'facilitator' });

  // Check every entry even after a match, so the response time doesn't reveal position.
  let found = null;
  for (const c of candidates) {
    const ok = c.name === name && hashesMatch(c.hash, digest);
    if (ok && !found) found = c;
  }
  if (!found) return { error: 'KEY_BAD' };
  if (isExpired(found)) return { error: 'KEY_EXPIRED' };
  return { name: found.name, role: found.role };
}

/* ---------- HTTP ---------- */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': env('ALLOWED_ORIGIN'),
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Facilitator-Key',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

const respond = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  body: JSON.stringify(body)
});

function parseBody(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return { error: respond(413, { error: 'TOO_LARGE' }) };
  try { return { body: JSON.parse(text) }; } catch { return { error: respond(400, { error: 'BAD_JSON' }) }; }
}

/* Maps a GitHub write result to our response. */
function writeOutcome(status, json, hadSha) {
  // 409: the sha is stale. 422 with no sha: the file was created since the caller read a
  // 404. Both are the lock working; both go back as a conflict.
  if (status === 409 || (status === 422 && !hadSha)) return respond(409, { error: 'CONFLICT' });
  if (status === 422) return respond(422, { error: 'REJECTED', message: json?.message });
  if (status === 401 || status === 403) return respond(502, { error: 'TOKEN', message: "The relay's GitHub token was rejected. The site owner needs to check it." });
  if (status !== 200 && status !== 201) return respond(502, { error: 'GITHUB', status, message: json?.message });
  return null;
}

const authorFor = (name) => ({ name, email: `${name.replace(/\s+/g, '.').toLowerCase()}@facilitators.mismo-hub.invalid` });

export async function handler(event) {
  const method = (event.requestContext?.http?.method || 'GET').toUpperCase();
  const rawPath = event.rawPath || '/';
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };

  const origin = headers['origin'];
  if (origin && origin !== env('ALLOWED_ORIGIN')) {
    return respond(403, { error: 'ORIGIN', message: 'This relay only serves the dashboard site.' });
  }

  const repo = env('GITHUB_REPO');
  const branch = env('GITHUB_BRANCH');

  const dataMatch = rawPath.match(/^\/data\/([^/]+)$/);
  const potentialMatch = rawPath.match(/^\/potential\/([^/]+)$/);
  const configMatch = rawPath.match(/^\/config\/([a-z0-9-]+)$/);
  const isFacilitators = rawPath === '/facilitators';
  if (!dataMatch && !potentialMatch && !isFacilitators && !configMatch) return respond(404, { error: 'NOT_FOUND' });
  if (configMatch && !CONFIG_FILES[configMatch[1]]) return respond(404, { error: 'NOT_FOUND' });

  const who = await authenticate(headers, repo, branch);
  if (who.error === 'FACILITATORS_UNREADABLE') return respond(502, { error: 'FACILITATORS_UNREADABLE', message: 'facilitators.json could not be read. The site owner needs to check it.' });
  if (who.error === 'KEY_EXPIRED') return respond(401, { error: 'KEY_EXPIRED', message: 'That facilitator key has expired.' });
  if (who.error) return respond(401, { error: 'KEY_BAD', message: 'That facilitator key was not recognised.' });

  /* ----- dashboards: facilitator or admin ----- */
  if (dataMatch) {
    const id = dataMatch[1];
    if (!DASHBOARD_ID.test(id) || RESERVED_IDS.has(id)) return respond(400, { error: 'BAD_ID' });
    const filePath = `data/${id}.json`;

    if (method === 'GET') {
      const file = await readFile(repo, branch, filePath);
      if (file.status === 404) return respond(200, { data: null, sha: null });
      if (file.corrupt) return respond(502, { error: 'CORRUPT', message: 'The committed data file is not valid JSON.' });
      if (file.status !== 200) return respond(502, { error: 'GITHUB', status: file.status, message: file.message });
      return respond(200, { data: file.data, sha: file.sha });
    }

    if (method === 'PUT') {
      const { body, error } = parseBody(event);
      if (error) return error;
      if (!body || typeof body.content !== 'object' || body.content === null) return respond(400, { error: 'BAD_CONTENT' });
      if (body.sha != null && !BLOB_SHA.test(body.sha)) return respond(400, { error: 'BAD_SHA' });

      const payload = { ...body.content, savedBy: who.name, savedAt: new Date().toISOString() };
      const { status, json } = await github('PUT', `/repos/${repo}/contents/${filePath}`, {
        message: `Update ${id.toUpperCase()} dashboard data (saved by ${who.name})`,
        content: encodeBase64Utf8(payload),
        branch,
        sha: body.sha || undefined,
        // The person is the author; the token owner is the committer. History shows who.
        author: authorFor(who.name)
      });
      const bad = writeOutcome(status, json, !!body.sha);
      if (bad) return bad;
      return respond(200, { sha: json.content?.sha, savedBy: who.name });
    }

    return respond(405, { error: 'METHOD' });
  }

  /* ----- potential initiatives: facilitator or admin ----- */
  if (potentialMatch) {
    const id = potentialMatch[1];
    if (!DASHBOARD_ID.test(id) || id === 'index') return respond(400, { error: 'BAD_ID' });
    const filePath = `data/potential/${id}.json`;

    if (method === 'GET') {
      const file = await readFile(repo, branch, filePath);
      if (file.status === 404) return respond(200, { data: null, sha: null });
      if (file.corrupt) return respond(502, { error: 'CORRUPT' });
      if (file.status !== 200) return respond(502, { error: 'GITHUB', status: file.status, message: file.message });
      return respond(200, { data: file.data, sha: file.sha });
    }

    if (method === 'PUT') {
      const { body, error } = parseBody(event);
      if (error) return error;
      if (body?.sha != null && !BLOB_SHA.test(body.sha)) return respond(400, { error: 'BAD_SHA' });
      const typesFile = await readFile(repo, branch, 'stakeholder-types.json');
      const typeKeys = new Set((typesFile.data?.types || []).map(t => t.key));
      const v = validatePotential(id, body?.content, typeKeys);
      if (v.error) return respond(400, v);

      const payload = { ...v.content, savedBy: who.name, savedAt: new Date().toISOString() };
      const { status, json } = await github('PUT', `/repos/${repo}/contents/${filePath}`, {
        message: `${body.sha ? 'Update' : 'Create'} potential initiative "${v.content.name}" (saved by ${who.name})`,
        content: encodeBase64Utf8(payload), branch, sha: body.sha || undefined, author: authorFor(who.name)
      });
      const bad = writeOutcome(status, json, !!body.sha);
      if (bad) return bad;

      // Static hosting can't list a directory, so the hub reads an index. Add the id if
      // it's new. Read-modify-write with the index's own SHA; one retry on a race.
      let indexed = true;
      for (let attempt = 0; attempt < 2; attempt++) {
        const idx = await readFile(repo, branch, POTENTIAL_INDEX);
        const ids = Array.isArray(idx.data?.ids) ? idx.data.ids : [];
        if (ids.includes(id)) break;
        const r = await github('PUT', `/repos/${repo}/contents/${POTENTIAL_INDEX}`, {
          message: `Index potential initiative "${v.content.name}"`,
          content: encodeBase64Utf8({ ids: [...ids, id] }), branch, sha: idx.sha || undefined, author: authorFor(who.name)
        });
        if (r.status === 200 || r.status === 201) break;
        if (attempt === 1) indexed = false;
      }
      return respond(200, { sha: json.content?.sha, savedBy: who.name, indexed });
    }
    return respond(405, { error: 'METHOD' });
  }

  /* ----- config + facilitators: admin only ----- */
  if (who.role !== 'admin') return respond(403, { error: 'ADMIN_ONLY', message: 'Only the admin key can do that.' });

  if (configMatch) {
    const cfg = CONFIG_FILES[configMatch[1]];
    if (method === 'GET') {
      const file = await readFile(repo, branch, cfg.path);
      if (file.status === 404) return respond(200, { content: null, sha: null });
      if (file.corrupt) return respond(502, { error: 'CORRUPT', message: `${cfg.path} is not valid JSON.` });
      if (file.status !== 200) return respond(502, { error: 'GITHUB', status: file.status, message: file.message });
      return respond(200, { content: file.data, sha: file.sha });
    }
    if (method === 'PUT') {
      const { body, error } = parseBody(event);
      if (error) return error;
      if (body?.sha != null && !BLOB_SHA.test(body.sha)) return respond(400, { error: 'BAD_SHA' });
      const current = await readFile(repo, branch, cfg.path);
      if (current.corrupt) return respond(502, { error: 'CORRUPT' });
      const v = cfg.validate(body?.content, current.data);
      if (v.error) return respond(400, v);
      const { status, json } = await github('PUT', `/repos/${repo}/contents/${cfg.path}`, {
        message: `Update ${configMatch[1]} (by ${who.name})`,
        content: encodeBase64Utf8(v.content),
        branch,
        sha: body.sha || undefined,
        author: authorFor(who.name)
      });
      const bad = writeOutcome(status, json, !!body.sha);
      if (bad) return bad;
      return respond(200, { sha: json.content?.sha });
    }
    return respond(405, { error: 'METHOD' });
  }

  if (method === 'GET') {
    const list = await loadFacilitators(repo, branch, { fresh: true });
    if (list.error) return respond(502, { error: 'FACILITATORS_UNREADABLE' });
    // Hashes are included: the panel replaces the whole list on save and must resend the
    // entries it did not change. The file is public, so nothing is exposed here that
    // isn't already. The admin's own hash is still withheld — the panel never writes it.
    return respond(200, {
      sha: list.sha,
      admin: list.admin ? { name: list.admin.name } : null,
      facilitators: list.facilitators.map(f => ({ name: f.name, hash: f.hash, expires: f.expires || null }))
    });
  }

  if (method === 'PUT') {
    const { body, error } = parseBody(event);
    if (error) return error;
    if (!body || !Array.isArray(body.facilitators)) return respond(400, { error: 'BAD_CONTENT' });
    if (body.sha != null && !BLOB_SHA.test(body.sha)) return respond(400, { error: 'BAD_SHA' });

    // Validate every entry before touching the file. A single bad entry rejects the whole
    // write rather than silently dropping it.
    const seen = new Set();
    const clean = [];
    for (const f of body.facilitators) {
      const name = typeof f?.name === 'string' ? f.name.trim() : '';
      const hash = typeof f?.hash === 'string' ? f.hash.trim().toLowerCase() : '';
      if (!name || name.length > 80) return respond(400, { error: 'BAD_NAME', name });
      if (!SHA256_HEX.test(hash)) return respond(400, { error: 'BAD_HASH', name });
      if (seen.has(name)) return respond(400, { error: 'DUPLICATE_NAME', name });
      seen.add(name);
      const entry = { name, hash };
      if (f.expires) {
        if (!Number.isFinite(Date.parse(f.expires))) return respond(400, { error: 'BAD_EXPIRES', name });
        entry.expires = f.expires;
      }
      clean.push(entry);
    }

    // The admin entry is carried over from the current file, never taken from the body.
    const current = await loadFacilitators(repo, branch, { fresh: true });
    if (current.error) return respond(502, { error: 'FACILITATORS_UNREADABLE' });
    if (!current.admin) return respond(500, { error: 'NO_ADMIN', message: 'facilitators.json has no admin entry; fix it directly in the repository.' });
    if (clean.some(f => f.name === current.admin.name)) return respond(400, { error: 'ADMIN_NAME_RESERVED', name: current.admin.name });

    const { status, json } = await github('PUT', `/repos/${repo}/contents/${FACILITATORS_PATH}`, {
      message: `Update facilitators (by ${who.name})`,
      content: encodeBase64Utf8({ admin: current.admin, facilitators: clean }),
      branch,
      sha: body.sha || undefined,
      author: authorFor(who.name)
    });
    const bad = writeOutcome(status, json, !!body.sha);
    if (bad) return bad;
    facilitatorsCache = { at: 0, value: null };   // next auth must see the new list
    return respond(200, { sha: json.content?.sha });
  }

  return respond(405, { error: 'METHOD' });
}
