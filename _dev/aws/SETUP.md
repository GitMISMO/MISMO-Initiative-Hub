# Save relay — setup for both projects

One AWS Lambda serves **both** the Initiative Hub and the Business Glossary. It holds the
single GitHub token, and nobody editing either site ever handles one.

Read this in order. The sequence matters: the Hub goes first and is proven in production
before the Glossary moves, so that if something is wrong you are debugging one new
component against one known-good site, not two changes at once.

---

## Why one Lambda and not two

An earlier draft of this plan used a separate function per project, on the grounds that it
isolated the GitHub token. Within a single AWS account that is mostly false — anyone who
can read one function's environment variables can read the other's — so it bought
complexity for isolation that did not exist. One function, one token to rotate, one setup.

What a shared relay genuinely does risk is a routing mistake letting a request for one
project write to the other's repository. The design prevents it by making **one lookup**
resolve repository, branch, allowed origin and facilitator list together, from the project
key in the URL. Nothing downstream may take a repository from anywhere else.

That is also where the test suite is heaviest, and it earned its keep: it caught a real
cross-project leak during development, where the facilitator-list cache was global rather
than per repository, so a cached list from one project could authenticate a request for
the other. See `test-relay.mjs`.

---

## Phase 1 — Stand up the relay for the Hub

### 1.1 Create the GitHub token

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained.

- Resource owner: **GitMISMO** (the organisation, not a personal account — a token owned
  by an individual cannot see these repositories)
- Repository access: **Only select repositories** → select **all three**:
  `initiative-hub`, `glossary`, **and** `GitMISMO.github.io`

  The third one is easy to miss and the failure is confusing if it is. The relay reads
  `projects.json` from `GitMISMO.github.io` on every cold start. A fine-grained token
  cannot read a repository it was not granted — not even a public one; GitHub returns
  401 — so without it every request fails with `503 CONFIG_UNAVAILABLE` and nothing
  saves. It will look like the Lambda is broken. It is not; the token is short a repo.
- Permissions → Repository → **Contents: Read and write**. Nothing else.
- Expiration: your call. When it lapses, saving stops with a clear message until it is
  replaced. Put a reminder in the calendar a week before.

Selecting all three now means the Glossary needs no token work in Phase 3.

If the organisation requires owner approval for tokens, the token will exist but fail
until an owner approves it under Settings → Third-party Access → Personal access tokens.

### 1.2 Create the Lambda

AWS Console → Lambda → Create function.

- Author from scratch, name `mismo-save-relay`
- Runtime **Node.js 22.x** (20.x also fine), architecture arm64
- Default execution role. The function calls no AWS services.

In the **Code** tab, replace `index.mjs` with `_dev/aws/index.mjs` from the Hub
repository, then **Deploy**.

### 1.3 Environment variables

Configuration → Environment variables:

| Key | Value |
|---|---|
| `GITHUB_TOKEN` | the token from 1.1 |
| `PROJECTS_REPO` | `GitMISMO/GitMISMO.github.io` |
| `PROJECTS_BRANCH` | `main` *(optional, defaults to `main`)* |
| `PROJECTS_PATH` | `projects.json` *(optional, defaults to `projects.json`)* |

The list of projects lives in **`projects.json` in that repository**, not in AWS:

```json
{
  "hub":      {"repo":"GitMISMO/initiative-hub",   "branch":"main", "origin":"https://resources.mismo.org"},
  "glossary": {"repo":"GitMISMO/glossary","branch":"main", "origin":"https://resources.mismo.org"}
}
```

Adding a tool is then a commit to that file — reviewable, attributable, revertible, and
possible without anyone having AWS access. A new entry is live within a minute.

`origin` is the exact site address with no trailing slash, and it is the same for every
tool now that they all share a host.

**This does not widen who can write where.** The relay's token only reaches repositories
it was explicitly granted, and that grant is in GitHub under org-admin control. An entry
naming a repo the token cannot reach is refused; an entry naming a different owner is
refused before any request is made. The file decides which repos the relay *knows about*,
the token decides which it can *touch*, and the token is the one that matters.

Protect the config repo accordingly: give write access to a small named group, and turn on
a branch ruleset requiring a pull request before merging to `main`.

### Alternative: keep the list in AWS

If you would rather not have the list in git, leave `PROJECTS_REPO` unset and provide
`PROJECTS` instead, holding the same JSON on one line. Exactly one source is authoritative:
if `PROJECTS_REPO` is set, `PROJECTS` is ignored entirely. There is deliberately no
fallback between them — if the file cannot be read the relay returns `503` and writes
nothing, rather than using a stale copy that might name a repository since repointed.

To rotate the token later, replace `GITHUB_TOKEN`. Takes effect on the next request.

### 1.4 Function URL

Configuration → Function URL → Create.

- Auth type **NONE** — the function authenticates people itself with facilitator keys.
  AWS IAM auth would require every facilitator to have AWS credentials, which is the
  problem being avoided.
- **CORS: leave it OFF.** The function sends its own CORS headers. Enabling AWS's as well
  sends duplicates and the browser rejects every response. This is the setting people
  reach for by reflex; don't.

Copy the URL: `https://….lambda-url.us-east-1.on.aws`

### 1.5 Point the Hub at it

In `dashboard-data.js` at the Hub repository root:

```js
var RELAY_URL = 'https://….lambda-url.us-east-1.on.aws';   // no trailing slash
var PROJECT   = 'hub';                                      // already set
```

Commit and push. The URL is not a secret.

### 1.6 Create your admin key

Open **https://gitmismo.github.io/initiative-hub/key-helper.html**. It runs entirely
in your browser and makes no network requests.

Enter your name, choose **Admin**, click Generate. Put the passcode in a password manager —
facilitators' passcodes can be regenerated from the admin panel, yours can only be reset by
editing the file. Paste the snippet into `facilitators.json` in place of `"admin": null`
and commit.

Then use `admin.html` on the site to add everyone else.

### 1.7 Test it

Run the Phase 1 checklist in `TESTING.md`. Do not skip test 6 — it is the one that proves
two people cannot silently overwrite each other.

---

## Phase 2 — Run on it

Use the Hub normally for a week or two. Facilitators save dashboards, you manage people in
the admin panel. What you are looking for is anything that only shows up with real use:
tokens expiring, a key that stops working, a save that fails at an awkward moment.

Do not start Phase 3 until saving has been boring for a while.

---

## Phase 3 — Move the Glossary onto the relay

The Glossary's console works today by having the facilitator paste a GitHub token into it.
Phase 3 replaces that with a facilitator key, so the token lives only on the relay.

**What does not change:** the staged → draft → published model, the diff format, the
IndexedDB working copy, the stale-browser guards, the hourly autosave. All of that is
specific to how the Glossary is edited and stays exactly as it is. This phase changes
*where the write goes*, not how editing works.

### 3.1 Add the Glossary's facilitators file

`facilitators.json` at the **Glossary** repository root, same shape as the Hub's, its own
people. Generate entries with the same `key-helper.html`. Keys are per project: a Glossary
key cannot save a Hub dashboard and the reverse, which is enforced by the relay and tested.

### 3.2 Repoint the console's write path

The console currently calls `api.github.com` directly with `ghCommit()` (blobs → tree →
commit → ref). The relay exposes exactly that shape at `POST /glossary/commit`:

```js
// body
{ files: [ {path: 'data/glossary.json', content: '…'}, {path: '.console/draft.json', content: '…'} ],
  message: 'Save working draft (0 added, 27 edited, 0 removed) — hourly save',
  parentSha: '<the commit this browser last read>' }
```

The relay appends `[Name]` to the message from the facilitator key, so the manual
editor-name field can go — attribution now comes from the key rather than being typed.

`parentSha` is how the non-forced ref update survives: send the commit you read, and if the
branch moved you get a `409 CONFLICT` instead of overwriting someone. This replaces the
token, not the guards — **keep every check in `docs/saving-pattern.md` §5 exactly as it
is.** The relay protects the repository; those guards protect against a stale browser,
which is a different failure that the relay cannot see.

### 3.3 Remove the token UI

Once saving works through the relay, the access-token field in the console's connect dialog
comes out and is replaced by name + passcode. Do this last, so there is a way back.

---

## Who can do what

| | Read either site | Save | Manage people | See a GitHub token |
|---|---|---|---|---|
| Anyone with the URL | yes | no | no | no |
| Facilitator with a key | yes | their project only | no | no |
| Admin (you) | yes | yes | yes, in each repo | no |
| AWS account holder (IT) | yes | no | no | only them, only in AWS |

---

## When something breaks

The Save button explains failures in plain words. These mean **you** need to act, not the
facilitator:

- *"its token was rejected"* — `GITHUB_TOKEN` expired or was revoked. Replace it (1.3).
- *"the site owner still needs to set the relay address"* — `RELAY_URL` is empty (1.5).
- *"facilitators.json could not be read"* — the file is missing or not valid JSON in that
  project's repository. A stray comma is the usual cause.
- A CORS error in the browser console — CORS got switched on at the function URL (1.4).
- `UNKNOWN_PROJECT` — the `PROJECT` value in the page does not match a key in the project
  list, or its entry is malformed or names a different owner.
- `CONFIG_UNAVAILABLE` (503) — the project list could not be read and nothing was cached.
  Nothing was written. It clears itself once GitHub responds again.

CloudWatch Logs under the function shows every invocation if you need more.

---

## Cost

Free tier is 1,000,000 requests a month. Both projects together are a few hundred.
Effectively zero.
