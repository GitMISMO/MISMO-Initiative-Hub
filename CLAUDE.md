# MISMO Initiative Hub — Project Context

This file exists so a new Claude Code session (or a fresh `opusplan` planning pass)
can pick this project up without re-deriving conventions that were already worked
out, sometimes the hard way, across many earlier sessions in Claude.ai.

## What this is

A set of static HTML dashboards tracking MISMO workgroup initiatives — built,
tested, and deployed entirely through hand-written HTML/CSS/vanilla JS (no
build step, no framework, no server). The repository itself is the data store:
edits are committed to `data/<id>.json` through the GitHub contents API. See
**Saving** below.

- **Live site:** https://gitmismo.github.io/initiative-hub/
- **Repo:** https://github.com/GitMISMO/initiative-hub
- Moved from the personal `PWCodingLLC` account to the `GitMISMO` organization in
  Sept 2026. Full history came across intact. Any link to the old
  `pwcodingllc.github.io` address is dead — GitHub redirects the repo but not Pages.
- **Hosting:** GitHub Pages, served directly from the `main` branch

## File structure

| File | What it is |
|---|---|
| `index.html` | The hub homepage — domain tiles, tabs, links out to each dashboard |
| `mcd-dashboard.html`, `lbds-dashboard.html`, `ccs-dashboard.html`, `tpa-dashboard.html` | The four live, real workgroup dashboards |
| `calendar.html` | Meeting calendar with a workgroup filter dropdown |
| `dashboard-data.js` | Shared git-backed storage used by every dashboard: reads the committed data file, sends saves to the relay, holds the conflict lock, sanitises shared HTML. Read its header comment before touching persistence. |
| `potential.html` | One page that renders ANY potential initiative from `data/potential/<id>.json` (`?id=`). Approved section order: stage rail, Overview (facts card sized to its own content, not stretched; potential solutions folded in as a "What it could produce" subsection, no separate card), Status Updates (timeline), Potential Leadership (flat list — everyone interested, role as a tag, no seat structure, collapsed behind a "+ Add" link when empty), Stakeholder Engagement. Week-to-week edits happen here with the same Save/lock as the dashboards. |
| `potential-edit.html` | The wizard. Create: drop a JSON file in the initiative format (or start blank), review every field, Save. Edit (`?id=`): same form, prefilled. Validation mirrors the relay's; Download JSON returns the draft for another pass in chat. |
| `data/potential/index.json`, `data/potential/<id>.json` | The records and the list the hub reads (static hosting can't list a directory). The relay appends to the index on create. |
| `_dev/potential-example.json` | Format reference with obviously invented values. Not data. |
| `admin.html` | The admin panel: facilitators (add / reset passcode / remove / expiry) and the global stakeholder-type list (rename / add / remove-if-unused). Admin key only. Saves through the relay. |
| `facilitators.json` | Who can save: one admin, N facilitators, as name + SHA-256 of a generated passcode. Public; hashes only. Edited by the admin panel (or by hand on GitHub). |
| `stakeholder-types.json` | The global stakeholder-type list: `types` = `{key, name}` (key immutable, name is what people see) and `usage` = which dashboards use which keys. Every dashboard reads it at boot for display names. `usage` is maintained by `_dev/check-types.py`, never by the panel. |
| `_dev/check-types.py` | Verifies `stakeholder-types.json` matches each dashboard's `ROSTER_TYPE_TO_LANE`; `--write` rebuilds `usage`. Run after any type change in a dashboard and before pushing. |
| `_dev/aws/index.mjs`, `_dev/aws/SETUP.md`, `_dev/aws/TESTING.md`, `_dev/aws/test-relay.mjs`, `key-helper.html` | The shared save relay (Lambda), the phased setup for both projects, the manual test checklist, 58 automated cases, and the offline passcode generator. |
| `data/<id>.json` | One committed data file per dashboard, created by the first save. Absent until then; a missing file means "use the built-in defaults". |
| `_dev/dashboard-template.html` | Starting point for building a **new** dashboard — see below |
| `_dev/validate_nesting.py` | HTML nesting validator used before every deploy |

There is no build/deploy directory distinction in the repo itself, but during
development a `gh-deploy/` copy is kept in sync with `template-work/` before
each push — see **Deployment workflow** below.

**Why `_dev/`:** this repo has no `.nojekyll` file, so GitHub Pages runs Jekyll,
which excludes underscore-prefixed directories from the published site. Dev-only
files live there so they stay version-controlled and available to you, without
being served at the public URL — an unfilled template rendering a page full of
`{{WORKGROUP_NAME}}` placeholders isn't something a visitor should stumble onto.
If a `.nojekyll` file is ever added, `_dev/` becomes publicly served; nothing in
it is sensitive, but it would look unpolished.

## `dashboard-template.html` — how it works, and its history

This file is a `{{TOKEN}}`-based starting point: duplicate it, find-and-replace
the ~100 `{{PLACEHOLDER}}` tokens with real content for a new workgroup, and
you have a new dashboard consistent with the other four.

**Important history:** this template silently drifted out of sync with the
four real dashboards for an extended stretch — new bug fixes kept landing on
the four real files but were never back-ported to the template, so it
accumulated real, confirmed bugs (a broken anchor-scroll ROI toggle instead of
the working button toggle, a missing dark-mode fix, stale copy, etc.). It was
brought back in sync as of this handoff by systematically diffing it against
the four live files, section by section, and patching each confirmed
divergence — not by rebuilding it from scratch, specifically to preserve its
existing token system intact.

**The lesson, and the ask:** if you fix something on the four real dashboards
that's structural/CSS/JS (not dashboard-specific content), also apply it to
`dashboard-template.html` in the same turn, or explicitly flag it as deferred.
Otherwise this exact drift will happen again.

One known, accepted limitation from this sync: the deliverables table's first
row no longer has its own `.deliv-date-label` span (its label lives in the
`<th>` instead, so it lines up visually with the other column headers). This
means the JS that dynamically flips a row's label between "Completed" and
"Expected Publication Date" based on its status dropdown no longer applies to
that first row specifically. This is documented inline in the template's JS
comments, and it's the same tradeoff already live on all four real dashboards
— not a new limitation introduced by the sync.

## Architecture conventions (load-bearing — don't casually change these)

- **CSS variables, light/dark mode:** `--bar-bg` is a *fixed-role* color
  (`#101B33`) that stays dark navy in both themes — used for buttons, tabs,
  chips, lock-button-when-locked. `--header-bg` / `--header-text` *flip*
  between themes. Don't casually swap one for the other; a past bug (savings
  bar invisible in dark mode) came from `.savings-fill` using `--bar-bg`
  without a dark-mode override, since a fixed-dark color blends into a
  fixed-dark background. Fixed with a scoped
  `html[data-theme="dark"] .savings-fill{background:#fff;}` — don't just
  change `--bar-bg` itself, since that would affect the lock button and other
  intentionally-fixed-dark elements too.
- **Default theme is light.** A FOUC-prevention inline `<script>` sits at the
  very top of `<head>`, before any stylesheet, reading a per-dashboard
  localStorage key and setting `data-theme` before first paint.
- **localStorage keys** (all `tools:hub:…`, see the namespacing rule below):
  `tools:hub:<id>:theme` (theme preference — per-browser is correct for this),
  `tools:hub:<id>:draft` (written only when a save could not reach the relay,
  offered by the restore banner on next load), `tools:hub:theme`,
  `tools:hub:calendar-filter`, and `tools:hub:facilitator-key` (the editor's
  own `Display Name:passcode`). Renamed from the old unprefixed keys in Sept
  2026; done before the relay went live, so no drafts existed to orphan. The old `{id}-roster-data-v1` / `{id}-lane-data-v1`
  keys are gone; nothing reads them.
- **Saving** commits `data/<id>.json` through the GitHub contents API. The
  snapshot is the actual JS data model (`rosterData`, `laneData`, plus every
  other editable field's live value) — it is **not** rendered HTML, because a
  `<select>`'s or date input's current value is never reflected in its
  `outerHTML` once changed, so an HTML snapshot silently loses edits. Every
  visitor reads the committed file at page load. Details that are easy to get
  wrong:
  - **The conflict lock uses the SHA of the version the page READ**, captured
    at load, never refreshed at save time. Fetching the current SHA just before
    writing makes every write match and the lock never fires — that exact bug
    shipped in a first draft and was caught in review. If someone else
    committed since load, GitHub answers 409 and the user is told to reload.
  - **Writes go through a relay** (an AWS Lambda; source and setup in
    `_dev/aws/`). ONE Lambda serves BOTH this project and the Business Glossary:
    every route is prefixed with a project key (`/hub/…`, `/glossary/…`) and a
    single lookup in the `PROJECTS` env var resolves repo, branch, origin and
    facilitator list together. Never take a repo from anywhere else — a routing
    mistake crossing projects is this design's one real risk, and the
    facilitator cache must stay keyed BY REPOSITORY (a global cache let one
    project's list authenticate another's request; caught by test). It holds
    the one GitHub token. People identify with a
    personal key (`Display Name:passcode`, in localStorage as
    `mismo-hub-facilitator-key`) and never see a token. The relay forwards the
    page's SHA untouched; it must never fetch a fresh one. `RELAY_URL` at the
    top of `dashboard-data.js` is the function URL — not a secret, committed.
  - **Keys are managed in `facilitators.json` at the repo root**, not on the
    Lambda, so the admin needs no AWS access. One `admin` and a `facilitators`
    array, each `{name, hash}` with SHA-256 of a *generated* passcode (the file
    is public; chosen passcodes would be crackable). Optional `expires`. The
    relay reads it per request (30 s cache, bypassed on admin writes). Admin
    routes `GET/PUT /facilitators` are admin-key only and always preserve the
    admin entry, so the admin cannot lock themselves out through the relay.
    `key-helper.html` mints passcodes and hashes offline;
    `MismoStore.facilitators` exposes the same for the future admin panel. The
    id `facilitators` is reserved and refused on `/data/`.
  - **Why a relay and not per-person tokens:** the repo originally lived on a
    personal account, where fine-grained tokens can only target repos you own,
    so a collaborator could not create one at all. It is now org-owned, which
    makes per-person tokens technically possible again — but the relay is still
    the right design: it keeps the GitHub token off every facilitator's machine
    and makes revocation a one-line edit rather than an org-admin task. Do not
    revert to per-person tokens.
  - Editors (key present) read via the relay: always fresh, and it returns the
    SHA. Viewers read the deployed file from the same origin (no key, no relay
    call) and the blob SHA is computed client-side from the bytes.
  - Editable-field HTML is stored as `innerHTML` and now arrives from a shared
    file, so it is **sanitised on apply** (`MismoStore.sanitizeHtml`). Without
    that, anyone with write access could commit markup that runs in every
    other facilitator's browser and reads their token.
  - `hasLoadedFromStorage` is set only after the post-load re-render; set
    earlier, the re-render trips the dirty flag and the page opens claiming
    unsaved changes. `laneData` from a file is **merged** over the defaults,
    never assigned — a file predating a lane crashes `renderLane()` otherwise.
  - A save that fails must say so. The previous `window.storage` path failed
    silently on Pages and lost every edit for months. Never reintroduce a
    storage path that can fail without telling the user.
- **Every browser-storage key is namespaced `tools:<app>:<name>`.** All MISMO
  tools are served from one host (`resources.mismo.org/<app>`), and browsers isolate
  storage by ORIGIN — scheme plus host, path does NOT count. So every app on
  that host shares one `localStorage`, one `IndexedDB` and one cookie jar. An
  app that clears storage on sign-out would wipe another app's unsaved work;
  one app's keys are readable by all the others. Namespacing does not create
  isolation — nothing can, on a shared origin — but it stops collisions and
  makes a careless `clear()` obviously wrong in review.
  The `tools:` prefix stays `tools:` even though the host is now
  `resources.mismo.org`. It namespaces the estate, not the URL — renaming it would
  touch 47 references for no functional gain, and the host may be renamed again.
  This app is `hub`: `tools:hub:facilitator-key`, `tools:hub:theme`,
  `tools:hub:<dashboard>:draft`, `tools:hub:<dashboard>:theme`,
  `tools:hub:calendar-filter`. A new app picks its own segment and never
  touches another's. Never call `localStorage.clear()`; remove your own keys by
  name. Anything genuinely secret does not belong in browser storage at all —
  the facilitator key is deliberately low-value and save-only for this reason.
- **Stakeholder types have a key and a display name.** The key is the string
  the dashboards' code and saved data use (`rosterData[].type`,
  `ROSTER_TYPE_TO_LANE`, `<option value>`); it never changes. The display name
  comes from `stakeholder-types.json` via `MismoStore.typeName(key)` and is
  used at every point a type is shown: sidebar row, roster heading, the table's
  type dropdown, the add-organization dropdown, and the search haystack. A
  rename in the admin panel therefore reaches every dashboard on its next
  deploy without touching code or data. If the file can't be read, `typeName`
  returns the key, so the page degrades to today's names rather than blanks.
  Adding a type to the global list makes it *available*; a dashboard adopts it
  by adding a lane (a code change), and `check-types.py --write` then records
  the usage. Merging two keys is a code change, not a rename.
- **Potential initiatives are data, not pages.** Never generate an HTML file
  per potential initiative. `potential.html` renders the record; the record's
  shape is enforced by `validatePotential()` in the relay and mirrored by
  `MismoStore.potential.validate()` in the browser, and the two must stay
  identical. Stakeholder types on a record must be keys in
  `stakeholder-types.json`; the relay refuses anything else. Organizations
  whose type isn't selected for the initiative are hidden, not deleted.
- **One roadmap lane per stakeholder type, one-to-one.** Every type in the
  stakeholder table owns exactly one lane; every lane other than `general`
  belongs to exactly one type. `ROSTER_TYPE_TO_LANE` is where this is written
  down and where a violation would appear (two types mapping to one lane). A
  type with no content gets an empty lane, which renders as "No tasks yet for
  this stakeholder group." Do not invent goals to fill it. This is a decided
  rule; an earlier template comment describing a two-types-one-lane collapse
  as acceptable was wrong and has been removed.
- **Roster sidebar shows every approved type**, built from the union of roster
  types and `ROSTER_TYPE_TO_LANE` keys, with a divide-by-zero guard for empty
  bars. Sourcing from roster rows alone hides a type with no organizations and
  makes its lane unreachable.
- **Default selected type is the first that has organizations**, falling back
  to the first approved type. The older "first alphabetically" rule predates
  types that can be empty; under it a page could open on a blank panel.
- **★ Critical is awareness, not function.** It is a visual marker on the
  stakeholder table and nothing keys off it.
- **Locked vs. unlocked mode:** dashboards load locked (read-only) by default.
  `body.locked` disables interaction on editable `<select>`s/`<input>`s via
  `pointer-events:none` — but a plain `<select>` still shows its native
  browser dropdown arrow regardless of `pointer-events`, which is misleading
  once it's actually disabled. Fixed with a scoped
  `appearance:none` rule under `body.locked`, restored to normal the instant
  it's unlocked.
- **Never use `<a href="#...">` for an in-page toggle.** The ROI/savings
  breakdown used to be an anchor that scrolled to a `#why-card` anchor — this
  looked like it worked but actually navigated the page. It's now a real
  `<button type="button">` with a click handler that toggles a `.roi-detail`
  panel open/closed. If you ever see a toggle built as an anchor tag, that's
  a bug, not a stylistic choice.
- **Table headers should be real column headers, not row-local labels.**
  The deliverables table's 4th column header used to just say "Date" even
  though every row has its own more specific label ("Published",
  "Completed", "Expected Publication Date"). Fixed by moving the *first*
  row's specific label into the actual `<th>` (see the limitation noted
  above), removing the generic placeholder header entirely.
- **`vertical-align:top`** is set explicitly on `.deliverables-table td`,
  since the browser default (`middle`) looks fine on short rows but visibly
  misaligns content whenever a row's first cell wraps to two lines.

## Testing workflow (follow this before every deploy)

1. Edit the file in `/home/claude/template-work/` (or wherever your working
   copy lives).
2. **Validate HTML nesting** — run `python3 _dev/validate_nesting.py {file}.html`
   (in this repo). It's a stack-based
   checker that catches real mismatched open/close `<div>` tags, not just
   whether total open/close counts happen to match (which can coincidentally
   line up despite a real bug).
3. **Check JS syntax** — extract `<script>` blocks and run `node --check` on
   each. Note: `dashboard-template.html` will *never* pass this directly,
   since its `{{TOKEN}}` placeholders (especially numeric ones like
   `{{LEADERBOARD_SCORE_1}}`) aren't valid JS syntax until filled in. To test
   it, regex-replace every `{{TOKEN}}` with a safe dummy value first (numeric
   tokens → `1`, everything else → a short string), check syntax on *that*
   copy, and discard it afterward.
4. **Real-browser test with Playwright**, not just static inspection. This
   project uses a real headless Chromium at
   `~/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome`.
   Confirm interactive elements actually work (toggles open/close, selects
   have the right option count, no `pageerror` events), not just that the
   markup looks plausible.
5. **Screenshot and visually confirm** anything involving layout, alignment,
   or color — several bugs in this project's history looked correct from the
   code alone but were visibly wrong once rendered (a fixed pixel offset that
   worked for one dashboard's row height and broke on a shorter row is a
   good example of why "looks right in the diff" isn't sufficient).
6. **After any change to `dashboard-data.js`, run `python3 _dev/bump-module-version.py`.**
   Every page includes the module with `?v=<content hash>`; the script rewrites
   them. Without it, a visitor's browser keeps a cached older module and a new
   page fails on a function that doesn't exist yet — it shows as a page stuck
   on "Loading…". This happened on the first real potential-initiative page.
7. **Test what you claim, not what you built.** The conflict lock looked
   right in the code and passed every render test; it only fails when two
   people save. It was caught by intercepting `api.github.com` with a
   Playwright `page.route`, checking the SHA in the PUT body against
   `git hash-object` of the file the page read, and asserting a mocked 409
   surfaces as a conflict. Any claim about concurrency, persistence or
   security needs a test that exercises the claim.
8. Only after all of the above passes, copy to the deploy location and `git
   push`.

## Deployment workflow

```bash
cp template-work/{file}.html gh-deploy/{file}.html
cd gh-deploy
git add {file}.html
git commit -m "<what changed and why, verified how>"
git push origin main
```

Write commit messages that explain *what changed, why, and how it was
verified* — this project's history relies on being able to reconstruct
reasoning from commit messages alone, since context resets between sessions.

## GitHub access

The repo is public: https://github.com/GitMISMO/initiative-hub

For push access, authenticate properly rather than reusing a hardcoded
personal access token in a plaintext file:

- **From Claude Code:** run `gh auth login` once per environment, or connect
  GitHub through Claude Code's native GitHub integration (`/web-setup` from
  the CLI, or via claude.ai settings for cloud/web sessions).
- **The dashboards' own token lives only on the Lambda** (`GITHUB_TOKEN`).
  Rotate it there. It never belongs in this repo, a document, or a chat.
- **A prior personal access token was used** during the Claude.ai chat-based
  sessions that built this project (visible repeatedly in that conversation
  history, and already flagged there for rotation). Don't reuse it — if
  you're the project owner, revoke it in GitHub's token settings and
  authenticate fresh via one of the methods above instead. Continuing to
  copy a live credential from document to document only increases exposure.

## Known deferred / pending items

Carried forward from earlier sessions, still outstanding as of this handoff:

- **Type-name convergence is now a rename away, except where it's a merge.**
  `Investors/Aggregators` (TPA) and `Aggregator/Investor` (LBDS) are two keys
  for one thing. The panel refuses two types with the same display name, so
  fixing this means changing TPA's key to `Aggregator/Investor` in its code
  and data, then `check-types.py --write`. Plurals (`Warehouse Lenders`,
  `eMortgage Technology Providers`) can just be renamed in the panel.
- **`_dev/dashboard-template.html` has drifted structurally again.** The four
  live dashboards use the sidebar layout (`renderTypeSidebar`,
  `ROSTER_TYPE_TO_LANE`, roadmap rendered inside the roster panel keyed on
  `activeType`, `computeStableFieldKey` for generic fields). The template is
  still on the older chip-row layout (`renderChips`, separate `#roadmap`
  section, index-based generic field keys). Its storage layer and comments
  were brought current in Sept 2026; its layout was not. A dashboard built
  from it today will not match the other four. Re-sync section by section as
  before — do not rebuild from scratch, the token system must survive.
- LBDS's roadmap content is pending: the `LOS Provider`, `Servicing System`
  and `Aggregator/Investor` lanes ship empty by decision. The content removed
  from the old combined lane is preserved verbatim in a comment above the
  split in `lbds-dashboard.html`.
- MCD's `Lender (Proprietary LOS)` lane is empty and its completed awareness
  task sits only under `Lender (3rd Party LOS)`; arguably it applies to both.
  Flagged NEEDS REVIEW in the code.
- Stakeholder-type names have not converged: TPA's `Investors/Aggregators` vs
  LBDS's `Aggregator/Investor` are one type under two names; TPA's
  `Warehouse Lenders` is plural where the list is singular. Settle before the
  admin panel makes the approved list authoritative.
- The admin panel (shared, approved stakeholder-type list) does not exist.
  When built it needs its own guard — retiring a type that initiatives still
  select orphans a roadmap lane — and `dashboard-data.js` is per-dashboard
  today; the shared list will need a shared path.
- LBDS's meeting-tracker leaderboard was MCD's data verbatim and has been
  removed. LBDS's own engagement scores have never been loaded; the card says
  so. Restore the array and render loop from the template when real figures
  exist. Do not repopulate from another workgroup's tracker.
- LBDS's resource links are placeholders — need real URLs.
- The hub's brand color (`--brand: #2A4DFF`) doesn't match the four
  dashboards' brand color (`#125DAB`) — never reconciled.
- The calendar page (`calendar.html`) doesn't have full dark-mode styling.
- TPA's Governance section leadership tag was left blank deliberately —
  workgroup hasn't started meeting yet, no real leadership to show.

## What's next for this project

The repository is the backend now, by decision: no new service or account.

Queued, roughly in order:

1. **Repo migration to the organization's GitHub.** Owner's task. Afterwards:
   recreate the Lambda's token under the org, update `GITHUB_REPO` and
   `ALLOWED_ORIGIN`, and update the account name in `_dev/aws/SETUP.md` and
   this file. Code needs no changes.
2. **Lambda relay live** (IT creates it per `_dev/aws/SETUP.md`), then
   `RELAY_URL` set in `dashboard-data.js` and the admin entry created in
   `facilitators.json`.
3. **Potential Initiatives** — built Sept 2026: hub tab with cards, one
   data-driven detail page, and the wizard. Deliberately NOT a generated
   dashboard file per initiative: a record is a data commit, so every one
   looks identical by construction and none depends on the drifted template.
   "Launch into a full dashboard" is a later step that waits for the template
   re-sync. The formatting step ("dump notes, get the format") is done in
   chat with Claude, which produces the JSON; the site never needs an API key.
4. **Press Release Drafting Widget and Editor** — scoping started Sept 2026.
   A separate repo/tool at `resources.mismo.org/press-release`, drafting from
   initiative dashboard data against MISMO's house template, with the VP
   commenting on the draft and an agent revising in response.

   Decided so far:
   - The draft is a **list of blocks with stable IDs**, not one long string. A
     comment attaches to a block, not to a character offset — offsets are
     meaningless the moment text is rewritten, and comments silently drift onto
     the wrong sentences. It also means only the commented block is rewritten,
     so the agent cannot quietly "improve" paragraphs already approved.
   - Blocks can be **approved and locked**, so a late comment cannot undo
     wording already signed off.
   - Quotes, names, dates, statuses and URLs are **fixed slots the agent never
     writes or edits**. It drafts the prose around them. A fabricated attributed
     quote in a press release is a correction, not a bug.
   - Needs a second relay route, `POST /press-release/ask`, holding the
     Anthropic API key server-side — same reasoning as the GitHub token. Billing
     is a separate MISMO-owned account at platform.claude.com, not a Claude.ai
     subscription. At a few releases a month the cost is roughly a dollar or two.
   - Template derived from five 2026 releases; see the conversation history.
     Eight sections, every slot marked fixed or generated.

   Blocked on three fields the initiative records do not carry: the developing
   group (name, type, mismo.org URL), workgroup leadership, and the product's
   mismo.org URL. Leadership exists on the four built dashboards as Chair and
   Vice-Chair cards but not on the hub records; potential initiatives already
   have a `leadership[]` array.

   **A second announcement type is still to scope: the call for participation.**
   Issued after a workgroup is approved but before anything is published, so it
   has no product URL, no status and no publication — the opposite shape to a
   release announcement. Tabled Sept 2026, to come back to. Worth noting that a
   chartered group with named leadership is exactly what separates the two: an
   initiative without them cannot have a release announcement written at all,
   which is the guard the drafting tool should apply.
5. Template structural re-sync and the TPA/LBDS key merge (see deferred list). See this project's conversation history in Claude.ai for the
reasoning already discussed on model/effort selection (Sonnet for day-to-day
work, Opus/Fable for architecture decisions, `opusplan` to combine both) and
using the advisor tool or an adversarial review subagent as a second check on
non-trivial changes before they ship.
