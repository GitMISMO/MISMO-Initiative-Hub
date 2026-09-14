/* MISMO Initiative Hub — save relay
 *
 * One Lambda, one job: accept a dashboard save from a facilitator who has a valid key,
 * and commit it to the repository with the single GitHub token that lives here and
 * nowhere else. Facilitators never see or hold a GitHub token. Revoking a facilitator
 * is deleting one line from FACILITATOR_KEYS. Rotating the GitHub token is changing
 * one environment variable.
 *
 * ENVIRONMENT VARIABLES (set on the Lambda; the code reads nothing else)
 *   GITHUB_TOKEN       Fine-grained PAT owned by the repository owner. This repo only,
 *                      Contents: Read and write. Nothing else.
 *   GITHUB_REPO        e.g. PWCodingLLC/MISMO-Initiative-Hub
 *   GITHUB_BRANCH      e.g. main
 *   ALLOWED_ORIGIN     e.g. https://pwcodingllc.github.io   (exactly, no trailing slash)
 *   FACILITATOR_KEYS   One facilitator per line, "Display Name=passcode". Example:
 *                          Jane Facilitator=k7Qm-2vXp-9Lrt
 *                          Sam Facilitator=b3Wn-8Ycd-4Hjs
 *                      The display name becomes the git author of that person's saves.
 *
 * ROUTES (all under the function URL)
 *   GET  /data/{id}    Fresh read of data/{id}.json with its blob SHA. Requires a key.
 *   PUT  /data/{id}    Commit a new version. Body: {content, sha}. Requires a key.
 *                      The sha is the one the page READ; GitHub rejects the write with
 *                      409 if anyone committed since, and that 409 is passed straight
 *                      through. This function must never fetch a fresh SHA on the
 *                      caller's behalf — doing so defeats the lock.
 *   OPTIONS *          CORS preflight. Handled here, so leave CORS DISABLED on the
 *                      function URL itself; enabling both sends duplicate headers and
 *                      the browser refuses the response.
 *
 * The key travels in the X-Facilitator-Key header as "Display Name:passcode".
 *
 * No AWS services are called and no data is stored, so the execution role needs
 * nothing beyond the default logging permissions.
 */

const GITHUB_API = 'https://api.github.com';
const MAX_BODY_BYTES = 1_000_000;                 // dashboards are ~10 KB; 1 MB is generous
const DASHBOARD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;   // data/<id>.json — no dots, no slashes

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/* "Name=passcode" lines → Map(passcode → name). Parsed per invocation so an env change
 * takes effect on the next call without a redeploy. Blank lines and #comments ignored. */
function loadFacilitators() {
  const map = new Map();
  for (const raw of env('FACILITATOR_KEYS').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const pass = line.slice(eq + 1).trim();
    if (name && pass) map.set(pass, name);
  }
  return map;
}

/* Constant-time comparison so a passcode can't be guessed one character at a time by
 * timing the response. Overkill at this scale, but it costs nothing. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authenticate(headers) {
  const raw = headers['x-facilitator-key'] || '';
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const name = raw.slice(0, colon).trim();
  const pass = raw.slice(colon + 1).trim();
  for (const [storedPass, storedName] of loadFacilitators()) {
    if (safeEqual(pass, storedPass) && storedName === name) return storedName;
  }
  return null;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': env('ALLOWED_ORIGIN'),
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Facilitator-Key',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body)
  };
}

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

function decodeBase64Utf8(b64) {
  return Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8');
}

export async function handler(event) {
  const method = (event.requestContext?.http?.method || 'GET').toUpperCase();
  const rawPath = event.rawPath || '/';
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  // Only the request origin we expect. A browser on any other site gets nothing useful
  // even before authentication.
  const origin = headers['origin'];
  if (origin && origin !== env('ALLOWED_ORIGIN')) {
    return respond(403, { error: 'ORIGIN', message: 'This relay only serves the dashboard site.' });
  }

  const match = rawPath.match(/^\/data\/([^/]+)$/);
  if (!match) return respond(404, { error: 'NOT_FOUND' });
  const id = match[1];
  if (!DASHBOARD_ID.test(id)) return respond(400, { error: 'BAD_ID' });
  const filePath = `data/${id}.json`;

  const who = authenticate(headers);
  if (!who) return respond(401, { error: 'KEY_BAD', message: 'That facilitator key was not recognised.' });

  const repo = env('GITHUB_REPO');
  const branch = env('GITHUB_BRANCH');

  if (method === 'GET') {
    const { status, json } = await github('GET', `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`);
    if (status === 404) return respond(200, { data: null, sha: null });
    if (status !== 200) return respond(502, { error: 'GITHUB', status, message: json?.message });
    let data;
    try { data = JSON.parse(decodeBase64Utf8(json.content)); }
    catch { return respond(502, { error: 'CORRUPT', message: 'The committed data file is not valid JSON.' }); }
    return respond(200, { data, sha: json.sha });
  }

  if (method === 'PUT') {
    const bodyText = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    if (Buffer.byteLength(bodyText) > MAX_BODY_BYTES) return respond(413, { error: 'TOO_LARGE' });

    let body;
    try { body = JSON.parse(bodyText); } catch { return respond(400, { error: 'BAD_JSON' }); }
    if (!body || typeof body.content !== 'object' || body.content === null) return respond(400, { error: 'BAD_CONTENT' });
    if (body.sha !== null && body.sha !== undefined && !/^[0-9a-f]{40}$/.test(body.sha)) return respond(400, { error: 'BAD_SHA' });

    // Stamp who saved on the record itself as well as on the commit, so the JSON is
    // self-describing when read outside git.
    const payload = { ...body.content, savedBy: who, savedAt: new Date().toISOString() };
    const content = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8').toString('base64');

    const { status, json } = await github('PUT', `/repos/${repo}/contents/${filePath}`, {
      message: `Update ${id.toUpperCase()} dashboard data (saved by ${who})`,
      content,
      branch,
      sha: body.sha || undefined,
      // The facilitator is the author; the token owner is the committer. Git history then
      // shows who made the change, which the per-person-token design used to provide.
      author: { name: who, email: `${who.replace(/\s+/g, '.').toLowerCase()}@facilitators.mismo-hub.invalid` }
    });

    // 409: the sha is stale. 422 with no sha: the file was created since the page read
    // a 404. Both are the lock working; both go back to the browser as a conflict.
    if (status === 409 || (status === 422 && !body.sha)) return respond(409, { error: 'CONFLICT' });
    if (status === 422) return respond(422, { error: 'REJECTED', message: json?.message });
    if (status === 401 || status === 403) return respond(502, { error: 'TOKEN', message: 'The relay\'s GitHub token was rejected. The site owner needs to check it.' });
    if (status !== 200 && status !== 201) return respond(502, { error: 'GITHUB', status, message: json?.message });

    return respond(200, { sha: json.content?.sha, savedBy: who });
  }

  return respond(405, { error: 'METHOD' });
}
