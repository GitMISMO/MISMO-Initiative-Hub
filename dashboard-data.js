/* Shared dashboard storage — commits to this repository instead of the browser.
 *
 * HOW WRITES REACH GITHUB
 * Through a small relay (an AWS Lambda; source in _dev/aws/index.mjs). The relay holds
 * the one GitHub token, the site owner controls it, and facilitators never see a token
 * exist. A facilitator identifies to the relay with a personal key (display name plus a
 * passcode the owner issued) kept in their own browser's localStorage. Revoking a
 * facilitator is deleting one line on the relay. This replaced a design where each
 * facilitator held their own GitHub token — which could not work on a personal-account
 * repository, since fine-grained tokens can only target repos you own.
 *
 * WHY THIS EXISTS
 * Each dashboard previously saved in two places, neither of which shared anything:
 *   1. window.storage — the Claude artifacts API. It does not exist on GitHub Pages,
 *      and the guard `if (!window.storage) return;` made every call a silent no-op.
 *   2. localStorage — the Save button. This one worked, but only on the device that
 *      clicked it. A facilitator saw "Saved!" and nobody else ever saw the change.
 *
 * Saving now writes data/<id>.json through the GitHub contents API. Every save is a
 * commit, which means history, attribution and rollback come free, and the repo is
 * its own backup. Every visitor reads that file on load, so a save is visible to
 * everyone rather than to one browser.
 *
 * WHAT IT DOES NOT DO
 * A public page cannot hold a write token — view-source defeats it. That is why the
 * GitHub token lives on the relay and not here. This file holds nothing secret; the
 * facilitator key in localStorage only proves who is saving, and can only be used to
 * save. Without one the dashboard is readable but not saveable, which is the correct
 * default for a public URL.
 *
 * Attendance data is not saved here and must not be: participant chips, the meeting
 * leaderboard and facilitator hours are non-editable by design, and every derived
 * metric (the "N of M organizations" note, the status bars, the roadblock flag) is
 * recomputed at render time from the roster.
 */
(function () {
  'use strict';

  /* The relay's function URL, e.g. https://abc123.lambda-url.us-east-1.on.aws
   * No trailing slash. Empty until the Lambda exists; saving explains that if so. */
  var RELAY_URL = '';

  var KEY_KEY = 'mismo-hub-facilitator-key';   // localStorage: "Display Name:passcode"

  var cfg = { id: null, path: null };
  var currentSha = null;       // blob SHA of the file as we last read it; drives conflict detection
  var loadedRemote = false;
  var fileExisted = false;     // distinguishes 'no file yet' (create) from 'file read, SHA unknown' (refuse)

  /* ---------- facilitator key ---------- */

  function getKey() {
    try { return localStorage.getItem(KEY_KEY) || ''; } catch (e) { return ''; }
  }
  function setKey(v) {
    try { v ? localStorage.setItem(KEY_KEY, v) : localStorage.removeItem(KEY_KEY); } catch (e) {}
  }
  function hasKey() { return !!getKey(); }
  function keyName() { var k = getKey(); return k.indexOf(':') > 0 ? k.slice(0, k.indexOf(':')) : ''; }

  function relay(path, opts) {
    opts = opts || {};
    var headers = { 'X-Facilitator-Key': getKey() };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(RELAY_URL + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    });
  }

  /* ---------- reading ---------- */

  /* The SHA captured here is the SHA of the version this page READ. It is sent with the
   * write so GitHub can reject the save if anyone else committed in between. It must
   * never be refreshed at save time — fetching the current SHA just before writing makes
   * every write match and defeats the lock entirely, which is the bug this replaced. */

  /* git blob SHA = sha1("blob " + byteLength + "\0" + bytes). Computed for viewers who read
   * the file without a token, so that adding a token later and saving still holds the lock. */
  async function blobSha(text) {
    if (!window.crypto || !crypto.subtle) return null;
    var body = new TextEncoder().encode(text);
    var header = new TextEncoder().encode('blob ' + body.length + '\0');
    var all = new Uint8Array(header.length + body.length);
    all.set(header, 0); all.set(body, header.length);
    var digest = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* Editors read through the relay: always fresh (no Pages deploy lag, no CDN cache) and
   * it returns the SHA directly. Falls through to the plain read if the relay is unset or
   * the key is rejected, so a bad key degrades to viewing rather than breaking the page. */
  async function loadViaRelay() {
    if (!RELAY_URL) throw new Error('NO_RELAY');
    var res = await relay('/data/' + cfg.id);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var body = await res.json();
    return { data: body.data, sha: body.sha };
  }

  /* Viewers read the deployed file from the same origin: no token, no API quota. */
  async function loadViaPages() {
    var res = await fetch(cfg.path + '?t=' + Date.now(), { cache: 'no-store' });
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var text = await res.text();
    return { data: JSON.parse(text), sha: await blobSha(text) };
  }

  async function load() {
    var result = null;
    try {
      if (hasKey()) {
        try { result = await loadViaRelay(); }
        catch (relayErr) { console.warn('Relay read failed, falling back to the deployed file:', relayErr); }
      }
      if (!result) result = await loadViaPages();
      currentSha = result.sha;
      fileExisted = result.data !== null;
      loadedRemote = true;
      return result.data;
    } catch (err) {
      // Distinguished from "nothing saved yet" on purpose: an unreadable file must not
      // look like an empty one, or the next save would overwrite real data with defaults.
      console.error('Could not read saved dashboard data:', err);
      loadedRemote = false;
      currentSha = null;
      return null;
    }
  }

  /* ---------- writing ---------- */

  async function save(snapshot) {
    if (!hasKey()) return { ok: false, reason: 'NO_KEY' };
    if (!RELAY_URL) return { ok: false, reason: 'NO_RELAY' };
    if (!loadedRemote) return { ok: false, reason: 'NOT_LOADED' };
    // A file was read but no SHA could be computed for it — crypto.subtle is only available
    // on secure origins. Saving without the lock would be a blind overwrite, so refuse.
    if (fileExisted && !currentSha) return { ok: false, reason: 'NO_LOCK' };

    var payload = {
      dashboard: cfg.id,
      rosterData: snapshot.rosterData,
      laneData: snapshot.laneData,
      generic: snapshot.generic
    };

    try {
      // currentSha is the SHA of the version this page READ. The relay forwards it as-is
      // and GitHub refuses the write if it is stale. Neither side may refresh it here.
      var res = await relay('/data/' + cfg.id, { method: 'PUT', body: { content: payload, sha: currentSha } });
      var body = null;
      try { body = await res.json(); } catch (e) {}

      if (res.status === 401) return { ok: false, reason: (body && body.error === 'KEY_EXPIRED') ? 'KEY_EXPIRED' : 'KEY_BAD' };
      if (res.status === 403) return { ok: false, reason: 'ORIGIN' };
      if (res.status === 409) return { ok: false, reason: 'CONFLICT' };
      if (res.status === 422) return { ok: false, reason: 'REJECTED' };
      if (res.status === 502) return { ok: false, reason: (body && body.error === 'TOKEN') ? 'RELAY_TOKEN' : 'RELAY' };
      if (!res.ok) return { ok: false, reason: 'HTTP_' + res.status };

      currentSha = body && body.sha;   // this page now holds the newest version
      fileExisted = true;
      return { ok: true, savedBy: body && body.savedBy };
    } catch (err) {
      return { ok: false, reason: 'NETWORK' };
    }
  }

  /* Written in the interface's voice: what happened, and what to do about it. */
  function explain(reason) {
    switch (reason) {
      case 'NO_TOKEN':    // older name used by the dashboards' Save handler
      case 'NO_KEY':      return 'Add your facilitator key to save. Your edits stay on this page until you do.';
      case 'KEY_BAD':     return 'That facilitator key was not recognised. Check the name and passcode, or ask the site owner for a new one.';
      case 'KEY_EXPIRED': return 'Your facilitator key has expired. Ask the site owner for a new one. Your edits are kept on this page.';
      case 'ADMIN_ONLY':  return 'Only the admin key can manage facilitators.';
      case 'NO_RELAY':    return 'Saving is not connected yet — the site owner still needs to set the relay address in dashboard-data.js. Your edits are kept on this page.';
      case 'ORIGIN':      return 'This copy of the dashboard is not on the official site, so it cannot save. Use the published link.';
      case 'CONFLICT':    return 'Someone else saved while you were editing. Reload to get their changes, then redo yours.';
      case 'REJECTED':    return 'GitHub rejected the save as malformed. Reload and try again; if it repeats, the data file may need repair.';
      case 'RELAY_TOKEN': return 'The save relay could not reach GitHub — its token was rejected. This is for the site owner to fix, not you. Your edits are kept on this page.';
      case 'RELAY':       return 'The save relay returned an error. Try again in a moment; if it persists, tell the site owner. Your edits are kept on this page.';
      case 'NO_LOCK':     return 'This page could not verify it has the latest version, so saving is blocked. Open the dashboard over https and try again.';
      case 'NOT_LOADED':  return 'The saved data could not be read, so saving is blocked to avoid overwriting it. Reload and try again.';
      case 'NETWORK':     return 'Could not reach the save relay. Check your connection and try again.';
      default:            return 'Save failed. Your edits are still on this page.';
    }
  }

  /* ---------- sanitising shared HTML ---------- */

  /* Editable text fields are stored as innerHTML so formatting survives. That was fine when
   * the only source was this browser's own localStorage. The source is now a committed
   * file, which every facilitator's browser will render — so anyone with write access
   * could commit markup that runs in everyone else's page and reads their token. This
   * strips the executable parts and keeps the formatting. */
  var BLOCKED_TAGS = 'script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,svg,math';
  function sanitizeHtml(html) {
    if (typeof html !== 'string') return '';
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll(BLOCKED_TAGS).forEach(function (el) { el.remove(); });
    tpl.content.querySelectorAll('*').forEach(function (el) {
      Array.from(el.attributes).forEach(function (a) {
        var n = a.name.toLowerCase(), v = (a.value || '').trim().toLowerCase();
        if (n.indexOf('on') === 0) el.removeAttribute(a.name);
        else if ((n === 'href' || n === 'src' || n === 'xlink:href' || n === 'action' || n === 'formaction')
                 && (v.indexOf('javascript:') === 0 || v.indexOf('data:') === 0 || v.indexOf('vbscript:') === 0)) {
          el.removeAttribute(a.name);
        }
        else if (n === 'srcdoc') el.removeAttribute(a.name);
      });
    });
    return tpl.innerHTML;
  }

  /* ---------- facilitator key dialog ---------- */

  function promptForKey() {
    var existing = hasKey();
    var name = window.prompt(existing
      ? 'Replace your facilitator key.\n\nYour display name, exactly as the site owner set it up:'
      : 'To save changes you need a facilitator key from the site owner.\n\nYour display name, exactly as they set it up:',
      existing ? keyName() : '');
    if (name === null) return false;
    name = name.trim();
    if (!name) { setKey(''); return true; }          // blank name clears the stored key
    var pass = window.prompt('And your passcode:', '');
    if (pass === null) return false;
    pass = pass.trim();
    if (!pass) { setKey(''); return true; }
    setKey(name + ':' + pass);
    return true;
  }

  /* ---------- stakeholder types: global display names ---------- */

  /* stakeholder-types.json maps each type's immutable KEY (what the dashboards' code and
   * saved data use) to its DISPLAY NAME (what people see). Renaming a type in the admin
   * panel changes the name; the key never changes, so nothing internal moves and no saved
   * data is invalidated. Dashboards call typesLoad() at boot and typeName() at every
   * point a type is shown. If the file can't be read, typeName() returns the key, so the
   * page degrades to today's behaviour rather than to blanks. */
  var typeNames = {};
  async function typesLoad() {
    try {
      var res = await fetch('stakeholder-types.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return false;
      var doc = await res.json();
      var map = {};
      (doc.types || []).forEach(function (t) { if (t && t.key) map[t.key] = t.name || t.key; });
      typeNames = map;
      return true;
    } catch (e) { return false; }
  }
  function typeName(key) { return Object.prototype.hasOwnProperty.call(typeNames, key) ? typeNames[key] : key; }

  /* ---------- global config (admin key only; used by the admin panel) ---------- */

  async function configGet(name) {
    if (!hasKey()) return { ok: false, reason: 'NO_KEY' };
    if (!RELAY_URL) return { ok: false, reason: 'NO_RELAY' };
    try {
      var res = await relay('/config/' + name);
      var body = null; try { body = await res.json(); } catch (e) {}
      if (res.status === 401) return { ok: false, reason: (body && body.error === 'KEY_EXPIRED') ? 'KEY_EXPIRED' : 'KEY_BAD' };
      if (res.status === 403) return { ok: false, reason: (body && body.error === 'ADMIN_ONLY') ? 'ADMIN_ONLY' : 'ORIGIN' };
      if (!res.ok) return { ok: false, reason: 'RELAY' };
      return { ok: true, sha: body.sha, content: body.content };
    } catch (e) { return { ok: false, reason: 'NETWORK' }; }
  }
  async function configPut(name, content, sha) {
    if (!hasKey()) return { ok: false, reason: 'NO_KEY' };
    if (!RELAY_URL) return { ok: false, reason: 'NO_RELAY' };
    try {
      var res = await relay('/config/' + name, { method: 'PUT', body: { content: content, sha: sha || null } });
      var body = null; try { body = await res.json(); } catch (e) {}
      if (res.status === 401) return { ok: false, reason: 'KEY_BAD' };
      if (res.status === 403) return { ok: false, reason: (body && body.error === 'ADMIN_ONLY') ? 'ADMIN_ONLY' : 'ORIGIN' };
      if (res.status === 409) return { ok: false, reason: 'CONFLICT' };
      if (res.status === 400) return { ok: false, reason: 'REJECTED', detail: body };
      if (!res.ok) return { ok: false, reason: 'RELAY' };
      return { ok: true, sha: body.sha };
    } catch (e) { return { ok: false, reason: 'NETWORK' }; }
  }

  /* ---------- potential initiatives ---------- */

  /* One record per initiative at data/potential/<id>.json, listed by data/potential/index.json
   * (static hosting can't list a directory). Viewers read both from the same origin; editors
   * read through the relay for freshness and the SHA. The relay validates on write; the
   * browser mirrors the same rules so the wizard can show problems before anyone clicks Save. */
  var POT = {
    STAGES: [
      { key: 'not-started',  label: 'Not Started' },
      { key: 'in-progress',  label: 'In Progress' },
      { key: 'in-approvals', label: 'In Approvals' },
      { key: 'kickoff-set',  label: 'Kick off Set' },
      { key: 'launched',     label: 'Launched' }
    ],
    ENGAGEMENTS: [
      { key: 'not-contacted', label: 'Not Contacted', color: '#8B94A7' },
      { key: 'declined',      label: 'Declined',      color: '#C2255C' },
      { key: 'contacted',     label: 'Contacted',     color: '#D97706' },
      { key: 'interested',    label: 'Interested',    color: '#EAB308' },
      { key: 'committed',     label: 'Committed',     color: '#059669' }
    ]
  };
  function potLabel(list, key) { var f = list.find(function (x) { return x.key === key; }); return f ? f.label : key; }

  async function potentialList() {
    try {
      var res = await fetch('data/potential/index.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.status === 404) return { ok: true, items: [] };
      if (!res.ok) return { ok: false, reason: 'HTTP_' + res.status };
      var idx = await res.json();
      var ids = Array.isArray(idx.ids) ? idx.ids : [];
      var items = await Promise.all(ids.map(async function (id) {
        try {
          var r = await fetch('data/potential/' + encodeURIComponent(id) + '.json?t=' + Date.now(), { cache: 'no-store' });
          return r.ok ? await r.json() : null;
        } catch (e) { return null; }
      }));
      return { ok: true, items: items.filter(Boolean) };
    } catch (e) { return { ok: false, reason: 'NETWORK' }; }
  }

  async function potentialGet(id) {
    if (hasKey() && RELAY_URL) {
      try {
        var res = await relay('/potential/' + encodeURIComponent(id));
        if (res.ok) { var b = await res.json(); return { ok: true, data: b.data, sha: b.sha, fresh: true }; }
      } catch (e) { /* fall through to the deployed file */ }
    }
    try {
      var r = await fetch('data/potential/' + encodeURIComponent(id) + '.json?t=' + Date.now(), { cache: 'no-store' });
      if (r.status === 404) return { ok: true, data: null, sha: null };
      if (!r.ok) return { ok: false, reason: 'HTTP_' + r.status };
      var text = await r.text();
      return { ok: true, data: JSON.parse(text), sha: await blobSha(text), fresh: false };
    } catch (e) { return { ok: false, reason: 'NETWORK' }; }
  }

  async function potentialPut(id, content, sha) {
    if (!hasKey()) return { ok: false, reason: 'NO_KEY' };
    if (!RELAY_URL) return { ok: false, reason: 'NO_RELAY' };
    try {
      var res = await relay('/potential/' + encodeURIComponent(id), { method: 'PUT', body: { content: content, sha: sha || null } });
      var body = null; try { body = await res.json(); } catch (e) {}
      if (res.status === 401) return { ok: false, reason: (body && body.error === 'KEY_EXPIRED') ? 'KEY_EXPIRED' : 'KEY_BAD' };
      if (res.status === 403) return { ok: false, reason: 'ORIGIN' };
      if (res.status === 409) return { ok: false, reason: 'CONFLICT' };
      if (res.status === 400) return { ok: false, reason: 'REJECTED', detail: body };
      if (res.status === 502) return { ok: false, reason: (body && body.error === 'TOKEN') ? 'RELAY_TOKEN' : 'RELAY' };
      if (!res.ok) return { ok: false, reason: 'HTTP_' + res.status };
      return { ok: true, sha: body.sha, indexed: body.indexed };
    } catch (e) { return { ok: false, reason: 'NETWORK' }; }
  }

  /* Mirrors the relay's rules. Returns { problems: [string], content: normalised }. Problems
   * are shown in the wizard; an empty list means the relay will accept it. */
  function potentialValidate(raw, typeKeys) {
    var problems = [];
    var str = function (v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; };
    var r = raw && typeof raw === 'object' ? raw : {};
    var name = str(r.name, 160); if (!name) problems.push('A name is required.');
    var stage = str(r.stage, 20) || 'not-started';
    if (!POT.STAGES.some(function (x) { return x.key === stage; })) problems.push('Stage "' + stage + '" is not one of: ' + POT.STAGES.map(function (x) { return x.key; }).join(', ') + '.');
    var dateLogged = str(r.dateLogged, 10);
    if (dateLogged && !/^\d{4}-\d{2}-\d{2}$/.test(dateLogged)) problems.push('dateLogged must be YYYY-MM-DD.');
    var types = [];
    (Array.isArray(r.stakeholderTypes) ? r.stakeholderTypes : []).forEach(function (t) {
      var k = str(t, 80);
      if (!typeKeys.has(k)) problems.push('Stakeholder type "' + k + '" is not in the global list.');
      else if (types.indexOf(k) < 0) types.push(k);
    });
    var orgs = [];
    (Array.isArray(r.organizations) ? r.organizations : []).forEach(function (o, i) {
      var org = str(o && o.org, 120), type = str(o && o.type, 80), eng = str(o && o.engagement, 20) || 'not-contacted';
      if (!org) problems.push('Organization #' + (i + 1) + ' has no name.');
      if (!typeKeys.has(type)) problems.push('Organization "' + (org || '#' + (i + 1)) + '" has unknown type "' + type + '".');
      if (!POT.ENGAGEMENTS.some(function (x) { return x.key === eng; })) problems.push('Organization "' + org + '" has unknown engagement "' + eng + '".');
      orgs.push({ org: org, type: type, engagement: eng, contact: str(o && o.contact, 160), barrier: str(o && o.barrier, 400), notes: str(o && o.notes, 2000) });
    });
    var solutions = [];
    (Array.isArray(r.potentialSolutions) ? r.potentialSolutions : []).forEach(function (x) { var t = str(x, 400); if (t) solutions.push(t); });
    var updates = [];
    (Array.isArray(r.updates) ? r.updates : []).forEach(function (u, i) {
      var text = str(u && u.text, 2000), by = str(u && u.by, 120), at = str(u && u.at, 40);
      if (!text) problems.push('Update #' + (i + 1) + ' is empty.');
      if (at && !isFinite(Date.parse(at))) problems.push('Update #' + (i + 1) + ' has an unreadable date.');
      updates.push({ text: text, by: by, at: at || new Date().toISOString() });
    });
    updates.sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); });
    return { problems: problems, content: {
      name: name, domain: str(r.domain, 80), stage: stage, summary: str(r.summary, 4000), whyRaised: str(r.whyRaised, 4000),
      broughtBy: str(r.broughtBy, 200), dateLogged: dateLogged, potentialSolutions: solutions, stakeholderTypes: types, organizations: orgs, updates: updates
    } };
  }
  function potentialSlug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'initiative';
  }
  function typeKeySet() { return new Set(Object.keys(typeNames)); }

  /* ---------- facilitator management (admin key only; used by the admin panel) ---------- */

  async function facilitatorsGet() {
    if (!hasKey()) return { ok: false, reason: 'NO_KEY' };
    if (!RELAY_URL) return { ok: false, reason: 'NO_RELAY' };
    try {
      var res = await relay('/facilitators');
      var body = null; try { body = await res.json(); } catch (e) {}
      if (res.status === 401) return { ok: false, reason: (body && body.error === 'KEY_EXPIRED') ? 'KEY_EXPIRED' : 'KEY_BAD' };
      if (res.status === 403) return { ok: false, reason: (body && body.error === 'ADMIN_ONLY') ? 'ADMIN_ONLY' : 'ORIGIN' };
      if (!res.ok) return { ok: false, reason: 'RELAY' };
      return { ok: true, sha: body.sha, admin: body.admin, facilitators: body.facilitators };
    } catch (e) { return { ok: false, reason: 'NETWORK' }; }
  }

  /* list: [{name, hash, expires?}] — hashes from sha256Hex below. sha: from facilitatorsGet. */
  async function facilitatorsPut(list, sha) {
    if (!hasKey()) return { ok: false, reason: 'NO_KEY' };
    if (!RELAY_URL) return { ok: false, reason: 'NO_RELAY' };
    try {
      var res = await relay('/facilitators', { method: 'PUT', body: { facilitators: list, sha: sha || null } });
      var body = null; try { body = await res.json(); } catch (e) {}
      if (res.status === 401) return { ok: false, reason: 'KEY_BAD' };
      if (res.status === 403) return { ok: false, reason: (body && body.error === 'ADMIN_ONLY') ? 'ADMIN_ONLY' : 'ORIGIN' };
      if (res.status === 409) return { ok: false, reason: 'CONFLICT' };
      if (res.status === 400) return { ok: false, reason: 'REJECTED', detail: body };
      if (!res.ok) return { ok: false, reason: 'RELAY' };
      return { ok: true, sha: body.sha };
    } catch (e) { return { ok: false, reason: 'NETWORK' }; }
  }

  /* Same generator and hash as _dev/aws/key-helper.html, so the panel can mint keys. */
  function generatePasscode() {
    var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var bytes = new Uint8Array(20); crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) { out += ALPHABET[bytes[i] % ALPHABET.length]; if ((i + 1) % 5 === 0 && i < bytes.length - 1) out += '-'; }
    return out;
  }
  async function sha256Hex(text) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  window.MismoStore = {
    facilitators: { get: facilitatorsGet, put: facilitatorsPut, generatePasscode: generatePasscode, sha256Hex: sha256Hex },
    config: { get: configGet, put: configPut },
    potential: { list: potentialList, get: potentialGet, put: potentialPut, validate: potentialValidate, slug: potentialSlug,
                 STAGES: POT.STAGES, ENGAGEMENTS: POT.ENGAGEMENTS,
                 stageLabel: function (k) { return potLabel(POT.STAGES, k); }, engagementLabel: function (k) { return potLabel(POT.ENGAGEMENTS, k); } },
    typeKeys: typeKeySet,
    types: { load: typesLoad },
    typeName: typeName,
    getKey: getKey,
    setKey: setKey,
    configure: function (opts) {
      cfg.id = opts.id;
      cfg.path = 'data/' + opts.id + '.json';
    },
    load: load,
    save: save,
    explain: explain,
    hasKey: hasKey,
    keyName: keyName,
    promptForKey: promptForKey,
    sanitizeHtml: sanitizeHtml,
    // Older names, kept so the four dashboards and the template need no edits for this.
    hasToken: hasKey,
    promptForToken: promptForKey,
    dataPath: function () { return cfg.path; }
  };
})();
