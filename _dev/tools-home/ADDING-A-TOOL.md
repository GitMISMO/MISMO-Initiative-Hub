# Adding a tool to tools.mismo.org

Everything under `tools.mismo.org` is a separate GitHub repository in the
**GitMISMO** organization, published with GitHub Pages. The path is the
repository name: a repo called `press-release` is served at
`tools.mismo.org/press-release/`.

There are two kinds of tool. Read the first section either way; only read the
second if your tool needs to save.

---

## A. A tool that only displays things

No AWS. No tickets. No one else has to do anything.

1. Create a repository in the **GitMISMO** organization. It must be **public** —
   a privately published Pages site does not get the shared domain.
   Name it in lowercase with hyphens, because the name becomes the URL and
   renaming it later breaks every link anyone has saved.
2. Commit your files. `index.html` at the repo root is what loads.
3. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/`.
4. Wait a minute. It is live at `tools.mismo.org/<repo-name>/`.

Then tell whoever maintains the home page to add you to the tree — see section C.

---

## B. A tool that needs to save

Saving goes through the **relay**, a single AWS Lambda shared by every MISMO
tool. The point of it is that the relay holds the one GitHub token and nobody
else does. **You will never be given a GitHub token, and you must never put one
in a page.** If a design seems to need one, the design is wrong; ask.

Every save is a real commit to your repository, so you get history, attribution
and rollback for free.

### B.1 What you do

1. Everything in section A.
2. Add `facilitators.json` to the root of your repo. This is the list of people
   allowed to save, and it holds **hashes**, never passcodes:

   ```json
   {
     "admin":        { "name": "Your Name", "hash": "<sha-256 of the passcode>" },
     "jane-smith":   { "name": "Jane Smith", "hash": "...", "expires": "2027-01-01" }
   }
   ```

   Generate passcodes with `key-helper.html` in the Initiative Hub repo. It runs
   entirely in your browser and shows each passcode once. Put it in a password
   manager at that moment; it cannot be recovered, only reset.
3. Copy `relay-save.js` (next to this file) into your project and set `PROJECT`
   to your project key. It is about 60 lines and handles the key prompt, the
   save call, and conflict detection.

### B.2 What has to happen once, by someone with access

Two edits, both small. Ask early — the AWS one may need IT.

| Where | What | Why |
|---|---|---|
| GitHub → the fine-grained token's settings | add your repo to its repository list | the token only reaches repos it was granted |
| AWS → Lambda `mismo-save-relay` → Configuration → Environment variables | add one entry to `PROJECTS` | maps your project key to your repo |

The `PROJECTS` entry looks like this:

```json
"press-release": {
  "repo": "GitMISMO/press-release",
  "branch": "main",
  "origin": "https://tools.mismo.org"
}
```

`origin` is the same for every tool now that everything shares a host, so it is
always exactly that. No new Lambda, no new function, no code change to the
relay.

### B.3 The save call

`POST /{project}/commit` writes any set of files in one atomic commit.

```js
await relaySave({
  files: [{ path: 'data/releases/q4.json', content: JSON.stringify(doc, null, 2) }],
  message: 'Update Q4 release',
  parentSha: loadedSha          // the commit you read. See below.
});
```

**`parentSha` is not optional in spirit.** Pass the SHA of the commit your page
actually read. If someone else saved in the meantime, the relay returns `409`
and refuses to write, instead of silently discarding their work. Leave it out
and you will overwrite colleagues without either of you noticing.

Limits: 50 files per commit, no path may start with `/` or contain `..`.

---

## C. Adding yourself to the home page

The home page at `tools.mismo.org` renders from a single `APPS` array at the top
of its `index.html`. Add one object:

```js
{
  name: 'Press Releases',
  base: '/press-release',
  color: 'var(--violet)',
  desc: 'Draft, review and publish MISMO press releases.',
  groups: [
    { label: 'Published', leaves: [
        { name:'Release archive', sub:'Everything published to date', href:'/', badge:'REL', tone:'app' } ] },
    { label: 'Facilitator tools', leaves: [
        { name:'Drafting console', sub:'Write and review a release', href:'/console.html', badge:'DRF', tag:'gated' } ] }
  ]
}
```

Set `state: 'planned'` on a leaf to show it dimmed and unclickable before it
exists, so the tree can show direction without shipping dead links.

---

## D. Two rules that are not optional

Every tool shares one web address, and browsers decide what is "the same site"
by host name alone — the folder after the slash does not count. So every tool on
`tools.mismo.org` shares one localStorage, one IndexedDB and one cookie jar.

**1. Namespace every browser-storage key as `tools:<your-app>:<name>`.**

```js
localStorage.setItem('tools:press-release:draft', json);   // yes
localStorage.setItem('draft', json);                       // no — collides
```

Give an IndexedDB database the same treatment: name it after your app.

**2. Never call `localStorage.clear()`.** It does not clear *your* storage. It
clears everyone's, including a colleague's unsaved glossary draft — that is
megabytes of real work, gone, from a line of code that looked like housekeeping.
Remove your own keys by name.

And the thing those rules cannot fix: on a shared host, your code can read every
other tool's stored data, and theirs can read yours. That is how browsers work
and no amount of naming changes it. So nothing genuinely secret goes in browser
storage in any tool. Facilitator passcodes are deliberately low-value and
save-only for exactly this reason — the worst case if one leaks is an unwanted
commit, which is visible in history and revertible.
