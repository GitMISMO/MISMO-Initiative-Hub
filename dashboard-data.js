/* Shared dashboard storage — commits to this repository instead of the browser.
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
 * A public page cannot hold a write token — view-source defeats it. Each facilitator
 * supplies their own fine-grained PAT, kept in their own browser's localStorage and
 * never in this file. Without one the dashboard is readable but not saveable, which
 * is the correct default for a public URL.
 *
 * Attendance data is not saved here and must not be: participant chips, the meeting
 * leaderboard and facilitator hours are non-editable by design, and every derived
 * metric (the "N of M organizations" note, the status bars, the roadblock flag) is
 * recomputed at render time from the roster.
 */
(function () {
  'use strict';

  var REPO = 'PWCodingLLC/MISMO-Initiative-Hub';
  var BRANCH = 'main';
  var TOKEN_KEY = 'mismo-hub-github-token';

  var cfg = { id: null, path: null };
  var currentSha = null;       // blob SHA of the file as we last read it; drives conflict detection
  var loadedRemote = false;
  var fileExisted = false;     // distinguishes 'no file yet' (create) from 'file read, SHA unknown' (refuse)

  /* ---------- token ---------- */

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(v) {
    try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }
  function hasToken() { return !!getToken(); }

  /* ---------- reading ---------- */

  /* The SHA captured here is the SHA of the version this page READ. It is sent with the
   * write so GitHub can reject the save if anyone else committed in between. It must
   * never be refreshed at save time — fetching the current SHA just before writing makes
   * every write match and defeats the lock entirely, which is the bug this replaced. */

  function decodeBase64Utf8(b64) {
    var bin = atob(b64.replace(/\n/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

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

  /* Editors read through the API: always fresh (no Pages deploy lag, no CDN cache) and it
   * returns the SHA directly. Falls through to the plain read if the token is rejected, so
   * a bad token degrades to viewing rather than breaking the page. */
  async function loadViaApi() {
    var res = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + cfg.path + '?ref=' + BRANCH, {
      headers: { Authorization: 'Bearer ' + getToken(), Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var body = await res.json();
    return { data: JSON.parse(decodeBase64Utf8(body.content)), sha: body.sha };
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
      if (hasToken()) {
        try { result = await loadViaApi(); }
        catch (apiErr) { console.warn('API read failed, falling back to the deployed file:', apiErr); }
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

  function encodeContent(obj) {
    // btoa is byte-oriented; org names and notes contain non-ASCII, so encode as UTF-8 first.
    var json = JSON.stringify(obj, null, 2) + '\n';
    var bytes = new TextEncoder().encode(json);
    var bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  async function save(snapshot) {
    if (!hasToken()) return { ok: false, reason: 'NO_TOKEN' };
    if (!loadedRemote) return { ok: false, reason: 'NOT_LOADED' };
    // A file was read but no SHA could be computed for it — crypto.subtle is only available
    // on secure origins. Saving without the lock would be a blind overwrite, so refuse.
    if (fileExisted && !currentSha) return { ok: false, reason: 'NO_LOCK' };

    var payload = {
      dashboard: cfg.id,
      savedAt: new Date().toISOString(),
      rosterData: snapshot.rosterData,
      laneData: snapshot.laneData,
      generic: snapshot.generic
    };

    try {
      var res = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + cfg.path, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + getToken(),
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: 'Update ' + cfg.id.toUpperCase() + ' dashboard data',
          content: encodeContent(payload),
          branch: BRANCH,
          sha: currentSha || undefined
        })
      });

      if (res.status === 401) return { ok: false, reason: 'TOKEN_BAD' };
      if (res.status === 403) return { ok: false, reason: 'NO_WRITE' };
      // 409: the SHA we read is no longer current — someone committed since. 422 with no
      // SHA: we read a 404 and someone created the file since. Both mean the same thing:
      // overwriting now would erase their work silently, which is the failure this replaces.
      if (res.status === 409 || (res.status === 422 && !currentSha)) return { ok: false, reason: 'CONFLICT' };
      if (res.status === 422) return { ok: false, reason: 'REJECTED' };
      if (!res.ok) return { ok: false, reason: 'HTTP_' + res.status };

      var body = await res.json();
      currentSha = body.content && body.content.sha;   // this page now holds the newest version
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'NETWORK' };
    }
  }

  /* Written in the interface's voice: what happened, and what to do about it. */
  function explain(reason) {
    switch (reason) {
      case 'NO_TOKEN':   return 'Add a GitHub token to save. Your edits stay on this page until you do.';
      case 'TOKEN_BAD':  return 'That token was rejected. It may have expired or been revoked — add a new one.';
      case 'NO_WRITE':   return 'That token can read this repository but not write to it. It needs Contents: Read and write.';
      case 'CONFLICT':   return 'Someone else saved while you were editing. Reload to get their changes, then redo yours.';
      case 'REJECTED':   return 'GitHub rejected the save as malformed. Reload and try again; if it repeats, the data file may need repair.';
      case 'NO_LOCK':    return 'This page could not verify it has the latest version, so saving is blocked. Open the dashboard over https and try again.';
      case 'NOT_LOADED': return 'The saved data could not be read, so saving is blocked to avoid overwriting it. Reload and try again.';
      case 'NETWORK':    return 'Could not reach GitHub. Check your connection and try again.';
      default:           return 'Save failed. Your edits are still on this page.';
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

  /* ---------- token dialog ---------- */

  function promptForToken() {
    var existing = hasToken();
    var msg = existing
      ? 'Replace your GitHub token.\n\nLeave this blank and press OK to remove the stored token instead.'
      : 'Paste a GitHub personal access token to save changes.\n\n'
        + 'Fine-grained token, this repository only, Contents: Read and write.\n'
        + 'It is stored in this browser only and is never committed.';
    var v = window.prompt(msg, '');
    if (v === null) return false;                 // cancelled
    setToken(v.trim());
    return true;
  }

  window.MismoStore = {
    configure: function (opts) {
      cfg.id = opts.id;
      cfg.path = 'data/' + opts.id + '.json';
    },
    load: load,
    save: save,
    explain: explain,
    hasToken: hasToken,
    sanitizeHtml: sanitizeHtml,
    promptForToken: promptForToken,
    dataPath: function () { return cfg.path; }
  };
})();
