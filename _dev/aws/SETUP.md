# Save relay — AWS setup

One Lambda function. It holds the single GitHub token, accepts saves from facilitators
who present a valid key, and commits them. Nothing is stored in AWS; the repository is
the data store. Total setup is about ten minutes.

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

Configuration → Environment variables → Edit. Add these five:

| Key | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 1 |
| `GITHUB_REPO` | `PWCodingLLC/MISMO-Initiative-Hub` |
| `GITHUB_BRANCH` | `main` |
| `ALLOWED_ORIGIN` | `https://pwcodingllc.github.io` — exactly, no trailing slash |
| `FACILITATOR_KEYS` | see below |

`FACILITATOR_KEYS` is one facilitator per line, `Display Name=passcode`:

```
Jane Facilitator=k7Qm-2vXp-9Lrt
Sam Facilitator=b3Wn-8Ycd-4Hjs
```

The display name becomes the git author of that person's saves, so use real names.
Passcodes should be long and random; a password manager's generator is fine. Give
each person their own line and their own passcode — never share one.

**To revoke a facilitator:** delete their line and save. Takes effect on their next
save; no redeploy needed.

**To rotate the GitHub token:** replace `GITHUB_TOKEN` and save. Same.

AWS lets you store environment variables encrypted at rest with a KMS key; on by
default for the console-managed key. That's sufficient here.

## 4. Function URL

Configuration → Function URL → Create function URL.

- Auth type: **NONE**. The function does its own authentication with the facilitator
  key. AWS's IAM auth would require facilitators to have AWS credentials, which is the
  problem we're avoiding.
- **CORS: leave it off.** The function sends CORS headers itself. Turning this on as
  well sends duplicate headers and the browser refuses every response. This is the
  one setting people reach for reflexively; don't.

Copy the URL. It looks like `https://abc123xyz.lambda-url.us-east-1.on.aws`.

## 5. Point the dashboards at it

In `dashboard-data.js` at the repository root, set:

```js
var RELAY_URL = 'https://abc123xyz.lambda-url.us-east-1.on.aws';
```

No trailing slash. Commit and push. That's the only code change; the URL is not a
secret, so committing it is fine.

## 6. Check it works

1. Open any dashboard, make an edit, click Save. You'll be asked for your display
   name and passcode — exactly as written in `FACILITATOR_KEYS`.
2. The button should read "Saved". The repository gets a commit
   `Update MCD dashboard data (saved by Jane Facilitator)` with Jane as the author.
3. Reload in a private window: the edit is there, because everyone reads the
   committed file.
4. Two browsers, same dashboard: save in one, then save in the other. The second
   must refuse with "Someone else saved while you were editing." If it doesn't, the
   lock is broken and that's a bug to report.

## What each person can do

| | Read dashboards | Save | See a GitHub token |
|---|---|---|---|
| Anyone with the URL | yes | no | no |
| Facilitator with a key | yes | yes, as themselves | no |
| You (repo owner) | yes | yes | only you, only in AWS |

## If something goes wrong

The Save button explains failures in plain words. The ones that mean *you* need to
act (rather than the facilitator):

- "its token was rejected" — `GITHUB_TOKEN` expired or was revoked. Replace it.
- "the site owner still needs to set the relay address" — `RELAY_URL` is empty in
  `dashboard-data.js`. Step 5.
- Browser console shows a CORS error — CORS got turned on at the function URL.
  Step 4.

CloudWatch Logs under the function will show every invocation if you need more.

## Cost

Free tier is 1,000,000 requests and 400,000 GB-seconds a month. Five facilitators
saving a few times a day is a few hundred requests a month. Effectively zero.
