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
 * be generated, never chosen. key-helper.html generates them.
 *
 * ENVIRONMENT VARIABLES (set once, by whoever owns the AWS account)
 *   GITHUB_TOKEN     Fine-grained PAT owned by the repository's owner. This repo only,
 *                    Contents: Read and write. The only secret in the system.
 *   GITHUB_REPO      e.g. YourOrg/initiative-hub
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

import { createHash, createHmac, timingSafeEqual, pbkdf2Sync } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
/* Under _internal/ so GitHub Pages does not serve it. Jekyll skips underscore-prefixed
 * paths, and the relay reads this through the GitHub API rather than over the web, so the
 * move is invisible to it. At the repository root the file was downloadable by anyone at
 * <site>/facilitators.json, which published the list of everyone holding edit access. */
const FACILITATORS_PATH = '_internal/facilitators.json';
const PBKDF2_ITERATIONS = 210000;        // OWASP's 2023 floor for PBKDF2-HMAC-SHA256
const PBKDF2_KEYLEN = 32;
const TOKEN_TTL_SECONDS = 8 * 60 * 60;   // one working day, then sign in again
const ACCESS_PATH_DEFAULT = '_internal/access.json';
const ACCESS_CACHE_MS = 30000;           // a permission change lands within half a minute
const FACILITATORS_CACHE_MS = 30_000;              // revocation lands within half a minute
const PROJECTS_CACHE_MS = 60_000;                  // a newly added tool is live within a minute
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
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PBKDF2_STORED = /^pbkdf2\$\d{4,}\$[a-f0-9]{16,}\$[a-f0-9]{64}$/;
const isStoredHash = (h) => PBKDF2_STORED.test(h) || SHA256_HEX.test(h);
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

/* PROJECTS maps a project key to its repository, branch and allowed origin:
 *   {"hub":{"repo":"GitMISMO/initiative-hub","branch":"main","origin":"https://…"},
 *    "glossary":{"repo":"GitMISMO/glossary","branch":"main","origin":"https://…"}}
 *
 * Every route is prefixed with the project key, and ONE lookup resolves repo, branch,
 * origin and facilitator list together. That is deliberate: routing, the origin check and
 * the key check must never be able to disagree about which project a request belongs to,
 * or a key for one project could write to the other's repository. Nothing below may take
 * a repo from anywhere else. */
/* WHERE THE LIST LIVES. Two modes, and exactly one is authoritative at a time:
 *
 *   PROJECTS_REPO set  -> the list is projects.json in that repository. Adding a tool is
 *                         a commit, reviewable, attributable and revertible, and needs
 *                         nobody with AWS access.
 *   PROJECTS_REPO unset -> the list is the PROJECTS environment variable.
 *
 * There is deliberately no fallback from the first to the second. If the file cannot be
 * read we serve 503 rather than quietly using a stale copy from the environment: a stale
 * copy could still name a repo that has since been repointed, and writing to the wrong
 * repository is far worse than being briefly unavailable.
 *
 * This is NOT a weakening of access control. The relay's token only reaches repositories
 * it was explicitly granted, and that grant lives in GitHub under org-admin control. A
 * rogue entry here names a repo the token cannot write, and GitHub refuses it. The file
 * decides which repos the relay *knows about*; the token decides which it can *touch*. */
const projectsCache = { at: 0, value: null };
let currentProjectKey = null;   // set per request; a token is only valid for its own project
let lastKnownOrigin = null;   // see corsHeaders

/* Test hook only. Lambda never calls this — a real container simply ages out after
 * PROJECTS_CACHE_MS. It exists so the suite can simulate a cold start, which is the
 * only way to exercise the "list unreadable and nothing cached" path. */
export function __resetProjectsCache() { projectsCache.at = 0; projectsCache.value = null; lastKnownOrigin = null; }

function parseProjects(raw, source) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`${source} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object of project keys`);
  }
  return parsed;
}

async function projects() {
  const configRepo = process.env.PROJECTS_REPO;
  if (!configRepo) {
    const value = parseProjects(env('PROJECTS'), 'PROJECTS');
    lastKnownOrigin = Object.values(value)[0]?.origin || lastKnownOrigin;
    return value;
  }

  const now = Date.now();
  if (projectsCache.value && now - projectsCache.at < PROJECTS_CACHE_MS) return projectsCache.value;

  const branch = process.env.PROJECTS_BRANCH || 'main';
  const path = process.env.PROJECTS_PATH || 'projects.json';
  const file = await readFile(configRepo, branch, path);
  if (file.status !== 200) {
    // Serve the last good copy if we have one; a warm container should not start failing
    // because of one bad minute at GitHub. A cold container has nothing, so it says so.
    if (projectsCache.value) return projectsCache.value;
    throw new Error(`CONFIG_UNAVAILABLE: ${path} in ${configRepo} returned ${file.status}`);
  }
  const value = parseProjects(JSON.stringify(file.data), `${path} in ${configRepo}`);
  projectsCache.at = now;
  projectsCache.value = value;
  lastKnownOrigin = Object.values(value)[0]?.origin || lastKnownOrigin;
  return value;
}

/* Every project must live under the same owner as the config file itself. The token is
 * the real boundary, but this turns "someone added another org's repo" into a clear
 * refusal at the door instead of a 404 from GitHub three calls later. */
function sameOwner(repo, configRepo) {
  if (!configRepo) return true;
  return repo.split('/')[0].toLowerCase() === configRepo.split('/')[0].toLowerCase();
}

async function projectConfig(key) {
  const all = await projects();
  const p = all[key];
  if (!p || typeof p !== 'object') return null;
  if (typeof p.repo !== 'string' || !/^[^/]+\/[^/]+$/.test(p.repo)) return null;
  if (typeof p.origin !== 'string' || !p.origin || p.origin.endsWith('/')) return null;
  if (!sameOwner(p.repo, process.env.PROJECTS_REPO)) return null;
  return { key, repo: p.repo, branch: p.branch || 'main', origin: p.origin };
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

/* Keyed BY REPOSITORY, not global. A single shared cache across projects would let a
 * cached facilitator list from one project authenticate a request for another — the exact
 * cross-project leak a shared relay has to prevent. Found by test, not by reading. */
/* ---------- the account directory ----------
 *
 * One file, in the same repository as projects.json, listing every person once:
 *
 *   { "people": {
 *       "jane@mismo.org": {
 *         "name": "Jane Facilitator",
 *         "hash": "pbkdf2$...",
 *         "expires": null,
 *         "access": { "hub": "admin", "glossary": "staff" }
 *       } } }
 *
 * Signing in is therefore global, and what you may do is per project. That is the whole
 * point: one account, permissions set per person.
 *
 * Permissions are read on EVERY request rather than written into the token. A token that
 * carried its role would keep working until it expired, so removing someone would take up
 * to TOKEN_TTL_SECONDS to take effect. Read per request, with this cache, a change lands
 * within ACCESS_CACHE_MS. The token proves who you are; the file decides what that means.
 */
const accessCache = { at: 0, value: null };

export function __resetAccessCache() { accessCache.at = 0; accessCache.value = null; }

async function loadAccess() {
  const configRepo = process.env.PROJECTS_REPO;
  if (!configRepo) return { error: 'NO_DIRECTORY' };
  const now = Date.now();
  if (accessCache.value && now - accessCache.at < ACCESS_CACHE_MS) return accessCache.value;

  const branch = process.env.PROJECTS_BRANCH || 'main';
  const path = process.env.ACCESS_PATH || ACCESS_PATH_DEFAULT;
  const file = await readFile(configRepo, branch, path);
  if (file.status === 404) return { error: 'NO_DIRECTORY' };
  if (file.status !== 200) {
    if (accessCache.value) return accessCache.value;   // ride out a brief GitHub failure
    return { error: 'DIRECTORY_UNREADABLE' };
  }
  const people = (file.data && typeof file.data.people === 'object' && file.data.people) || {};
  const value = { people };
  accessCache.at = now;
  accessCache.value = value;
  return value;
}

/* Finds a person by email in the directory and checks their password. */
async function findPerson(email, password) {
  const dir = await loadAccess();
  if (dir.error) return { error: dir.error };
  const id = String(email).trim().toLowerCase();

  // Walk every entry even after a match, so timing does not reveal which emails exist.
  let found = null;
  for (const [addr, person] of Object.entries(dir.people)) {
    const ok = addr.toLowerCase() === id && person && verifyPassword(password, person.hash);
    if (ok && !found) found = { email: addr, ...person };
  }
  if (!found) return { error: 'SIGNIN_FAILED' };
  if (isExpired(found)) return { error: 'ACCOUNT_EXPIRED' };
  return found;
}

/* What this person may do on this project, read fresh. Returns a role or null. */
async function roleFor(email, projectKey) {
  const dir = await loadAccess();
  if (dir.error) return { error: dir.error };
  const person = Object.entries(dir.people).find(([addr]) => addr.toLowerCase() === String(email).toLowerCase())?.[1];
  if (!person) return { error: 'NO_ACCOUNT' };
  if (isExpired(person)) return { error: 'ACCOUNT_EXPIRED' };
  const role = person.access && person.access[projectKey];
  /* 'facilitator' is accepted as a synonym for 'staff'. The role was renamed in Sept
   * 2026 while access.json was still empty, so nothing needed migrating — this only
   * covers a hand-edited file that predates the rename. */
  if (role !== 'admin' && role !== 'staff' && role !== 'facilitator') return { error: 'NO_ACCESS' };
  if (role === 'facilitator') return { name: person.name || email, role: 'staff' };
  return { name: person.name || email, role };
}

const facilitatorsCache = new Map();

/* Test hook only, matching __resetProjectsCache. Lambda never calls it — a warm container
 * simply ages out after FACILITATORS_CACHE_MS. The suite needs it to swap the fixture
 * mid-run without waiting out the cache. */
export function __resetFacilitatorsCache() { facilitatorsCache.clear(); }

/* Reads facilitators.json from GitHub. Cached across invocations of a warm container for
 * FACILITATORS_CACHE_MS so a burst of saves doesn't burst the GitHub API; bypassed for
 * admin reads and after admin writes so the panel always sees the truth. */
async function loadFacilitators(repo, branch, { fresh = false } = {}) {
  const now = Date.now();
  const hit = facilitatorsCache.get(repo);
  if (!fresh && hit && now - hit.at < FACILITATORS_CACHE_MS) return hit.value;
  const file = await readFile(repo, branch, FACILITATORS_PATH);
  const value = {
    sha: file.sha,
    /* Two shapes are accepted. 'admins' is an array and is the one to use; 'admin' is a
     * single object kept working so an existing file does not have to be rewritten.
     * Everything downstream reads adminList, so the rest of the relay does not care
     * which shape the file used. */
    admin: file.data?.admin || null,
    rawAdmins: Array.isArray(file.data?.admins) ? file.data.admins : null,
    adminList: Array.isArray(file.data?.admins)
      ? file.data.admins
      : (file.data?.admin ? [file.data.admin] : []),
    facilitators: Array.isArray(file.data?.facilitators) ? file.data.facilitators : [],
    missing: file.status === 404,
    error: file.status !== 200 && file.status !== 404 ? (file.corrupt ? 'CORRUPT' : `HTTP ${file.status}`) : null
  };
  facilitatorsCache.set(repo, { at: now, value });
  return value;
}

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/* ---------- passwords ----------
 *
 * Verified here and nowhere else: the browser sends the password over HTTPS and never
 * sees a hash. Stored as "pbkdf2$<iterations>$<salt-hex>$<hash-hex>".
 *
 * PBKDF2 rather than a bare SHA-256 because SHA-256 is fast. A commodity GPU tries
 * billions of candidates a second, so a stolen file of unsalted SHA-256 hashes of
 * human-chosen passwords falls in minutes. A per-account random salt stops the work being
 * shared across accounts, and the iteration count makes each guess expensive.
 *
 * Plain SHA-256 entries are still accepted so existing passcodes keep working through the
 * changeover. Those were only ever safe because key-helper.html generated them at high
 * entropy; reissue them as pbkdf2 and delete that branch. */
function pbkdf2Hex(password, saltHex, iterations) {
  return pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iterations, PBKDF2_KEYLEN, 'sha256').toString('hex');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, iterStr, saltHex, hashHex] = stored.split('$');
    const iterations = Number(iterStr);
    if (!Number.isInteger(iterations) || iterations < 1000 || !saltHex || !hashHex) return false;
    return hashesMatch(hashHex, pbkdf2Hex(password, saltHex, iterations));
  }
  return hashesMatch(stored, sha256hex(password));   // legacy, remove once all are pbkdf2
}

/* ---------- session tokens ----------
 *
 * Signed with a secret held only by the Lambda, so a browser cannot mint one. Deliberately
 * the same shape as a JWT (header.payload.signature, base64url) so that swapping in Cognito
 * later changes how a token is VERIFIED and nothing about how it is carried. Every route
 * downstream reads the token, never the password. */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function signToken(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(head + '.' + body).digest());
  return head + '.' + body + '.' + sig;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string') return { error: 'TOKEN_BAD' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'TOKEN_BAD' };
  const [head, body, sig] = parts;
  const expect = b64url(createHmac('sha256', secret).update(head + '.' + body).digest());
  if (sig.length !== expect.length) return { error: 'TOKEN_BAD' };
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return { error: 'TOKEN_BAD' };
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch (e) { return { error: 'TOKEN_BAD' }; }
  if (!payload || typeof payload.exp !== 'number') return { error: 'TOKEN_BAD' };
  if (payload.exp * 1000 <= Date.now()) return { error: 'TOKEN_EXPIRED' };
  return payload;
}

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

/* Resolves the caller to { email, name, role } or { error }.
 *
 * Two ways in, on purpose:
 *   Authorization: Bearer <token>   the new path. A token minted by /auth/login.
 *   X-Facilitator-Key: Name:pass    the old path, kept so nothing breaks mid-changeover.
 *
 * The token is checked first and costs no GitHub call, so the common case is fast. The
 * legacy path still reads facilitators.json on every request, which is the other reason
 * to retire it.
 *
 * A token carries the role it was minted with, so a revoked or demoted account keeps its
 * access until the token expires. TOKEN_TTL_SECONDS is the bound on that, and it is why
 * the TTL is a working day rather than a week. Removing someone urgently means rotating
 * AUTH_SECRET, which invalidates every token at once. */
async function authenticate(headers, repo, branch) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return { error: 'NO_AUTH_SECRET' };
    const payload = verifyToken(auth.slice(7).trim(), secret);
    if (payload.error) return { error: payload.error };

    /* A token proves WHO. What they may do here is read fresh from the directory on every
     * request, so removing someone or changing their role takes effect within
     * ACCESS_CACHE_MS rather than waiting out the token's lifetime.
     *
     * Tokens minted before the directory existed carry a project and a role; those are
     * still honoured for their own project so nobody is signed out by this change. */
    if (currentProjectKey) {
      const perm = await roleFor(payload.sub, currentProjectKey);
      if (!perm.error) return { email: payload.sub, name: perm.name, role: perm.role };
      if (perm.error === 'NO_DIRECTORY') {
        /* No directory yet. The token has already proved who this is, so the role comes
         * from whichever list does exist: the token's own claim if it was minted before
         * the change, otherwise this project's facilitators.json looked up by email. No
         * password is involved — identity was established at sign-in. */
        if (payload.project && payload.project === currentProjectKey && payload.role) {
          return { email: payload.sub, name: payload.name || payload.sub, role: payload.role };
        }
        const legacy = await roleFromFacilitators(repo, branch, payload.sub);
        if (legacy.error) return { error: legacy.error };
        return { email: payload.sub, name: legacy.name, role: legacy.role };
      }
      if (perm.error === 'DIRECTORY_UNREADABLE') return { error: perm.error };
      return { error: perm.error };
    }
    return { email: payload.sub, name: payload.name || payload.sub, role: payload.role };
  }

  const raw = headers['x-facilitator-key'] || '';
  const colon = raw.indexOf(':');
  if (colon <= 0) return { error: 'KEY_BAD' };
  const who = raw.slice(0, colon).trim();
  const pass = raw.slice(colon + 1).trim();
  if (!who || !pass) return { error: 'KEY_BAD' };

  const found = await findAccount(repo, branch, who, pass);
  if (found.error) return found;
  return { email: found.email, name: found.name, role: found.role };
}

/* Role for an already-authenticated email, from a project's own facilitators.json.
 * Used only while no central directory exists. */
async function roleFromFacilitators(repo, branch, email) {
  const list = await loadFacilitators(repo, branch);
  if (list.error) return { error: 'FACILITATORS_UNREADABLE' };
  const id = String(email).trim().toLowerCase();
  const candidates = [];
  for (const a of list.adminList) candidates.push({ ...a, role: 'admin' });
  for (const f of list.facilitators) candidates.push({ ...f, role: 'staff' });
  for (const c of candidates) {
    const matches = (c.email && c.email.toLowerCase() === id) || (c.name && c.name.toLowerCase() === id);
    if (matches) {
      if (isExpired(c)) return { error: 'ACCOUNT_EXPIRED' };
      return { name: c.name, role: c.role };
    }
  }
  return { error: 'NO_ACCESS' };
}

/* Shared by the legacy header and /auth/login. Matches on email, and on display name too
 * so existing keys keep working. Every candidate is checked even after a match, so the
 * response time does not reveal which account exists or where it sits in the list. */
async function findAccount(repo, branch, identifier, password) {
  const list = await loadFacilitators(repo, branch);
  if (list.error) return { error: 'FACILITATORS_UNREADABLE' };

  const candidates = [];
  for (const a of list.adminList) candidates.push({ ...a, role: 'admin' });
  for (const f of list.facilitators) candidates.push({ ...f, role: 'staff' });

  const id = String(identifier).trim().toLowerCase();
  let found = null;
  for (const c of candidates) {
    const matchesId = (c.email && c.email.toLowerCase() === id) || (c.name && c.name.toLowerCase() === id);
    const ok = matchesId && verifyPassword(password, c.hash);
    if (ok && !found) found = c;
  }
  if (!found) return { error: 'KEY_BAD' };
  if (isExpired(found)) return { error: 'KEY_EXPIRED' };
  return { email: found.email || found.name, name: found.name, role: found.role };
}

/* ---------- HTTP ---------- */

function corsHeaders(origin) {
  return {
    // Echoes only an origin that a configured project declared. Never '*': these routes
    // are authenticated by a header, so a wildcard would let any site call them.
    // corsHeaders is synchronous and the project list is now an async read, so it uses
    // the origin remembered from the last successful load rather than looking one up.
    // Only matters for errors raised before a project is resolved (unknown project, or
    // the list being unreadable) — without it the browser hides the error body and the
    // page reports a generic network failure instead of the real reason.
    'Access-Control-Allow-Origin': origin || lastKnownOrigin || 'null',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Facilitator-Key, Authorization',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

let responseOrigin = null;   // set once the project is resolved, so CORS matches the caller
const respond = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...corsHeaders(responseOrigin) },
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

  responseOrigin = null;

  // Every path starts with the project key. One lookup decides repo, branch and origin.
  const projMatch = rawPath.match(/^\/([a-z0-9-]+)(\/.*)?$/);
  let proj = null;
  try {
    proj = projMatch ? await projectConfig(projMatch[1]) : null;
  } catch (e) {
    // The project list could not be read at all. Refusing is the only safe answer: we do
    // not know which repository this request belongs to, and guessing writes to the wrong
    // one. 503 says "try again", not "your request was wrong".
    console.error('project config unavailable:', e.message);
    if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(null), body: '' };
    return respond(503, { error: 'CONFIG_UNAVAILABLE', message: 'Saving is briefly unavailable. Nothing was written — try again in a minute.' });
  }
  const subPath = projMatch ? (projMatch[2] || '/') : '/';
  currentProjectKey = proj ? proj.key : null;
  if (proj) responseOrigin = proj.origin;

  if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(responseOrigin), body: '' };

  /* POST /{project}/auth/login  { email, password } -> { token, name, role, expiresAt }
   *
   * The only route that sees a password. Everything else takes the token it returns.
   * When Cognito replaces this, the page keeps calling something that returns a token and
   * the rest of the relay is untouched — which is the point of doing it this way now. */
  if (method === 'POST' && subPath === '/auth/login') {
    if (!proj) return respond(404, { error: 'UNKNOWN_PROJECT' });
    const secret = process.env.AUTH_SECRET;
    if (!secret) return respond(500, { error: 'NO_AUTH_SECRET', message: 'AUTH_SECRET is not set on the function.' });

    const parsed = parseBody(event);
    if (parsed.error) return parsed.error;
    const email = typeof parsed.body?.email === 'string' ? parsed.body.email.trim() : '';
    const password = typeof parsed.body?.password === 'string' ? parsed.body.password : '';
    if (!email || !password) return respond(400, { error: 'MISSING_CREDENTIALS' });

    /* The directory is the real source. The per-repository facilitators.json is tried only
     * if no directory exists yet, so this works before and after the migration. */
    let found = await findPerson(email, password);
    let access = null;
    if (!found.error) {
      access = found.access || {};
    } else if (found.error === 'NO_DIRECTORY') {
      const legacy = await findAccount(proj.repo, proj.branch, email, password);
      if (legacy.error === 'FACILITATORS_UNREADABLE') return respond(502, { error: legacy.error });
      if (legacy.error) return respond(401, { error: 'SIGNIN_FAILED', message: 'That email and password do not match an account.' });
      found = legacy;
      access = { [proj.key]: legacy.role };
    } else if (found.error === 'DIRECTORY_UNREADABLE') {
      return respond(502, { error: 'DIRECTORY_UNREADABLE', message: 'The account directory could not be read.' });
    } else {
      /* One message for "no such account", "wrong password" and "expired", so the response
       * cannot be used to discover who holds an account. */
      return respond(401, { error: 'SIGNIN_FAILED', message: 'That email and password do not match an account.' });
    }

    const now = Math.floor(Date.now() / 1000);
    /* No project in the token: signing in once covers every tool the person has access to.
     * Which tools those are is decided per request, not here. */
    const token = signToken({
      sub: found.email, name: found.name, iat: now, exp: now + TOKEN_TTL_SECONDS
    }, secret);
    return respond(200, {
      token, name: found.name, email: found.email, access,
      expiresAt: new Date((now + TOKEN_TTL_SECONDS) * 1000).toISOString()
    });
  }
  if (!proj) return respond(404, { error: 'UNKNOWN_PROJECT' });

  const origin = headers['origin'];
  if (origin && origin !== proj.origin) {
    return respond(403, { error: 'ORIGIN', message: 'This relay does not serve that site.' });
  }

  const repo = proj.repo;
  const branch = proj.branch;

  const dataMatch = subPath.match(/^\/data\/([^/]+)$/);
  const potentialMatch = subPath.match(/^\/potential\/([^/]+)$/);
  const configMatch = subPath.match(/^\/config\/([a-z0-9-]+)$/);
  const commitMatch = subPath === '/commit';
  const isFacilitators = subPath === '/facilitators';
  if (!dataMatch && !potentialMatch && !isFacilitators && !configMatch && !commitMatch) return respond(404, { error: 'NOT_FOUND' });
  if (configMatch && !CONFIG_FILES[configMatch[1]]) return respond(404, { error: 'NOT_FOUND' });

  const who = await authenticate(headers, repo, branch);
  if (who.error === 'FACILITATORS_UNREADABLE') return respond(502, { error: 'FACILITATORS_UNREADABLE', message: 'facilitators.json could not be read. The site owner needs to check it.' });
  if (who.error === 'KEY_EXPIRED') return respond(401, { error: 'KEY_EXPIRED', message: 'That account has expired.' });
  if (who.error === 'NO_AUTH_SECRET') return respond(500, { error: 'NO_AUTH_SECRET', message: 'AUTH_SECRET is not set on the function.' });
  /* Token failures keep their own codes so the page can tell "sign in again" from
   * "that was refused" — an expired token means re-authenticate silently, a bad one
   * means something is wrong. Collapsing them into KEY_BAD would make an ordinary
   * eight-hour expiry look like a rejected credential. */
  if (who.error === 'TOKEN_EXPIRED') return respond(401, { error: 'TOKEN_EXPIRED', message: 'Your session has expired. Sign in again.' });
  if (who.error === 'TOKEN_WRONG_PROJECT') return respond(401, { error: 'TOKEN_WRONG_PROJECT', message: 'That session belongs to a different application.' });
  if (who.error === 'TOKEN_BAD') return respond(401, { error: 'TOKEN_BAD', message: 'That session could not be verified. Sign in again.' });
  if (who.error === 'NO_ACCESS') return respond(403, { error: 'NO_ACCESS', message: 'Your account does not have access to this application.' });
  if (who.error === 'NO_ACCOUNT') return respond(401, { error: 'NO_ACCOUNT', message: 'That account no longer exists. Sign in again.' });
  if (who.error === 'ACCOUNT_EXPIRED') return respond(401, { error: 'ACCOUNT_EXPIRED', message: 'That account has expired.' });
  if (who.error === 'DIRECTORY_UNREADABLE') return respond(502, { error: 'DIRECTORY_UNREADABLE', message: 'The account directory could not be read.' });
  if (who.error) return respond(401, { error: 'KEY_BAD', message: 'That email and password were not recognised.' });

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

  /* ----- arbitrary commit via the Git Data API: facilitator or admin -----
   * The Contents API used everywhere else refuses files over 1MB and writes one file per
   * call. The glossary's working copy is far larger than that and its content and metadata
   * must not be able to disagree, so it needs blobs -> tree -> commit -> ref instead.
   * parentSha is the commit the caller last read: the ref update is NOT forced, so if the
   * branch moved underneath, GitHub rejects it rather than discarding the other commit. */
  if (commitMatch) {
    if (method !== 'POST' && method !== 'PUT') return respond(405, { error: 'METHOD' });
    const { body, error } = parseBody(event);
    if (error) return error;
    const files = Array.isArray(body?.files) ? body.files : null;
    if (!files || !files.length) return respond(400, { error: 'BAD_CONTENT' });
    if (files.length > 50) return respond(400, { error: 'TOO_MANY_FILES' });
    for (const f of files) {
      if (typeof f?.path !== 'string' || !f.path || f.path.includes('..') || f.path.startsWith('/')) {
        return respond(400, { error: 'BAD_PATH', path: f?.path });
      }
      if (typeof f?.content !== 'string') return respond(400, { error: 'BAD_FILE', path: f.path });
    }
    const message = typeof body.message === 'string' && body.message.trim()
      ? body.message.trim().slice(0, 500) : 'Update';

    try {
      const ref = await github('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (ref.status !== 200) return respond(502, { error: 'GITHUB', status: ref.status });
      const head = ref.json.object.sha;
      // The caller tells us which commit it read. Mismatch means someone else committed.
      if (body.parentSha && body.parentSha !== head) return respond(409, { error: 'CONFLICT', head });

      const baseCommit = await github('GET', `/repos/${repo}/git/commits/${head}`);
      if (baseCommit.status !== 200) return respond(502, { error: 'GITHUB', status: baseCommit.status });

      const tree = [];
      for (const f of files) {
        const blob = await github('POST', `/repos/${repo}/git/blobs`, {
          content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64'
        });
        if (blob.status !== 201) return respond(502, { error: 'GITHUB', status: blob.status, path: f.path });
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.json.sha });
      }
      const newTree = await github('POST', `/repos/${repo}/git/trees`, { base_tree: baseCommit.json.tree.sha, tree });
      if (newTree.status !== 201) return respond(502, { error: 'GITHUB', status: newTree.status });

      const commit = await github('POST', `/repos/${repo}/git/commits`, {
        message: `${message} [${who.name}]`, tree: newTree.json.sha, parents: [head], author: authorFor(who.name)
      });
      if (commit.status !== 201) return respond(502, { error: 'GITHUB', status: commit.status });

      const upd = await github('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha: commit.json.sha, force: false
      });
      if (upd.status === 422) return respond(409, { error: 'CONFLICT' });
      if (upd.status !== 200) return respond(502, { error: 'GITHUB', status: upd.status });

      return respond(200, { commit: commit.json.sha, savedBy: who.name });
    } catch (e) {
      return respond(502, { error: 'GITHUB', message: String(e && e.message || e) });
    }
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
    // Hashes are included because the panel replaces the whole list on save and must
    // resend the entries it did not change. They are pbkdf2 at 210,000 iterations, so a
    // copy is not usefully crackable, and this route is admin-only. The file itself is no
    // longer web-served — it moved to _internal/ so GitHub Pages does not publish it.
    // Admins' hashes are still withheld: the panel never writes the admin list.
    return respond(200, {
      sha: list.sha,
      admin: list.adminList.length ? { name: list.adminList[0].name } : null,
      admins: list.adminList.map(a => ({ name: a.name })),
      facilitators: list.facilitators.map(f => ({ name: f.name, email: f.email || '', hash: f.hash, expires: f.expires || null }))
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
      /* pbkdf2$<iterations>$<salt>$<hash> is the current format. A bare SHA-256 is still
       * accepted so entries predating the change can be resent unmodified by the panel,
       * which sends back every row including ones it did not touch. */
      if (!isStoredHash(hash)) return respond(400, { error: 'BAD_HASH', name });
      if (seen.has(name)) return respond(400, { error: 'DUPLICATE_NAME', name });
      seen.add(name);
      const entry = { name, hash };
      /* Optional so an older entry without one still round-trips. Lower-cased because
       * sign-in matches case-insensitively and storing it mixed would be misleading. */
      if (f.email) {
        const email = String(f.email).trim().toLowerCase();
        if (email.length > 160 || !email.includes('@')) return respond(400, { error: 'BAD_EMAIL', name });
        if (seen.has(email)) return respond(400, { error: 'DUPLICATE_EMAIL', name });
        seen.add(email);
        entry.email = email;
      }
      if (f.expires) {
        if (!Number.isFinite(Date.parse(f.expires))) return respond(400, { error: 'BAD_EXPIRES', name });
        entry.expires = f.expires;
      }
      clean.push(entry);
    }

    // The admin entry is carried over from the current file, never taken from the body.
    const current = await loadFacilitators(repo, branch, { fresh: true });
    if (current.error) return respond(502, { error: 'FACILITATORS_UNREADABLE' });
    if (!current.adminList.length) return respond(500, { error: 'NO_ADMIN', message: 'facilitators.json has no admin entry; fix it directly in the repository.' });
    /* An admin's name cannot be reused for a facilitator: the two lists are searched
     * together, so a duplicate name would make which record wins depend on ordering. */
    const clash = current.adminList.find(a => clean.some(f => f.name === a.name));
    if (clash) return respond(400, { error: 'ADMIN_NAME_RESERVED', name: clash.name });

    const { status, json } = await github('PUT', `/repos/${repo}/contents/${FACILITATORS_PATH}`, {
      message: `Update facilitators (by ${who.name})`,
      /* Write back in whichever shape the file already used, so saving facilitators does
       * not silently rewrite an unrelated part of the file. */
      content: encodeBase64Utf8(
        Array.isArray(current.rawAdmins)
          ? { admins: current.adminList, facilitators: clean }
          : { admin: current.adminList[0], facilitators: clean }),
      branch,
      sha: body.sha || undefined,
      author: authorFor(who.name)
    });
    const bad = writeOutcome(status, json, !!body.sha);
    if (bad) return bad;
    facilitatorsCache.delete(repo);   // next auth for THIS project must see the new list
    return respond(200, { sha: json.content?.sha });
  }

  return respond(405, { error: 'METHOD' });
}
