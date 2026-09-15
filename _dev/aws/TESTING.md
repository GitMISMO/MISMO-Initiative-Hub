# Tests to run

Two kinds. The automated suite proves the relay's logic; the manual checklist proves the
whole path works in a real browser against real GitHub, which is the part that has caught
every serious bug on this project so far.

---

## Automated — run before any push that touches the relay

```
cd _dev/aws && node test-relay.mjs
```

58 cases, GitHub mocked. Everything must pass. The suite covers:

- **Cross-project isolation** — a Glossary key refused on the Hub and the reverse, each
  project's origin refused on the other, and a Glossary request proven to touch only the
  Glossary repository. These matter most: a shared relay's one real risk is a routing
  mistake crossing projects. This group already caught a live leak, where the facilitator
  cache was global rather than per repository.
- Key authentication: wrong passcode, mismatched name, expired entry, unknown project.
- The conflict lock on every write path, including stale `parentSha` on a Git Data commit.
- Validation: unknown stakeholder types, bad stages, path traversal, malformed hashes.
- Admin routes refusing facilitator keys, and admin writes never dropping the admin entry.

Also run, from the repository root:

```
python3 _dev/check-types.py                      # stakeholder list matches the dashboards
python3 _dev/validate_nesting.py *.html          # no broken markup
node --check dashboard-data.js _dev/aws/index.mjs
```

---

## Phase 1 manual checklist — after the Lambda is live

Do these in order. Each one fails differently, and 6 is the one that cannot be checked any
other way.

### 1. A visitor sees the site and cannot save

Open a dashboard in a private window. The content loads. Click Save — it should ask for a
facilitator key, not save silently.

*Proves: reads need no credential, writes do.*

### 2. Your admin key works

Open `admin.html`, sign in with your name and passcode. The facilitator list appears.

*If it refuses:* the name must match `facilitators.json` exactly, including case.

### 3. A facilitator key saves, and the commit says who

Add a facilitator in the admin panel, copy the passcode, sign in as them in a private
window, change something on a dashboard, Save. Then look at the repository's commit
history.

*Expect:* a commit like `Update MCD dashboard data (saved by Jane Facilitator)`, authored
by Jane, not by you and not by the token's owner.

*Proves: attribution survives a shared token — the thing that is usually lost.*

### 4. Everyone sees the save

Reload the dashboard in a different browser with no key at all. The change is there.

*Proves: saving is shared, not per-browser. This is the entire point; the old
`window.storage` path passed every other test and failed this one.*

### 5. Revoking someone takes effect

Remove that facilitator in the admin panel. Wait a minute. Have them try to save again.

*Expect:* refused, within thirty seconds at most (the relay's cache window).

### 6. Two people cannot overwrite each other — **do not skip**

Open the same dashboard in two browsers, both signed in. Make a different change in each.
Save in the first — it succeeds. Now save in the second.

*Expect:* the second is **refused** with "Someone else saved while you were editing."

*If it succeeds instead, stop and report it.* That means the conflict lock is not working
and silent data loss is possible. A version of this bug shipped once already: the code
fetched a fresh SHA immediately before writing, so every write matched and the lock could
never fire. It passed every other test. This is the only check that catches it.

**After the refusal:** reload, and if offered your draft, **do not restore it** — restoring
reapplies your version over theirs. Redo your edits by hand. (This is a known rough edge.)

### 7. A bad key fails clearly

Sign in with a wrong passcode. You should get a plain message about the key not being
recognised, not a blank page or a spinner.

---

## Phase 3 manual checklist — after the Glossary moves

The Glossary's own guards are the fragile part; the relay does not replace them. Re-run
whatever you already do for a release, plus:

### 8. A large save still works

The working copy is ~2.9 MB, over the simple API's 1 MB limit, which is why the Glossary
uses the Git Data path. Make an edit and let the hourly autosave fire, or save manually.

*Expect:* a commit containing both the data file and the draft file — one commit, not two.

*Proves: the multi-file atomic path works. If only one file lands, the content and its
metadata can disagree, which is what that path exists to prevent.*

### 9. The staged → draft → published states still behave

Stage a batch of edits, apply them to the draft, then publish. Confirm each step still does
what it did before the move. **Nothing about this should have changed** — if it has,
something was altered that should not have been.

### 10. The stale-browser guard still refuses

On a second machine that has never loaded since the last save, connect and let autosave try.

*Expect:* it refuses, because that browser is behind.

*This is `saving-pattern.md` §5 and the relay cannot see it* — the relay only knows whether
the branch moved, not whether your browser is holding a stale copy. Both guards are needed.

### 11. Attribution comes from the key

Check a commit message from the Glossary. It should end with `[Your Name]` taken from the
facilitator key, without anyone typing it.

---

## If a test fails

Note which number, what you expected, and what happened. Tests 4, 6 and 10 are the ones
where a failure means possible data loss — stop and report those rather than working
around them.
