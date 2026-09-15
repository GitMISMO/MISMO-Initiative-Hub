# Save relay — AWS setup

One Lambda function. It holds the single GitHub token, accepts saves from people who
present a valid key, and commits them. Nothing is stored in AWS; the repository is the
data store.

Two jobs, two owners:

- **AWS side** (steps 2–4): create the Lambda and set four environment variables. Done
  once, by whoever owns the AWS account. Nothing here changes afterwards except the
  GitHub token when it expires.
- **Keys** (step 5): who can save. Managed in `facilitators.json` in this repository by
  the admin, with no AWS access needed. Later, the admin panel edits that file for you.

## 1. Create the GitHub token the relay will use

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained.

- Resource owner: **PWCodingLLC**
- Repository access: **Only select repositories** → `MISMO-Initiative-Hub`
- Permissions → Repository → **Contents: Read and write**. Nothing else.
- Expiration: your call. When it expires, saving stops with a clear message
  ("The save relay could not reach GitHub — its token was rejected") until you
  replace it in step 3. Set a calendar reminder for a week before.

Copy it once. It goes into the Lambda in step 3 and nowhere else — not into a
document, not into a chat.

## 2. Create the Lambda

AWS Console → Lambda → Create function.

- Author from scratch
- Name: `mismo-hub-save-relay` (anything works)
- Runtime: **Node.js 22.x** (20.x also fine)
- Architecture: arm64 (cheaper; either works)
- Permissions: leave the default new role. The function calls no AWS services.

After it's created, in the **Code** tab, replace the contents of `index.mjs` with
`_dev/aws/index.mjs` from this repository, then **Deploy**.

## 3. Environment variables

Configuration → Environment variables → Edit. Add these four:

| Key | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 1 |
| `GITHUB_REPO` | `PWCodingLLC/MISMO-Initiative-Hub` (or the org's path after the move) |
| `GITHUB_BRANCH` | `main` |
| `ALLOWED_ORIGIN` | `https://pwcodingllc.github.io` — exactly, no trailing slash |

That's everything AWS needs. Facilitators are **not** configured here — see step 5.

**To rotate the GitHub token:** replace `GITHUB_TOKEN` and save. Takes effect on the
next request; no redeploy.

AWS stores environment variables encrypted at rest with a KMS key by default. That's
sufficient here.

## 4. Function URL

Configuration → Function URL → Create function URL.

- Auth type: **NONE**. The function does its own authentication with the facilitator
  key. AWS's IAM auth would require facilitators to have AWS credentials, which is the
  problem we're avoiding.
- **CORS: leave it off.** The function sends CORS headers itself. Turning this on as
  well sends duplicate headers and the browser refuses every response. This is the
  one setting people reach for reflexively; don't.

Copy the URL. It looks like `https://abc123xyz.lambda-url.us-east-1.on.aws`.

## 5. Keys — who can save

Keys live in `facilitators.json` at the repository root. It holds one **admin** (you)
and any number of **facilitators**, each as a display name and the SHA-256 hash of a
generated passcode. The file is public, which is why it holds hashes, and why passcodes
must be generated rather than chosen.

Open **https://pwcodingllc.github.io/MISMO-Initiative-Hub/key-helper.html** (the
published site; it makes no network requests and nothing you generate leaves the
page). Do not use GitHub's "raw" view — that shows the source as text rather than
running it. For each person:

1. Type their display name. It becomes the git author on their saves, so use a real one.
2. Pick the role. Make **yourself** the admin first; there is exactly one.
3. Click Generate. Copy the passcode and give it to the person **once**. It cannot be
   looked up later — if lost, generate a new one and replace their hash.
4. Copy the snippet and paste it into `facilitators.json` on GitHub (edit the file in the
   web UI, commit). The admin snippet replaces the `"admin": null` line; a facilitator
   snippet goes in the `facilitators` array.

Keep your **own** admin passcode in a password manager. Facilitators' passcodes can be
regenerated later from the admin panel; yours can only be reset by editing the file.

**To revoke a facilitator:** remove their entry, commit. Their next save is refused,
within thirty seconds at most.

**To make a key lapse on a date:** add `"expires": "2027-01-01"` to their entry.

After your admin entry is in the file, use **`admin.html`** on the site for everything
else: it adds facilitators (generating and showing their passcode once), resets
passcodes, removes people, sets expiries, and manages the global stakeholder-type list.
You only open `facilitators.json` by hand to create or rotate your own admin entry.

## 6. Point the dashboards at the relay

In `dashboard-data.js` at the repository root, set:

```js
var RELAY_URL = 'https://abc123xyz.lambda-url.us-east-1.on.aws';
```

No trailing slash. Commit and push. That's the only code change; the URL is not a
secret, so committing it is fine.

## 7. Check it works

1. Open any dashboard, make an edit, click Save. You'll be asked for your display
   name and passcode — exactly as in `facilitators.json`.
2. The button should read "Saved". The repository gets a commit
   `Update MCD dashboard data (saved by Jane Facilitator)` with Jane as the author.
3. Reload in a private window: the edit is there, because everyone reads the
   committed file.
4. Two browsers, same dashboard: save in one, then save in the other. The second
   must refuse with "Someone else saved while you were editing." If it doesn't, the
   lock is broken and that's a bug to report.

## What each person can do

| | Read dashboards | Save | Manage facilitators | See a GitHub token |
|---|---|---|---|---|
| Anyone with the URL | yes | no | no | no |
| Facilitator with a key | yes | yes, as themselves | no | no |
| Admin (you) | yes | yes | yes, in GitHub or the panel | no |
| AWS account owner (IT) | yes | no | no | only them, only in AWS |

## If something goes wrong

The Save button explains failures in plain words. The ones that mean *you* need to
act (rather than the facilitator):

- "its token was rejected" — `GITHUB_TOKEN` expired or was revoked. IT replaces it.
- "facilitators.json could not be read" — the file is missing or not valid JSON.
  Check it on GitHub; a stray comma is the usual cause.
- "Your facilitator key has expired" — that person's entry has a past `expires`.
  Remove the date or regenerate.
- "the site owner still needs to set the relay address" — `RELAY_URL` is empty in
  `dashboard-data.js`. Step 5.
- Browser console shows a CORS error — CORS got turned on at the function URL.
  Step 4.

CloudWatch Logs under the function will show every invocation if you need more.

## Cost

Free tier is 1,000,000 requests and 400,000 GB-seconds a month. Five facilitators
saving a few times a day is a few hundred requests a month. Effectively zero.
