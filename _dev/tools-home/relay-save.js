/* ---------------------------------------------------------------------------
   relay-save.js — saving for a MISMO tool on tools.mismo.org

   Drop this in, set PROJECT and RELAY_URL, and call relaySave(). It handles the
   facilitator passcode, the commit, and the case where someone else saved while
   you were editing.

   WHY THERE IS NO GITHUB TOKEN IN HERE: a page's source is public and anything
   it holds can be read by anyone who opens it. The relay holds the one token
   server-side and checks a facilitator passcode instead. If you find yourself
   wanting to paste a token here, stop and ask.
   --------------------------------------------------------------------------- */

var PROJECT   = 'CHANGE-ME';      // your key in the relay's PROJECTS variable
var RELAY_URL = '';               // the Lambda function URL, no trailing slash
var KEY_KEY   = 'tools:' + PROJECT + ':facilitator-key';   // see rule D.1

/* The passcode lives in localStorage as "Display Name:passcode". It is
   deliberately low-value: the worst it can do is make a commit, which is
   visible in history and revertible. */
function getKey()  { try { return localStorage.getItem(KEY_KEY) || ''; } catch (e) { return ''; } }
function hasKey()  { return !!getKey(); }
function setKey(v) { try { localStorage.setItem(KEY_KEY, v); } catch (e) {} }
function clearKey(){ try { localStorage.removeItem(KEY_KEY); } catch (e) {} }
/* Note: removeItem, not clear(). clear() would wipe every other MISMO tool's
   storage too, including unsaved work in apps you have never heard of. */

function relayFetch(path, options) {
  if (!RELAY_URL) return Promise.reject(new Error('NO_RELAY'));
  var opts = options || {};
  opts.headers = Object.assign({ 'X-Facilitator-Key': getKey() }, opts.headers || {});
  return fetch(RELAY_URL + '/' + PROJECT + path, opts);
}

/* Read a file and, importantly, the commit it came from. Hold onto .sha and
   pass it back on save — that is what stops two people overwriting each other. */
async function relayRead(path) {
  var res = await relayFetch('/data/' + encodeURIComponent(path));
  if (res.status === 401) return { ok: false, reason: 'BAD_KEY' };
  if (!res.ok)            return { ok: false, reason: 'HTTP_' + res.status };
  var body = await res.json();
  return { ok: true, content: body.content, sha: body.sha };
}

/* Save one or more files as a single commit.
   files:     [{ path, content }]  — content is a string; JSON.stringify first
   message:   the commit message, shown in the repo's history
   parentSha: the commit you read. Omit it and you will silently overwrite
              whoever saved while you were typing. */
async function relaySave(opts) {
  if (!hasKey()) return { ok: false, reason: 'NO_KEY' };

  var res;
  try {
    res = await relayFetch('/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files:     opts.files,
        message:   opts.message || 'Update',
        parentSha: opts.parentSha || null
      })
    });
  } catch (e) {
    // Network failure. Keep a local draft so the work is not lost.
    return { ok: false, reason: 'OFFLINE' };
  }

  if (res.status === 401) { return { ok: false, reason: 'BAD_KEY' }; }
  if (res.status === 409) {
    // Someone else committed since you loaded. Their work is intact and yours
    // was NOT written. Reload, look at what changed, and reapply by hand.
    // Do not just retry without parentSha — that is the overwrite you avoided.
    var info = await res.json().catch(function(){ return {}; });
    return { ok: false, reason: 'CONFLICT', head: info.head };
  }
  if (!res.ok) return { ok: false, reason: 'HTTP_' + res.status };

  var out = await res.json();
  return { ok: true, sha: out.sha };   // keep as the parentSha for your next save
}

/* Minimal sign-in. Replace the prompts with real UI when you have it. */
async function ensureKey() {
  if (hasKey()) return true;
  var name = window.prompt('Your name, exactly as it appears in facilitators.json:');
  if (!name) return false;
  var code = window.prompt('Your facilitator passcode:');
  if (!code) return false;
  setKey(name + ':' + code);
  return true;
}
