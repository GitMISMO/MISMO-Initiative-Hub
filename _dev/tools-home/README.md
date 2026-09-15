# Staged content for the org site (`tools.mismo.org`)

**None of this belongs in the Initiative Hub.** It lives here only so it is in version
control while the repository it actually belongs to is created. `_dev/` starts with an
underscore, so GitHub Pages does not publish it — nothing in this folder is reachable from
the Hub's public site.

## Where it is going

A repository named exactly **`GitMISMO.github.io`**. That name is not cosmetic: GitHub
treats a repo named `<org>.github.io` as the organization's own site, and a custom domain
set on it applies automatically to every other public Pages site in the org. That is what
makes `tools.mismo.org/<repo-name>/` work for every tool without further DNS work.

I could not create it — the token in use cannot create repositories, which is correct and
expected. An org owner has to make it in the GitHub UI.

## Moving it

1. Create `GitMISMO.github.io` in the **GitMISMO** organization. Public.
2. Copy `index.html`, `assets/`, `ADDING-A-TOOL.md`, `relay-save.js` and `projects.json`
   to its root. `index.html` becomes the site's home page.
3. Settings → Pages → Deploy from a branch, `main`, folder `/`.
4. Add the custom domain `tools.mismo.org`, then create a DNS CNAME pointing
   `tools.mismo.org` at `gitmismo.github.io` — without the repository name.
5. Delete this folder from the Hub.

## What is here

| File | What it is |
|---|---|
| `index.html` | The home page. Self-contained: fonts and both logos are embedded, so it makes no external requests. Edit the `APPS` array at the top to add a tool. |
| `assets/` | The two official wordmarks, colour and white, kept as files for future use even though `index.html` embeds them. |
| `ADDING-A-TOOL.md` | How someone adds a new tool to the domain, with and without saving. |
| `relay-save.js` | Drop-in saving module for a new tool that needs to write back to GitHub. |
| `projects.json` | The relay's project list, read from the org site repo rather than an AWS environment variable. Belongs at that repo's root. |

## Before this can go live

Two things are unresolved and both are decisions, not work:

**The paths do not match the repository names.** `index.html` links to `/initiative-hub/`
and `/glossary/`, but the repos are `MISMO-Initiative-Hub` and `mismo-business-glossary`,
and on GitHub Pages the path IS the repository name. Either rename the repos to match, or
change the two `base` values in `APPS`. Renaming is better done now than later: GitHub
redirects a renamed repository but does NOT redirect its Pages URL, so every saved link
breaks the day it happens.

**Contrast in light mode.** "Tools" is set in the logo's light blue, which measures 2.02:1
against the white masthead where the threshold for large text is 3:1. It is fine in dark
mode at 9.46:1. `#299CE0` is the same hue darkened just enough to clear it, if wanted.
