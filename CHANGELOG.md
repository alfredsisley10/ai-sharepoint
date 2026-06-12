# Changelog

## 0.31.1 — 2026-06-12

### Fixed — pasted working SQL parses even when the catalog's schema differs (ER diagram) (pilot)
- A working two-join Active Directory query still produced "could not determine any joins" —
  through BOTH the deterministic parser AND Copilot. Two compounding, now-fixed causes:
  - **Table resolution required the full qualified name to match.** The SQL says
    `dbo.LDAP_USERS`; if the loaded catalog stored that table bare (`LDAP_USERS`) or under a
    different schema, nothing resolved and every join became a "not found/ambiguous" issue.
    Resolution now matches on the **table-name segment** — schema-tolerant and multi-part
    tolerant (`ADExport.dbo.LDAP_USERS` → `LDAP_USERS`) — and prefers the reference's schema
    only to disambiguate same-named tables across schemas.
  - **The Copilot extraction prompt listed only "joinable" columns.** It now lists **every
    column with its type**, so the model can always see the columns a working query joins on
    (LOB/odd types included; casts handle type mismatches at probe time).
- **Real diagnosis when nothing parses**: if the SQL's tables aren't in the loaded catalog, the
  wizard now names them and shows the catalog's actual tables — *"these tables aren't in the
  loaded catalog: …; the catalog has: … — run Load/Refresh Database Schema or confirm the right
  database"* — instead of a blank "couldn't determine joins". Error messages distinguish
  "table not in catalog" from "column not in that table".

## 0.31.0 — 2026-06-12

### Added — Teams delivery without admin consent: Incoming Webhooks (pilot)
- Direct Teams messaging needs `Chat.ReadWrite` admin consent (Microsoft Graph has no “unsent
  Teams message” — it always posts live, unlike Outlook, whose draft scope `Mail.ReadWrite` is
  separate from `Mail.Send`). When that consent is pending or denied, you can now deliver to a
  Teams **channel** via an **Incoming Webhook** — **no app registration, no admin consent, no
  Graph**.
- **Configure Teams Webhook…** (Communications view title bar): a channel owner creates the
  webhook (channel ••• → Connectors → Incoming Webhook, or a Power Automate “Workflows”
  webhook); paste the URL — stored only in your **OS keychain**, never settings or logs — and
  name it. Add/remove multiple channel webhooks.
- Teams drafts then show a **“Post to <name>”** button in the same approval dialog (full
  preview, modal confirmation, discard) that posts a MessageCard to that channel. Trade-off,
  stated in the dialog: a webhook targets a channel, not a 1:1/group chat, and can’t @-mention
  — the recipient list appears as a **“For:”** line in the card. The Graph “Send via Teams”
  path is unchanged and still offered.
- Webhook posts go only to `*.webhook.office.com` / the configured Power-Automate host; revoked
  or rotated webhooks (404/410) are reported with re-configuration guidance.

## 0.30.5 — 2026-06-12

### Fixed — switching projects now re-scopes the Reference Sources view immediately (pilot)
- Activating a project (or returning to **All sources**) updated the active scope but did **not
  refresh the Reference Sources tree**: the `onDidChange` handler only rewrote the view's
  header. So sources appeared to "vanish" entering a project, and selecting *All sources (no
  project)* didn't bring them back until some unrelated refresh (adding a source, reopening the
  view) happened to fire. The handler now calls `sourcesProvider.refresh()` on every project
  change, so scoping applies and reverts instantly in both directions. No data was ever lost —
  only the tree's rendering lagged the active scope.

## 0.30.4 — 2026-06-12

### Added — ER results are stamped with the build that produced them (pilot)
- The torn-install episode made "which build produced this zero-join result?" unanswerable —
  some ER test runs likely executed pre-fix code. Every ER model now records the **extension
  version whose code ran the build** (`builtBy`), and the probe report header shows it
  (*"42 pair(s) probed (ai mode) by v0.30.4 …"*), so a result can always be attributed to a
  build when comparing runs across updates.

## 0.30.3 — 2026-06-12

### Fixed — torn installations are detected and named (pilot: "no option to enable Projects")
- The container header showed pre-0.20 view names ("Usage & Budget") with **no Projects entry
  to enable**, while 0.23+ features ran fine — the definitive signature of a **torn install**:
  VS Code rendering a stale cached interface manifest while executing newer code. Views and
  commands contributed after the cached version simply don't exist in the UI, and no amount of
  header-menu toggling can bring them back.
- The extension now **detects this state at startup** by comparing the version compiled into
  its code against the manifest VS Code actually loaded, and says exactly what's wrong with
  both versions named — *"interface manifest is v0.19.0 but the running code is v0.30.3…"* —
  plus the escalation path: reload the window → if it returns, fully quit and restart VS Code
  → if it persists, uninstall and reinstall the VSIX. A release-gate test keeps the compiled
  constant in lock-step with package.json. Troubleshooting table updated.

## 0.30.2 — 2026-06-12

### Fixed — Projects is discoverable: documented with the other views, in the walkthrough, with a reveal path (pilot)
- The Projects view has shipped since 0.19.0 (view, commands, menus, chat integration), but a
  user following the docs couldn't find it: the user guide's **"activity-bar views" overview
  listed only three of the six views** — Projects, Reference Sources, and Communications were
  missing — and the table of contents had no Projects entry. The overview now covers all six
  views in container order, the TOC links the full Projects section, and that section says
  exactly where the view sits and what to do if it isn't visible.
- **New walkthrough step "Organize work into Projects"** with one-click [Open the Projects
  View] (reveals the view even when hidden or collapsed) and [Create a Project].
- Added a general note for all views: VS Code remembers per-view visibility — right-click the
  AI SharePoint activity-bar header to re-check hidden views; sections can be collapsed to a
  thin header; newly added views appear after the post-update reload.

## 0.30.1 — 2026-06-12

### Fixed — ANY portion of working SQL now parses into joins (pilot)
- "No joins could be parsed" happened on the pastes people actually make: **fragments**. The
  extractor required fully qualified `x.col = y.col` with declared aliases — but real pastes
  are often just the ON/WHERE logic (`ON u.distinguishedName = ga.member_dn AND …`) whose
  aliases were never declared, or bare equalities with no qualifiers at all.
- The parser now resolves all of it: **undeclared aliases are inferred** from table names
  (`u` → LDAP_USERS, `ga` → LDAP_GROUP_ASSOCIATION — token initials/prefixes, then narrowed by
  which table actually has the column); **bare `column = column` equalities** resolve by
  column membership across the catalog (preferring tables the paste names), with a unique side
  excluding its table from the other side's options; genuinely ambiguous columns produce an
  honest issue naming the candidate tables — never a guess — and unknown=unknown pairs are
  skipped as noise. Precise "column not in that table" errors are kept.
- The **Copilot summarization fallback** now states the paste may be a fragment with
  undeclared aliases and instructs the model to infer table membership from the catalog's
  column lists. Wizard text and examples updated to say "any portion of working SQL".

## 0.30.0 — 2026-06-12

### Added — paste a working SQL query and the ER run mines its joins (pilot)
- The **Known joins** step of the ER wizard now accepts a **whole working SQL query or
  snippet**: every join condition is extracted deterministically — table aliases resolved,
  compound `ON a.x = b.y AND a.z = b.w` clauses split, repeats deduplicated, literal filters
  ignored — and a toast confirms what was found. Unresolvable fragments become actionable
  notes, never run-stoppers.
- **Copilot summarizes the SQL when parsing falls short** (deep subqueries, dialect quirks,
  derived tables): with your approval — the prompt says the pasted SQL plus table/column names
  are sent — Copilot reads the query and returns the target join pairs, validated against the
  catalog like every AI proposal.
- Joins extracted from working SQL enter the run as **user-defined**: probed first, probed
  **with casts when they cross types** (the working query is the evidence the join runs), and
  persisted even below the automatic thresholds with their measured rates visible.

## 0.29.1 — 2026-06-12

### Fixed — the ER toast keeps its status text, names the pass, and escalations are real approvals (pilot)
- **Why the toast kept reverting to a bare "ER model":** the per-pair progress-bar update was
  sent without a message, and VS Code **clears the toast text on any message-less report** — so
  every completed pair wiped the status, and the next throttled repaint "flashed" detail for a
  moment before the cycle repeated. Every report now carries the current (sticky) status line;
  the text only *changes* at the readable 2-second cadence but never disappears.
- **The high-level process is visible**: the status line now leads with the active pass —
  *"native pass · 37/220 · ~3 min left · 12 found · …"*, then *"cast pass · …"*, *"large
  tables · …"*, *"AI refinement · …"* — so the user can monitor where the run is in the
  escalation ladder, not just the counter.
- **Escalation approval is a modal dialog**, not a missable toast behind the spinner: each gate
  states the pass, why it's warranted (e.g. "14 probe(s) failed natively — often LOB/mismatched
  types") and how many pairs it adds; while the dialog is up, the progress toast reads
  *"awaiting your approval for the cast pass…"*. Maximum mode still skips the prompts.

## 0.29.0 — 2026-06-12

### Added — incremental escalation: cast comparisons, failed-probe retries, large tables (pilot)
- The LDAP three-table test still produced zero joins in the real environment — which points
  at the probes themselves failing invisibly: SQL Server's legacy `ntext`/`text` columns
  (common in AD exports) **cannot be compared with `=` at all**, so every probe errors and
  looks exactly like "no relationship"; and `int ↔ varchar` key pairs never formed under the
  type-family gate.
- Runs now **escalate through passes, with your say-so between each** (or automatically in the
  new **Maximum** mode):
  1. **Native pass** — everything as before.
  2. **Cast pass** — pairs that *failed* or sampled nothing are **re-probed comparing both
     sides as a common text type** (`NVARCHAR(MAX)` / `::text` / `CHAR` / `$toString`), plus a
     cross-type sweep pairing key-shaped columns across families (your "dynamic type
     conversion" requirement). This is the decisive pass for legacy exports.
  3. **Large-table pass** — tables beyond the 50k-row cap join the sweep with strictly bounded
     samples (never full scans), cheapest pairs first.
- Relationships proven through casts are flagged **(cast)** in the diagram, the rate table,
  and chat's JOIN paths — with explicit guidance to CAST both sides when writing such joins.
  `test_join` in chat now probes cross-typed user joins with casts automatically. SQL Server's
  `sysname` now counts as text. The escalation prompts state how many pairs each pass adds and
  why ("N probes failed natively — often LOB/mismatched types").

## 0.28.0 — 2026-06-12

### Fixed — ER runs find junction tables: measurement-first sweeps (pilot)
- A 3-table AD export (LDAP_USERS / LDAP_GROUPS / LDAP_GROUP_ASSOCIATION) finished at 100%
  with **zero joins** — the textbook case the feature exists for. Two root causes:
  - **Name heuristics cannot bridge `member_dn` → `distinguishedName`** — junction tables join
    on columns whose names share nothing. The exhaustive sweep is what finds them by
    measurement, but…
  - …**the sweep excluded tables with unknown row estimates.** Fresh exports often carry no
    statistics, so every table was silently skipped and "Thorough" probed nothing.
- Corrections, matching how DBAs actually work ("probe all tables for plausible join columns,
  test the rates, verify the logic"):
  - Tables with **unknown sizes are sweep-eligible** (bounded samples keep it cheap); only
    tables *known* to exceed the 50k-row cap sit out.
  - Scopes of **≤12 tables are swept exhaustively in every mode** — no mode picking required
    for the small-database case; the consent dialog says so.
  - The **AI prompt now teaches junction-table reasoning** and the common key domains (numeric
    ids, GUIDs/UUIDs, SIDs, LDAP DNs, UPNs/sAMAccountNames, emails), so cross-named references
    get proposed on large scopes too.
- Expected on the test case: `member_dn ↔ LDAP_USERS.distinguishedName` and
  `group_dn ↔ LDAP_GROUPS.distinguishedName` at ≈100%, with the association table read as the
  many-to-many bridge. If rates come back lower than reality on PostgreSQL, check collation —
  DN comparisons there are case-sensitive; the probe report now shows the measured near-miss
  either way.

## 0.27.1 — 2026-06-12

### Fixed — updates no longer surface ANY raw registration errors (pilot, second report)
- The 0.24.1 fix consolidated **view-creation** failures, but two other registration classes
  still threw raw errors after an in-place update: **language-model tools added by the update**
  (most releases add one — registering a tool the cached manifest doesn't declare throws and
  **aborted activation mid-flight**, stranding commands and surfacing raw text), and views
  created against a stale manifest could keep throwing **asynchronously** from later
  refresh/badge traffic even when creation appeared to succeed.
- Activation now reads the manifest **VS Code actually loaded** and skips what it can't host:
  views not declared there are never created (so they can't throw later either), and every
  registration block (chat participant, site/context/communication/site-dev/project tools)
  degrades gracefully instead of aborting. Everything funnels into the single
  *"AI SharePoint finished updating — reload the window to activate everything"* prompt with
  its **Reload Window** button; per-item details go to the extension log only.

## 0.27.0 — 2026-06-12

### Added — scoped, seeded ER runs: pick the tables, hint the AI, hand over known joins (pilot)
- **Search & multi-select table scoping.** A 100-table database is rarely one diagram: the
  wizard now opens with an optional **prefix/keyword filter** that pre-selects tables (shared
  prefixes usually mean a shared objective — `fin_, gl_`), followed by a **searchable
  multi-select** (each entry shows kind, column count, and estimated rows) to refine by hand.
  Candidates, thorough-mode pairs, and the AI prompt all work on the scoped set — and
  persisting now **merges**: relationships outside the scope survive from earlier runs while
  re-probed pairs take the fresh measurement, so large databases get mapped neighborhood by
  neighborhood.
- **Describe the data for the AI.** In the AI modes a free-text hint (*"SAP FI tables — MANDT
  is the client key on every table; gl_-prefixed tables share the ledger key"*) is weighted
  into Copilot's join hypotheses, giving it the domain knowledge no catalog carries. The hint
  persists with the model and pre-fills the next run.
- **Hand over known joins.** Semicolon-separated joins (SQL syntax or
  `table.column = table.column`) are parsed against the full catalog (they may cross the
  scope), probed **first**, and kept even when the measured rate falls below the automatic
  thresholds — marked *defined* with the rates visible, same semantics as chat's `test_join`.
  Unresolvable entries are reported with actionable errors and skipped, never fatal.

## 0.26.0 — 2026-06-12

### Added — refine the ER diagram from chat with your own joins (pilot)
- Paste a join you know into **@sharepoint** — SQL syntax with aliases (*"FROM Orders o JOIN
  Customers c ON o.customer_id = c.id"*) or a bare `table.column = table.column` — and the new
  `test_join` tool **validates it against the ER model** (already there → the stored
  relationship comes back) or **probes the live join rate** in both directions, with the same
  counts-only posture as the batch build. Ask to save it and, after your confirmation in chat,
  the ER diagram is **extended incrementally**: user-defined joins persist even when they
  measure below the automatic thresholds (verdict *defined*, measured rates kept visible), and
  joins across type families are allowed with an implicit-cast warning instead of being
  rejected. Aliases, brackets/quotes/backticks, and unqualified-but-unique table names all
  resolve; unknown tables/columns return actionable errors listing what exists.

### Fixed — the ER build toast no longer hides the counts and ETA (pilot)
- VS Code renders the progress toast's title and message on **one truncating line** — the long
  *"Building ER model for "DB (mssql)"…"* title left no room, so users saw no counts and no
  minutes-remaining. The title is now minimal ("ER model") and the status message is compact
  with the vitals leftmost: **"37/220 · ~3 min left · 12 found · dbo.Orders…"** — the
  current-pair detail is a hard-capped trailer that truncates first.

## 0.25.0 — 2026-06-12

### Added — ER builds: AI-proposed joins, a probe report that explains zero results, and a data-quality tier (pilot)
- **A run that finds nothing is now diagnosable.** Every probed pair persists with its measured
  rates and outcome; the schema view gains a **Probe report** (outcome counts, the closest
  misses with their forward/backward rates, which proposer suggested each pair) and the
  end-of-run toast leads with the **best measured rate** instead of a bare zero. When most
  probes sampled **zero values**, the report says so explicitly — that's a sampling/permissions
  problem to fix, not proof of no relationships (the wire log shows the exact SQL).
- **AI-assisted candidates (recommended mode).** Copilot proposes likely joins from everything
  the indexes know — names, types, semantic tags, and content-type summaries — so columns that
  the heuristics can't connect by name still get tested. Proposals are validated against the
  catalog (hallucinated tables/columns and type-incompatible pairs are dropped) and probe
  first. If little confirms, **one refinement round** shows Copilot the measured near-miss
  rates and probes its revised hypotheses. Same data posture as schema indexing: names, tags,
  and summaries go to Copilot — never row data.
- **98–99% joins are designed joins.** A best-direction rate in the 98–99% band now carries an
  explicit reading: treat it as the intended relationship — the unmatched remainder usually
  means an upstream **data-quality issue (orphaned keys)** to resolve in the source system,
  not a different join.

## 0.24.2 — 2026-06-12

### Changed — ER build status shows the big picture, at a readable refresh rate (pilot)
- Thorough ER runs repainted the toast on every pair and every escalation tier with pair-level
  detail only — impossible to track overall progress. The status line now leads with the run's
  shape: **"pair 37 of 220 · 12 relationship(s) · ~3 min left · now: dbo.Orders.customer_id ↔
  …"**. The **ETA comes from the measured pace** (elapsed ÷ completed × remaining) and only
  appears once a few pairs have finished ("estimating time…" before that); the current pair is
  a truncated trailer, never the headline; and repaints are **throttled to every 2 seconds**
  so the numbers are actually readable. The progress bar still advances per pair.

## 0.24.1 — 2026-06-12

### Fixed — one friendly prompt after updates instead of a pile of "no view registered" warnings (pilot)
- Every in-place update raised **one warning per activity-bar view** (up to six identical
  toasts) when VS Code's cached manifest lagged the new code — harmless but confusing. View
  registration failures during activation are now **collected and surfaced once**, as an
  information message — *"AI SharePoint finished updating — reload the window to activate its
  views"* — with a **Reload Window** button that performs the fix. Per-view details go to the
  extension log only; everything still self-heals on reload exactly as before.

## 0.24.0 — 2026-06-12

### Changed — ER probing is now adaptive: sized by your database, escalating to complete joins (pilot)
- The fixed 40-pair × 100-value plan was arbitrary. The run is now planned from the data:
  - **Sizing pass first** — approximate row counts for every table from catalog statistics
    (one query; never `COUNT(*)`, so sizing a warehouse costs the same as a sandbox).
  - **Dynamic candidate budget** — scales with tables and columns (40…300).
  - **Complete joins where they're cheap** — pairs whose tables are both ≤50k rows are tested
    in full (every distinct value), not sampled; relationships verified this way are flagged
    `complete` in the model, the view, and chat's JOIN-path output.
  - **Escalation while fast** — sampled pairs start at a row-count-sized sample (100–500) and
    grow ×5 after every fast probe (<1.5s) toward full coverage or a 10k cap, because
    completeness is preferred whenever the database can afford it.
  - **Sensitivity over completeness** — a slow probe (≥5s) pauses the run to give the database
    air; three consecutive slow or failed probes de-escalate the remainder to minimal samples.
  - **Thorough mode** — optionally tests *every* type-compatible column pair across the small
    tables (capped, cancellable, deduped against the heuristic candidates) for the full
    permutation sweep.
- The consent dialog now states the actual plan (how many complete joins vs sampled probes);
  per-pair progress shows the sample tier in use.

## 0.23.2 — 2026-06-12

### Fixed — Vertex AI Search for Entra-federated users with no GCP access (pilot)
- Users who reach the corporate search page via **Entra ID / Azure AD SSO** hold no Google
  Cloud roles: *Find the project for me* sees no projects, `gcloud` isn't an option, and the
  project prompt was a dead end. The wizard now mines the **search page's own network
  traffic** — the page's API calls embed the full resource name. Paste any `search`/`answer`
  request URL from the page's Network tab into the project step and the wizard extracts
  `projects/<number>` (a project **number** works like an ID), plus the location/engine when
  present; bare `projects/…` resource strings parse too. Prompts walk through the F12 steps.
- **Sign-in without gcloud**: the pasted-token prompt now explains capturing the page's own
  `Authorization: Bearer` value from the same Network tab — your session's token, ~1 h,
  re-pasted via *Test Context Source* (a leading "Bearer " is stripped automatically).
- The zero-projects warning from auto-detection now routes to this path instead of "ask the
  app owner".

## 0.23.1 — 2026-06-12

### Fixed — ServiceNow: the missing piece for cookie sessions is the page CSRF token (g_ck) (pilot)
- Complete, fresh cookies from Edge **and** Chrome — raw or parsed — still failed to connect.
  No cookie capture can fix that case: many instances require the **page CSRF token**
  (`X-UserToken`) for cookie-authenticated `/api/now` calls. The wizard now asks for it as an
  **optional step** after the cookie paste (signed-in tab → DevTools → **Console** → type
  `g_ck` → Enter → copy the value); when supplied it is stored with the cookies (keychain) and
  sent as `X-UserToken` on every request. The rejection diagnosis now recognizes the exact
  signature — complete cookies + *"User Not Authenticated"* + no token sent — and points
  straight at `g_ck` instead of generic causes.
- **Capture-format question answered in the UI**: raw and parsed header captures both work and
  the wizard now says so — right-click the Cookie header → *Copy value*, or toggle DevTools'
  *Raw* view and copy the whole `Cookie: …` line; the label is stripped and the rest is
  normalized either way (as are cookie-table rows and Firefox Copy-All JSON).
- Stored secrets remain backward compatible (cookie-only captures stay plain strings; the
  token uses a structured form), and cookie normalization still applies inside the new form.

## 0.23.0 — 2026-06-12

### Added — Build Database ER Diagram: relationships by probed join rates (ADR-0030) (pilot)
- Enterprise databases rarely declare foreign keys, leaving users guessing which columns join.
  The new **Build Database ER Diagram** function (next to *Index Database Schema* / *Index
  Database Content Types*) establishes relationships **empirically**: candidate pairs are
  proposed from the schema and the existing semantic/content indexes (FK-shaped names like
  `customer_id` → `Customers`, identical non-generic names, identifier tags that agree;
  type-compatible only), then each pair's **join rate is measured in both directions** — up to
  100 distinct values sampled per side, counting matches on the other (≈2 bounded count
  queries per pair; **only counts are read, no row data**; explicit consent first;
  cancellable; per-pair failures degrade to a partial model).
- **Scoring honors real-world data**: ≥95% match = *strong* (designed-in), ≥70% best-direction
  = *likely* (relationships needn't join 100%), below = discarded as coincidence. Measuring
  both directions captures the **inner-vs-outer** distinction — full containment one way with
  partial the other marks an intentional **subset**, and the persisted note says which side
  needs a LEFT JOIN to keep unmatched rows.
- **Persisted and used everywhere**: the ER model is stored with the schema, drawn as a
  **Mermaid ER diagram** + rate table in *View Database Schema & Semantic Index*, carried by
  **Export/Import Reference Config** (teammates inherit it without re-probing), and appended
  to every `#spDbSchema` answer so chat writes correct, efficient multi-table JOINs. Works on
  SQL Server, PostgreSQL, MySQL, and MongoDB (`$lookup`).

## 0.22.2 — 2026-06-12

### Added — Power BI sign-in with nothing to install (pilot)
- Standard users without the Azure CLI (and without install rights) hit *"The Azure CLI (az)
  was not found on PATH"*. New **recommended** sign-in: **Microsoft sign-in — nothing to
  install**. It's a normal browser or device-code sign-in that authenticates **as the Azure
  CLI first-party app** (public client `04b07795-…`), which is already authorized for the
  Power BI service — identical consent posture to `az login` with **no CLI, no app
  registration, no admin approval**. Sign in once; MSAL refreshes silently from a
  source-private keychain cache that is wiped when the source is removed. Conditional access
  applies; sign-in logs attribute the session to "Microsoft Azure CLI" (documented for
  admins).
- The az-missing error and the paste-token prompt now point to **shell.azure.com** (the
  browser-based Azure Cloud Shell, az preinstalled) with the exact
  `az account get-access-token` command, so even the fallback path needs no local install.

## 0.22.1 — 2026-06-12

### Changed — Vertex AI Search: the wizard finds the hosting project for you (pilot)
- Pasting the corporate search URL identified the **app** and **region** but then asked a
  standard (non-admin) user for the **hosting Google Cloud project** — information they rarely
  have. The wizard now offers **"Find the project for me"**: with the app id and region already
  known from the URL, it lists the projects your Google sign-in can see and probes which one
  hosts that app (permission gaps skipped, progress shown, ~5 probes at a time). One match →
  filled in automatically; several → pick; none → a clear explanation that your account uses
  the app without a project role, plus manual entry.
- The manual prompt now speaks to standard users: scan with *Find the project for me*, run
  `gcloud projects list` (locally or at shell.cloud.google.com — no install), or ask whoever
  shared the search page; the Cloud Console `?project=` hint is kept for those with console
  access.

## 0.22.0 — 2026-06-12

### Changed — @sharepoint status: no more reflexive "Reading <site>", and results narrate back (pilot)
- **"Reading <site>…" no longer appears regardless of the task.** The live site read now
  requires actual site evidence: an explicitly referenced site (URL or name) or
  SharePoint-specific vocabulary. The previous trigger matched generic words — *"**list** the
  top Splunk errors"* read the SharePoint site — and fired on every turn when no reference
  sources were configured. Skipping costs nothing: the model calls `site_overview`/`list_pages`
  itself (with its own accurate status) whenever the question really concerns the site.
- **Each processing step now reports outcomes, not just intentions**: rounds are labeled with
  the model and step (*"Asking GPT-4.1…"*, *"Step 2: GPT-4.1 is reviewing the results…"*), and
  every tool call is followed by a completion line saying what came back — *"Search of CMDB:
  12 result(s) — continuing…"*, *"Bookmark "IT Help queue": 2 result(s)…"*, *"Search of Wiki:
  no results…"* — so long multi-tool turns read as a narrated plan with visible progress.

## 0.21.2 — 2026-06-12

### Fixed — ServiceNow cookie sessions: evidence-based rejection diagnosis + gateway compatibility (pilot)
- Cookies captured from a **brand-new browser session** were rejected and the error still
  claimed *"session cookies expire with your browser session"* — a misdiagnosis. Rejections are
  now diagnosed from **what the server actually returned**: ServiceNow's own error body (e.g.
  *"User Not Authenticated — Required to provide Auth information"*), the **title of an HTML
  page** (login page? SSO gateway? hibernating developer instance?), and any **redirect off the
  instance host** (the signature of an SSO front-end intercepting API calls). Missing
  essentials are called out by name (*"the capture is missing JSESSIONID"*), and the summary
  distinguishes just-captured failures (incomplete paste, gateway only accepting browser
  traffic) from old captures (genuine expiry) instead of presuming expiry. Hibernating-instance
  pages are classified as infrastructure, not auth, so they don't count toward lockout.
- **Browser-compatible User-Agent on cookie replay**: SSO/WAF front-ends commonly drop
  non-browser clients even with valid session cookies — the likely cause of fresh captures
  failing. Cookie-session requests now send a `Mozilla/5.0`-prefixed UA that still names the
  extension. Other auth methods are unchanged.

## 0.21.1 — 2026-06-12

### Fixed — expired Splunk session: offer a refresh instead of Entra tenant advice (pilot)
- A previously-working Splunk connection whose browser-session cookie aged out failed *Test
  Context Source* with **"Sign-in was rejected. Check with your administrator that this app is
  allowed in your tenant, or configure a custom client ID"** — Microsoft Entra guidance that
  has nothing to do with Splunk. Two fixes:
  - **Test Context Source now prompts to refresh.** When a STORED credential is rejected
    (auth failure) on an explicit test, it explains what likely happened — *"Your Splunk
    browser session has likely expired — sign in to Splunk Web again and capture a fresh
    splunkd cookie"* (ServiceNow sessions and tokens get matching wording) — and offers
    **Refresh Sign-in**, which reopens the capture flow, re-verifies, and saves the new
    credential in one pass. Freshly-entered credentials that fail still surface normally.
  - **Errors that know their own remediation no longer get generic advice appended.** Splunk
    sign-in rejections now carry scheme-specific guidance (session → re-capture the
    `splunkd_<port>` cookie; token → create a new one under Settings → Tokens; basic → verify
    the account), and both the notification and chat error surfaces show that instead of the
    tenant/client-ID text, which now only appears for errors without their own remediation.

## 0.21.0 — 2026-06-12

### Added — Power BI without admin consent: Azure CLI SSO (+ pasted-token fallback) (pilot)
- The Microsoft 365 sign-in path requests Power BI scopes through the shared first-party app
  (**"Microsoft Graph Command Line Tools"**), and tenants that gate it demand an admin approval
  pilots can't get. New **recommended** sign-in: **Azure CLI (az) SSO** — each call takes a live
  token from your existing `az login` session (`az account get-access-token --resource
  https://analysis.windows.net/powerbi/api`). The Azure CLI is a Microsoft first-party app
  **already authorized for the Power BI service**, so **no app registration and no per-app
  admin approval** are needed; access stays fully delegated (your licenses, workspace roles,
  and RLS govern everything). Like the gcloud path on Vertex: tokens are never stored — the
  keychain entry is only a marker (Windows `.cmd` shim spawned with a shell per
  CVE-2024-27980; a missing CLI says so instead of failing cryptically).
- **Pasted access token** is now also accepted for machines without the CLI (~1 h lifetime,
  re-paste via *Test Context Source*). The Microsoft 365 path remains for tenants where the
  shared app is approved. *Test Context Source* reports which sign-in path verified
  (Azure CLI SSO / access token / Microsoft 365).

## 0.20.2 — 2026-06-12

### Fixed — Vertex AI Search: Windows gcloud crash + the corporate search-page URL (pilot)
- **"Find my search app via Google SSO" threw `Error: spawn EINVAL` on Windows.** The gcloud
  CLI is a `.cmd` batch shim there, and Node's batch-file hardening (CVE-2024-27980 — in all
  current VS Code runtimes) refuses to spawn `.cmd` files without a shell. gcloud invocations
  (project listing AND every SSO token read) now run with `shell: true` on Windows — only
  fixed, hard-coded argument lists are passed, so nothing user-controlled reaches the shell. A
  missing CLI now says "gcloud not found on PATH — install the Google Cloud SDK or use a
  pasted access token" instead of a spawn error.
- **The corporate search-page URL is now understood.** Users connect via SSO to
  `https://vertexaisearch.cloud.google/<region>/home/cid/<app id>?csesidx=<session>` — a shape
  the wizard previously couldn't parse. Pasting it now pre-fills the **region** (first path
  segment) and **app id** (after `cid/`); the per-browser `csesidx` session id is ignored and
  never stored. The corporate page doesn't carry the hosting project, so the wizard asks for
  exactly that one missing piece (and says where to find it: the app owner or the Cloud
  Console URL's `?project=`).

## 0.20.1 — 2026-06-12

### Fixed — ServiceNow browser-session: full-cookie-set pastes now connect (pilot)
- Pasting the **full set of session cookies** from the browser failed to connect: only a clean
  `name=value; name=value` header string survived the old normalization, so DevTools
  **cookie-table** pastes (tab/newline-separated rows) reached the wire raw — newlines are
  illegal in an HTTP header, so the request failed before it was even sent, surfacing as a
  baffling network error. Pastes are now **normalized from every common shape**: the Cookie
  request header (with/without the `Cookie:` label), the Edge/Chrome Application → Cookies
  table (full set, header row and extra columns dropped), Firefox **Copy-All JSON**,
  one-`name=value`-per-line exports, and Set-Cookie text (attributes like `Path`/`Secure`
  dropped, duplicates de-duplicated). Stored captures are re-normalized at send time, so an
  already-saved bad paste self-heals without re-entry.
- **New diagnostics**: after the paste, the wizard confirms how many cookies were captured and
  their **names** (values are never shown or logged), warning when `JSESSIONID` is missing; a
  rejected session (401/403) now reports exactly which cookie names were replayed plus
  re-capture guidance; and a **200 HTML login page** answer — how an expired cookie session
  usually manifests — is now explained as session expiry instead of "non-JSON content".

## 0.20.0 — 2026-06-12

### Removed — monthly premium-request allowance & estimated-cost tracking (pilot)
- The estimated **premium-unit meter**, the **monthly-allowance gauge** (status bar % and
  dashboard), and the **budget caps** (soft/hard limits, blocking, overrides) are gone: there is
  no automated, authoritative way to read your real allowance or bill, so the locally estimated
  numbers were misleading. The feature returns if an authoritative billing API becomes
  available; until then **your GitHub billing/plan page is the only usage source**.
- What remains is factual and locally measured: the **Copilot Activity** view, status-bar
  counter, and dashboard now show **request counts** (today / this month, failures) with
  per-model token totals and per-task breakdowns — counts of what this extension actually did,
  never billing estimates. Diagnostics bundles carry the same counts.
- Removed settings: `copilot.monthlyPremiumRequestAllowance`, `budget.mode`,
  `budget.softLimitPercent`, `budget.hardLimitPercent`. Removed commands: *Set Copilot Budget*,
  *Open Budget Settings*. *Reset Copilot Usage Meter* is now *Reset Copilot Activity Counters*.
- The economy-first model policy is unchanged (cheapest entitled model by the published
  multiplier table); *List Copilot Models* still shows each model's published multiplier.
- Stored ledgers migrate automatically (estimates are dropped; request/token counts survive).
  ADR-0003 is marked superseded.

## 0.19.1 — 2026-06-12

### Fixed — Splunk: searches no longer fail at the concurrency cap (pilot)
- On the metered Splunk Cloud stack every search failed with Splunk's **concurrency-cap**
  error while the same user's browser session searched fine. Cause: the connector dispatched
  **oneshot** searches, which Splunk rejects outright when its concurrent-search limit is
  saturated — Splunk Web instead dispatches **async jobs that queue** for a free slot. Searches
  now dispatch the same way the browser does: an async job (in the selected app's namespace)
  that may queue, polled within the existing time budget, results fetched on completion, and
  the job **always deleted** afterward (success, failure, or timeout) with an `auto_cancel`
  safety net so no job can be left holding a concurrency slot. If a search is still queued when
  the time budget runs out, the error now says exactly that — the instance is at its
  concurrent-search limit — instead of a generic failure. Rate-limit advice text is no longer
  Microsoft-Graph-specific.

## 0.19.0 — 2026-06-12

### Added — Projects view + goals, reference context, and a separate AI-managed memory (pilot)
- **Discoverable Projects view** in the activity bar: create, switch (click a project to
  activate), edit, and remove — each project expands to show its **goals**, **instructions**,
  **AI-managed context** (note count), and member sources, with the active project marked. The
  Reference Sources header still shows the active project; switching scopes chat and that view.
- **User-defined project context**: a project now carries **goals** (what it's for) and
  **instructions & common reference context** — both shown to @sharepoint while the project is
  active, as clearly-labeled *user-authored* blocks.
- **Separate AI-managed context**: @sharepoint can persist durable learnings — "answer in
  German", "get app ownership from the CMDB" — via the new `#spRemember` tool (you approve each
  note). They're kept in a **distinct AI-managed block** (never mixed with your own
  instructions), carried across sessions, and you can **view, edit, or clear** them via
  *Projects: Manage AI Context* / the AI-context row in the view.
- All of it — goals, instructions, and AI context — travels with **Export/Import Reference
  Config**, so a team shares a complete project (scope + context + learned behavior).

## 0.18.0 — 2026-06-12

### Changed — @sharepoint status reflects what you actually asked (pilot)
- The chat status no longer says "Reading <site>" on every turn. The live site read now
  happens **only when the question is actually about a site** (a site is named, SharePoint is
  your only connected context, or the prompt uses site vocabulary) — so asking about
  Confluence, a database, ServiceNow, etc. no longer triggers a misleading "Reading <site>…"
  (or a wasted Graph call). The model can still pull site data itself via the site tools when
  it decides it's needed.
- **Per-step status for multi-turn operations**: each tool call shows an accurate,
  input-aware line — *"Searching CMDB for …"*, *"Reading CMDB schema for ownership…"*,
  *"Running bookmark …"*, *"Preparing a Teams message to …"*, *"Launching apply-to-SharePoint
  (your approval required)…"* — and rounds are framed ("Working on your request…" →
  "Reviewing what I found and continuing…") so you can follow the steps and tell whether a
  long operation is on track.

## 0.17.0 — 2026-06-12

### Fixed — Splunk Cloud: pick the line-of-business search app (default `search` disabled) (pilot)
- Splunk Cloud instances that disable the default `search` app and meter by a line-of-business
  app rejected dispatch against the default context. Setup now **lists the apps your account
  can see** and has you **pick the search app** to run in; all searches (and saved-search
  browsing, and result deep links) route through that app's **REST namespace**
  (`/servicesNS/-/<app>/…`) so they run under the right workload/billing context. The choice is
  **functionally verified** during setup with a `| makeresults` test dispatch in that namespace
  — if it fails, you're told the default app is likely disabled and can pick a different app
  before saving. "No specific app (default context)" remains for instances where the default
  app is enabled.

## 0.16.1 — 2026-06-12

### Changed — Splunk browser-SSO: clearer per-browser cookie instructions (pilot)
- The session-cookie capture now names the exact cookie — **`splunkd_<port>`** (commonly
  **`splunkd_8000`**, confirmed working in Edge) — and adds a **"How to find the cookie"** step
  with copy-paste instructions for **Edge/Chrome, Firefox, and Safari** (which DevTools tab,
  where Cookies live, copy the Value not the name). The input box and user guide carry the same
  guidance.

## 0.16.0 — 2026-06-12

### Added — ServiceNow browser-session sign-in (no admin OAuth client) (pilot)
- The previous browser sign-in needed an admin-created OAuth client (`servicenow.oauthClientId`)
  that pilots can't get. New **recommended** option **Browser session** needs **no admin
  setup**: sign in to ServiceNow with your SSO in the browser, then paste your session
  **cookies** (`JSESSIONID`, `glide_*`, the `BIGipServer*` load-balancer affinity cookie). The
  read-only Table API honors an active browser session via cookies for GET requests, so the
  extension replays them as a `Cookie` header — your own browser session, nothing issued. Stored
  only in the OS keychain, verified once (lockout-safe); it expires with your ServiceNow session
  and is re-captured the same way via *Test Context Source*. The OAuth-client path remains for
  instances that have one.

### Fixed — "No view is registered with id" after in-place updates
- Some VS Code versions return a live tree-view object for a view whose manifest entry is still
  refreshing right after a VSIX upgrade, then throw when its **badge/description** is set —
  surfacing the raw error. Those post-creation view updates are now swallowed (the view
  self-heals on reload; the existing "reload to finish updating" toast still guides you). Also
  wires the active-**project** name into the Reference Sources view header (the 0.12.0 badge
  whose edit had silently not applied).

## 0.15.0 — 2026-06-12

### Added — Splunk browser-SSO sign-in (no token, no password) (pilot)
- New **recommended** Splunk sign-in option for SAML/SSO enterprises where users can't create
  authentication tokens or use a password: **Browser SSO session**. The wizard opens Splunk
  Web for you to complete SSO in your browser, then you paste your live **session key** (the
  value of the `splunkd_*` session cookie) — the extension uses it against the REST API with
  Splunk's `Authorization: Splunk <key>` scheme, i.e. **your browser's own session**. Stored
  only in the OS keychain, verified once, never auto-retried; it expires with your Splunk
  session — re-capture via *Test Context Source* (lockout-safe). Token and username/password
  remain as alternatives.

## 0.14.0 — 2026-06-12

### Changed — usage is measured, budgets are opt-in (pilot: "300 units" was misleading)
- The monthly allowance **no longer defaults to 300** — it defaults to **not configured**,
  because that number was a local guess, not authoritative. Without an allowance the extension
  shows **only what it measures**: premium units used this month, today's activity, a **rate
  line** (~units/day with a month-end consumption projection), and the by-model / by-task
  breakdowns — **no gauge, no percentages, no caps** (nothing warns or blocks). Status bar,
  Usage view, dashboard, and `/usage` all switch to this usage-only mode. Entering a budget
  (*Set Copilot Budget*) restores the gauge and caps; the UI names your GitHub billing/plan
  page as the authoritative source for the real allowance.

## 0.13.0 — 2026-06-12

### Added — @sharepoint implements sites itself, with you at every checkpoint (pilot)
- The "agent drafts, human applies" gate is lifted by pilot direction: when you ask
  `@sharepoint` to design or change a managed site, it now **does the work** — pulls a baseline
  (`#spPullSite`), **writes the lists/pages spec files into the site repository**
  (`#spWriteSiteFiles` — local only, path-restricted to `lists/*.json` / `pages/*.json`,
  JSON-validated, size-capped), and **launches apply** (`#spApplySite`). Human checkpoints are
  preserved twice over: every tool call needs your in-chat confirmation, and apply still runs
  the full operation preview → freshness gate → safety snapshot → **modal approval** — nothing
  reaches SharePoint until you approve, deletions stay opt-in, and the agent never claims
  success until the approval completes (then verifies with a live read). List content
  (items/documents) remains outside the pipeline and is said so.

## 0.12.0 — 2026-06-12

### Added — Projects: exportable scopes for sources, bookmarks, and agent instructions (pilot)
- **Projects** bundle a set of reference sources (bookmarks follow their sources), an optional
  description, and **baseline instructions** prepended to every `@sharepoint` turn while the
  project is active. Commands: *Projects: Create / Switch / Edit / Remove* (switch also via the
  Reference Sources title bar; the view header shows the active project). With a project
  active, the view, `#spSources`, source resolution, bookmark listings, and the participant's
  context are **scoped to its members** — "All sources" disables scoping. Removing a project
  never deletes sources or bookmarks.
- **Exportable**: projects ride the reference-config export (memberships linked by source
  name, remapped on import; name collisions skipped) — so a team can share a complete,
  scoped working set: sources + aliases + bookmarks + database indexes + project instructions
  in one file.

### Fixed — database indexing shows its metering (pilot)
- Indexing requests were always metered (Usage view → **By task → `schemaIndex` /
  `contentIndex`**), but invisibly. Completion toasts now state the premium units the run
  consumed and where to see them. Note: on included **0× models** (the default-model policy
  picks the cheapest) the unit count is legitimately 0 — requests still appear in By task.

## 0.11.1 — 2026-06-12

### Fixed — Communications failures now name the real cause (pilot: "can't connect to Outlook")
- Failures creating an Outlook draft / sending mail or Teams messages are translated into the
  three enterprise causes with exact remediation: **missing delegated Mail.ReadWrite/Mail.Send
  consent on the app registration** (AADSTS65001 family → Admin Guide §4 steps), **no Exchange
  Online cloud mailbox** for the account (MailboxNotEnabledForRESTAPI — hybrid/on-prem or
  unlicensed), or **conditional-access/app policy blocking the mail scopes**. Generic Graph
  403s point at the consent checklist too.

## 0.11.0 — 2026-06-12

### Changed — database indexing is now two plainly-named options (pilot)
- **Index Database Schema**: one action — reads every table and view the account can access,
  then Copilot writes **descriptive summaries** (tags, synonyms, purposes) to aid search.
  Only names and types are sent; never data.
- **Index Database Content Types** (new): takes a bounded row sample per table, reduces it
  **locally** to the top distinct values per column, and asks Copilot to **describe what the
  values are** ("ISO country codes", "statuses: Active/Retired", "owner names") — so questions
  route on content, not just column names. The consent dialog states plainly that sampled
  values are sent for this option — and that **no database content is persisted**: samples
  exist only for the request; only Copilot's descriptive summaries are stored. Value
  descriptions are searchable and shown to the model alongside tags.
- **Database indexes travel with Export/Import Reference Config**: the schema catalog and the
  Copilot summaries are included per source, so one teammate's (metered) indexing run benefits
  the whole team — recipients still sign in with their own credentials as always.

## 0.10.6 — 2026-06-12

### Fixed — schema indexing shows live progress (pilot)
- Each indexing batch is one long streaming Copilot request — the UI previously went silent
  for its whole duration. Now you see **"waiting for the model… Ns"** ticking until the first
  token, **streamed byte counts** while it writes ("model is writing… 3.2 KB, 24s"), a
  per-batch completion line ("Batch 2/8 done — 38 tables tagged in 42s"), and the
  notification's **progress bar advances per batch**. Cancellation still keeps a usable
  partial index.

## 0.10.5 — 2026-06-12

### Added — ServiceNow browser sign-in (SSO) — no passwords, no hand-issued tokens (pilot)
- New first option in the ServiceNow sign-in picker: **Browser sign-in** — your browser opens,
  your **existing ServiceNow SSO session** authenticates you, and the extension receives an
  OAuth code on `localhost:51725` which it exchanges for access + refresh tokens (PKCE; client
  secret optional). Tokens live in the OS keychain and **auto-refresh** near expiry; wire
  logging withholds all token traffic. One-time admin setup: an Application Registry OAuth
  client with redirect URL `http://localhost:51725/callback`, its ID distributed via the new
  machine-scoped `aiSharePoint.servicenow.oauthClientId`.

### Changed — Splunk setup from the URL you actually know (pilot)
- Enter **the Splunk URL you open in your browser** (e.g. `https://acme.splunkcloud.com`) —
  the wizard derives the management-API candidates (`:8089` on the stack, plus the
  `api.<stack>` form), **verifies them with your sign-in**, and picks the one that answers;
  the browser URL doubles as the pre-filled deep-link target. Manual API entry remains only
  as the fallback (Splunk Cloud may require API access/IP allowlisting).

### Fixed — Error Reports list can be dismissed (pilot)
- The viewer no longer pins itself open on focus loss (that behavior is for data-entry
  wizards, not viewers): click anywhere else or press Esc to close, and an explicit
  **Close** item tops the list.

## 0.10.4 — 2026-06-12

### Changed — ServiceNow setup is "connect, then pick from what you can access" (pilot)
- The wizard now signs in right after the instance URL and **enumerates the tables your
  account can actually read**: the full `sys_db_object` catalog (with labels) where permitted,
  otherwise a live probe of the common ITSM/CMDB set — you pick the default table from a list
  (or "no default") instead of typing names like `incident`. Manual entry remains only as the
  fallback when listing is denied.
- **Browse & Bookmark now enumerates live** too: every readable table appears as a
  recently-updated starter query (default table first) — searchable content reflects your real
  access, not a fixed list.

## 0.10.3 — 2026-06-12

### Changed — Vertex AI Search setup works from just your corporate URL (pilot)
- The wizard no longer assumes you know project/location/app IDs. New first step:
  **"Find my search app via Google SSO"** — your existing gcloud sign-in lists your projects,
  then probes **global/us/eu** for search apps so you simply pick yours from a list (regional
  endpoint set automatically). Manual entry remains, now **paste-anything aware**: any URL you
  have (corporate search page, Cloud Console link, serving config) pre-fills whatever it
  carries, and each remaining field explains where the app owner finds the value.

### Changed — Power BI setup is "confirm the portal, sign in, pick" (pilot)
- No more dataset names/GUIDs to know: confirm `https://app.powerbi.com`, pick your
  Microsoft 365 sign-in, and the connector **enumerates every dataset you can access**
  (My workspace + group workspaces) — choose one as the default for bare-DAX questions, or
  "no default" to target datasets by name per question. Enumeration failures never block
  adding the source.

## 0.10.2 — 2026-06-12

### Fixed — LDAP over VPN: DNS settling window + split-DNS (pilot)
- **Last-good DC memory + SRV retry/backoff**: SRV resolution now retries (2 s, 4 s) before
  failing — bridging the window where a VPN tunnel is up but corporate DNS isn't applied yet —
  and the last domain controller that accepted a connection is remembered per source: tried
  first on every reconnect (faster on slow links) and used as the direct fallback when
  resolution still fails mid-settling. Wire logging shows each retry and fallback.
- **`aiSharePoint.ldap.dnsServers` (machine-scoped)**: pin internal DNS server IPs for SRV
  lookups. Node's resolver bypasses Windows NRPT / VPN split-DNS rules entirely, so pointing
  AD discovery straight at corporate DNS by IP makes it deterministic in office and on VPN.

## 0.10.0 — 2026-06-11

### Added — Splunk connector (read-only SPL, ADR-0029)
- New reference source: **Splunk** (Enterprise or Cloud, management API) — ask in plain
  keywords (searched in the default index over the **last 24 h** by default), raw **SPL**
  (`search index=web error | stats count by host`, `| tstats …`, `| savedsearch "…"`), or JSON
  `{"spl": "…", "earliest": "-7d", "latest": "now", "limit": n}`. Oneshot execution — no job
  lifecycle — with server-side row caps; events map with host/source/sourcetype/index/time and
  optional Splunk Web deep links (`?web=`).
- **Read-only by barrier**: write/exfiltrate/execute SPL commands (`delete`, `collect`,
  `outputlookup`, `outputcsv`, `sendemail`, `sendalert`, `script`, …) are rejected before any
  request — including inside `map`/subsearch bodies. Reads (`inputlookup`, `stats`,
  `savedsearch`) pass.
- Auth: **authentication token** (Settings → Tokens; recommended) or Basic with a
  least-privilege search account — keychain, lockout breaker, caps, caching, and verbose wire
  logging as standard. Browse & Bookmark lists your **saved searches** and non-internal
  **indexes** as starter queries.

## 0.9.0 — 2026-06-11

### Added — ServiceNow connector (read-only Table API, ADR-0028)
- New reference source: **ServiceNow** — incidents, changes, problems, catalog requests,
  **CMDB CIs**, knowledge, users/groups, and custom tables, via the read-only Table API.
  Chat queries take **free text** (text-index search of the source's default table), a
  **native encoded query** (`active=true^priority=1`), or JSON
  `{"table": "cmdb_ci_appl", "query": "…", "fields": […], "limit": n}`; single records fetch
  as `table/sys_id` with display values (reference fields read as names). Browse & Bookmark
  ships a curated ITSM+CMDB starter set — no admin schema access needed.
- Auth: **Basic (least-privilege integration account)** or an **OAuth bearer token**, with the
  standard keychain storage, lockout breaker, caps, caching, and verbose wire logging.

### Changed — Admin Guide refreshed for everything this release wave added
- App-registration scope list now covers **Communications** (`User.ReadBasic.All`,
  `Chat.ReadWrite`, `Mail.ReadWrite`, `Mail.Send`) and **Power BI** (`Workspace.Read.All`,
  `Dataset.Read.All`) delegated permissions with their incremental-consent behavior; endpoint
  allowlist adds `discoveryengine.googleapis.com`, `api.powerbi.com`, and ServiceNow instance
  hosts; connector-specific admin notes (gcloud SSO token handling, schema-indexing policy
  switch, catalog pre-cache throttling, verbose wire logging) and an updated central-settings
  example with the org policy keys.

## 0.8.1 — 2026-06-11

### Added — verbose wire logging across every integration (pilot)
- One switch — **Support & Diagnostics → Verbose Wire Logging** (or
  `aiSharePoint.logging.verboseWire` / *Toggle Verbose Wire Logging*) — writes the **full
  request/response detail of every point of integration** to the AI SharePoint output channel:
  Microsoft **Graph** (SharePoint reads, write-back, Teams/Outlook sends — method, path,
  scopes, bodies, status, timing), **Confluence/Jira** HTTP (URL, headers, response bodies),
  **MSAL sign-in** traffic (URL + status), **LDAP** (bind identity, server, filter, attribute
  list, entry counts), **SQL Server/PostgreSQL/MySQL** (the exact SQL incl. session prefixes,
  row counts, server error frames), **MongoDB** (query spec, document counts), **Vertex AI
  Search** and **Power BI** (request/response payloads), **Copilot** (model, prompt, response,
  token estimates), and every **chat tool call** (name, input, result).
- **Secrets are redacted in layers, fail-closed**: authorization headers reduced to their
  scheme (`Bearer ***`), token-endpoint bodies **withheld entirely** (never logged, never
  trusted to regex), passwords structurally absent (bind/TDS credentials never reach the
  logger), secret-shaped JSON keys masked (`password`/`token`/`secret`/`client_secret`/…),
  credentials and token parameters stripped from URLs, and every line passes the global
  redaction filter that also guards diagnostics exports. Database/LDAP **result data is
  summarized (counts + column names), not dumped**. Payloads are capped at 4 kB per event.
- Local only: wire logs stay in your VS Code log folder and are **never** included in
  diagnostics bundles. Locked with tests that assert credentials cannot reach the log sink.


## 0.8.0 — 2026-06-11

### Added — Power BI (cloud) connector (ADR-0027)
- New reference source: **Power BI** workspaces & datasets with **read-only DAX analysis**
  (`executeQueries`). Chat/bookmark queries take `{"dataset": "<id or name>", "dax":
  "EVALUATE …"}` — datasets resolve by **name** against what your account can see (a typo
  lists the visible inventory); with a default dataset configured, bare DAX works too.
- **No new credential**: Power BI reuses your **Microsoft 365 sign-in** from a connected
  SharePoint site (`aad-sso` — the keychain holds only provider handles, no secret).
  Delegated read-only scopes (`Workspace.Read.All`, `Dataset.Read.All`); your Power BI
  licenses/roles/RLS apply server-side as always.
- **Browse & Bookmark** lists every visible dataset (My workspace + group workspaces) with a
  starter `EVALUATE INFO.TABLES()` bookmark — the discovery step before real DAX. DAX is
  gated (`EVALUATE`/`DEFINE` only, size-bounded) and results are row-capped like every source.


## 0.7.0 — 2026-06-11

### Added — database schema preload + Copilot semantic indexing (ADR-0024)
- Database sources **preload the full schema** the connection can see (INFORMATION_SCHEMA for
  SQL Server/PostgreSQL/MySQL incl. views; MongoDB field names inferred from a small local
  sample whose values are discarded), stored locally and wiped with the source.
- **First use asks the user** to index the schema with Copilot in a generalized format:
  batched, metered requests send table/column **names only — never data rows** — and return
  concept tags + synonyms per column. The canonical example works end-to-end: `group_cio`
  is tagged *ownership*, so *"show me all the records owned by X"* includes that field in an
  ownership search. Consent via modal or in-chat confirmation; budget caps degrade to a
  partial index; `context.allowSchemaIndexing` (policy, machine-scoped) disables it org-wide.
- New tools: `#spDbSchema` (topic → ranked tables/columns with tags/synonyms; built-in
  hints map *owned/owner/who* → ownership even before indexing) and `#spIndexDbSchema`
  (user-approved). Commands: Load/Refresh, Index with Copilot, View Schema (markdown);
  right-click any database source.

### Added — pre-cached Confluence/Jira catalogs with checkpointed loading
- First browse offers to **pre-cache the global catalog** (all spaces / projects + favourite
  filters + JSM queues) for instant local search. Loading is paged with a **"Keep loading?"
  checkpoint every `context.catalogCheckpointSeconds`** (default 15 s) — while the prompt
  waits, no requests are sent, so the source system is never overtaxed; stopping keeps a
  usable partial. The cache **expires** (`context.catalogTtlHours`, default 24 h): expired
  copies offer refresh / use-stale / live-capped. "Pre-cache Source Catalog" re-runs any time.

### Added — Communication Channels: Teams & Outlook with approval-gated sending (ADR-0025)
- Prepare **Teams chat messages and Outlook emails to individuals** (≤10 recipients) — by
  command or by asking `@sharepoint` to draft one (`#spDraftComm`, itself
  confirmation-gated). Drafts wait in the new **Communications** view (badge = pending
  approvals) and **nothing sends until you approve that draft**: full preview opens in the
  editor, a modal names every recipient, and recipients are directory-resolved first (a
  typo aborts with the exact addresses). Outlook also offers **Save to Outlook Drafts**
  (never sends — finish in Outlook). Send-capable Graph scopes are requested only by this
  flow (incremental consent, mirrors write-back).

### Added — Vertex AI Search connector (Google enterprise search, ADR-0026)
- New reference source type for **Vertex AI Search** apps: searches return enterprise hits,
  and the new `#spVertexAnswer` tool returns a **Gemini-grounded answer with citations**
  (the analysis surface). **SSO via the gcloud CLI** — every call uses a live token from
  your existing `gcloud auth login` session, nothing stored; pasted-token fallback for
  machines without the CLI. Field-by-field setup (project → location → app ID → endpoint,
  regional endpoints supported) or paste the serving-config URL whole.

### Added — chat aliases & descriptions for reference sources (ADR-0023)
- Every reference source can carry a short, **unique chat alias** (e.g. `CMDB`) and a one-line
  **description** of its contents — set during add (optional steps) or any time via
  right-click → **Edit Alias & Description**. The Reference Sources view shows the alias on the
  row and both in the tooltip.
- **Copilot understands them everywhere**: `@sharepoint find information about application X in
  the CMDB database` resolves "CMDB" to the right connection. The alias+description ride in the
  participant's context, the `#spSources` output, and every tool's `source` argument
  (alias → display name → type precedence, case-insensitive, word-boundary phrase matching so
  an alias like `DB` never matches inside "database"). Descriptions steer the model to the
  right source when none is named.
- Aliases travel with **Export/Import Reference Config** (allowlisted — still secret-free);
  duplicates in a file or with existing sources are dropped with warnings, never ambiguous.

### Added — editable bookmarks (pilot)
- **Edit Bookmark** (inline pencil, context menu, or palette): rename and **modify the saved
  SQL/JQL/CQL/Mongo spec**, validated read-only for database sources. Browse-to-bookmark now
  lets you tailor the sample SQL before saving; manual adds validate database locators.

### Fixed — pilot reports
- **Usage & budget tiles "not incrementing"**: the meter was right — the default-model policy
  picks **included (0×) models**, which cost no premium units. The UI now says so: gauge note
  + tooltip ("all on included 0× models"), per-model multiplier badges (`0× included`),
  by-task 0× notes, and a dashboard banner. Pick a premium model to consume allowance.
- **Jira browse returned nothing despite queue access**: the JSM queue API on Data
  Center/Server is experimental and 403s without the `X-ExperimentalApi: opt-in` header —
  now sent. Swallowed denials are also surfaced: an empty catalog reports exactly what was
  tried (agent license, no starred filters) instead of a silent empty picker.


## 0.6.5 — 2026-06-11

### Changed — SQL Server setup is now a fully guided, field-by-field wizard (pilot)
- No more connection-string guessing: the wizard prompts for **server FQDN → instance name →
  TCP port → database → certificate handling → sign-in method → username → password**, builds
  the connection URL from the answers, and **live-verifies it** with a single read before
  anything is saved. Pasting the SSMS "Server name" (`server.corp.com\INSTANCE,port`) into the
  first step still pre-fills instance and port. Each step validates inline (port range,
  hostname-not-URL) and explains the SSMS-equivalent behavior (explicit port wins; empty port
  + instance resolves via SQL Browser).
- **Rejections now carry SQL Server's own words**: the TDS `errorMessage` frame (error
  number/state — e.g. *Login failed for user* vs *Cannot open database*) is appended to the
  connection error, so "login works in SSMS" cases are diagnosable in one attempt.
  PostgreSQL/MySQL/MongoDB keep the URL-based entry.

### Fixed — Support & Diagnostics actions (pilot)
- **Error Reports** can be deleted from the view: right-click → **Delete Error Reports**
  (also an inline trash icon), with a count-aware confirmation; the palette command was
  retitled accordingly.
- **Open Extension Logs** reliably reveals the log channel: the Output panel is forced open
  first, then the channel selected — `OutputChannel.show()` alone can silently fail to reopen
  a closed panel (microsoft/vscode#40690 family), which matched the reported "nothing
  happens".
- **Getting Started Walkthrough** opens *our* walkthrough instead of the generic VS Code
  Welcome page: the category ID is built from the runtime extension ID and the open command is
  re-issued against the opened page — the second invocation takes VS Code's
  registration-safe path (microsoft/vscode#187958), making the deep link deterministic.


## 0.6.4 — 2026-06-11

### Added — paste the SSMS "Server name" as-is (pilot)
- The working enterprise form `server.corp.com\INSTANCE,port` (and `server,port`,
  `server\INSTANCE`) is now accepted **directly** in the SQL Server wizard — the database is
  asked next and the connection URL is built automatically. Precedence matches SSMS/SqlClient
  exactly: an explicit **port wins** and connects directly (the instance name is ignored for
  routing — an info note says so); instance-only goes through SQL Browser. The 0.6.3 hard
  error on port+instance was wrong against real-world DBA-provided strings and is replaced by
  this SqlClient-faithful behavior (URL form `?instance=` + `:port` now also legal, port
  preferred, informational note instead of rejection). 8 new assertions (165 tests).


## 0.6.3 — 2026-06-11

### Verified/Hardened — SQL Server on non-standard ports
- Alternate ports were already supported (`mssql://host:14330/Sales`) — now empirically
  verified and **locked with tests** end-to-end (URL → tedious `options.port`; default 1433
  only when no port is given). The sharp edge is handled explicitly: `:port` combined with
  `?instance=` is **rejected at entry** with a clear message (TDS treats them as mutually
  exclusive — a named instance resolves its own port via SQL Browser/UDP 1434) instead of
  silently ignoring the port. User guide documents both forms.


## 0.6.2 — 2026-06-11

SQL Server SSMS-parity + wizard usability (pilot feedback).

### Fixed/Added — SQL Server connections match what works in SSMS
- **Both authentication modes**: SQL Server Authentication (database logins) and **Windows
  Authentication** via pure-JS NTLM (`CORP\\user` or `user@corp.example` + password) — chosen
  explicitly in the wizard; Windows-shaped accounts entered under SQL auth are safely inferred
  to NTLM (SQL logins cannot contain `\\`). Passwordless integrated SSO is not possible in a
  portable extension and is documented as such.
- **Named instances**: `?instance=PROD` (SSMS `host\\PROD`) — the port is resolved via SQL
  Browser; a verified-in-SSMS login that "fails" here was often hitting the wrong instance on
  1433.
- **Certificate trust option**: a wizard step (and `?trustServerCertificate=true`) skips TLS
  validation per source — the SSMS "Trust server certificate" equivalent for self-signed
  certificates **and certificates that don't match the FQDN** used to connect. Default remains
  full validation.
- **Diagnosable rejections**: ELOGIN now carries the server's own reason; "cannot open
  database" is distinguished (config guidance, not a lockout-counting credential failure); the
  advice walks the SSMS-works-but-connector-fails triage (instance → auth mode → database).

### Fixed — wizards survive switching apps to copy values
- Every multi-step dialog (connect site, add context source, credentials, repo configure,
  budget, bookmarks, diagnostics export) now sets `ignoreFocusOut` — changing focus to another
  application to copy the next value no longer dismisses the flow and loses progress.


## 0.6.1 — 2026-06-11

### Fixed — "Could not initialize a Git repository" (pilot)
- Root-cause class: VS Code's Git extension can create a repo on disk yet decline or delay
  opening it — Restricted Mode, a target folder **outside the current workspace**, or the
  extension's asynchronous repository scan. The flow is now hardened end-to-end:
  **workspace-trust guard** with explicit remediation; **retry-with-backoff discovery** after
  `init` (plus a repository-map scan by path); and when `.git` exists but VS Code won't open
  it, a targeted message ("add the folder to your workspace") instead of a bare failure. The
  configure wizard now also detects an out-of-workspace folder up front and offers
  **"Add to Workspace and Continue"**, which makes Git detection deterministic. Failure
  messages now include the underlying git error and a PATH/`git.enabled` checklist.


## 0.6.0 — 2026-06-11

The **database wave** of the reference-source matrix (ADR-0022), chosen by the pilot, plus a
pilot-blocking sync UX fix.

### Added — database context sources (read-only)
- **SQL Server, PostgreSQL, MySQL, MongoDB** adapters (Oracle excluded: native-binary driver vs
  the portable-VSIX rule). Connection URLs are non-secret descriptors; credentials live in the
  keychain; auth rejections feed the lockout breaker.
- **Read-only by layered construction**: an adversarially-tested SQL guard (single
  SELECT/WITH; DML/DDL/EXEC/SELECT-INTO/WAITFOR/multi-statement blocked — the write-barrier on
  SQL Server, which has no read-only session), server-side read-only sessions on
  PostgreSQL/MySQL, READ UNCOMMITTED + readOnlyIntent on MSSQL, secondaryPreferred + maxTimeMS
  on MongoDB, row caps and timeouts everywhere. MongoDB reads take a JSON find spec.
- **Browse & Bookmark for databases**: tables (INFORMATION_SCHEMA) / collections become capped
  sample-row query bookmarks; `@sharepoint`/agent can query engines via the same search tool
  and propose bookmarks (approval-gated).
- TLS for database sockets trusts the OS store + the shared pinned CA bundle; `mongodb+srv://`
  gives Mongo the durable DNS-locator behavior. Drivers verified pure-JS (native gate: 101
  packages); optional native probes externalized from the bundle. 8 new tests (154 total).

### Fixed — GHES allowlisting dead-end at configure time
- Pilot blocker: entering `github.corp.com` failed with "ask your administrator". The egress
  control is unchanged, but configure-time validation now offers a confirmed one-click
  **"Allow <host> and Continue"** (updates the machine-scoped allowlist — the same privilege as
  editing settings manually) plus an **Open Setting** path. Push-time re-validation stays strict.


## 0.5.0 — 2026-06-11

Bookmark discoverability + agent-proposed bookmarks (pilot feedback).

### Added — guided Browse & Bookmark
- **Browse Source & Add Bookmark…** (inline bookmark button on every source row): pick directly
  from the source's catalog — **Jira JSM queues** (each saved with its own JQL), **favourite
  filters**, and **projects**; **Confluence spaces** (saved as recent-content queries) — or
  search first and bookmark either the query itself or one specific result (issue, page, or
  LDAP entry). Jira search hits now carry the issue key so picked results bookmark cleanly.
- A dedicated **Bookmarks** section in the user guide (the 0.3.0 feature existed but was
  context-menu-only and undocumented — discoverability fixed).

### Fixed — @sharepoint can now actually use reference sources (tool calling)
- Pilot finding: asking `@sharepoint` to *"search Confluence sites to aggregate relevant
  content…"* produced answers with no Confluence data. Root cause: the chat participant made a
  plain model request — the extension's tools were only available in Copilot **agent mode**,
  never when addressing `@sharepoint` directly. The participant now declares all nine tools on
  every request and runs a **tool-calling loop** (up to 4 rounds): the model searches
  Confluence/Jira/LDAP, reads items, runs bookmarks, and synthesizes — with per-round metering,
  the budget hard-cap re-checked between rounds, tool denials/failures fed back to the model
  gracefully, and the chat's `toolInvocationToken` passed through so **suggest-bookmark
  confirmations render right in the conversation**. The model's context now also inventories
  your reference sources and saved bookmarks, and `/help` shows the research workflow.

### Added — agent-suggested bookmarks (human-approved)
- New tool **`#spSuggestBookmark`**: in agent mode, Copilot can search Confluence/Jira/LDAP,
  identify recurring queries or items worth keeping, and **propose** them as bookmarks. The
  proposal renders in VS Code's tool-confirmation UI (name, source, exact locator, reason) and
  **nothing persists unless you approve**. The search tool's description nudges the agent
  toward this workflow.
- 4 new unit tests (146 total) covering spaces/filters/queues mapping and non-JSM fallback.

## 0.4.1 — 2026-06-11

LDAP/Active Directory fixes from enterprise pilot feedback (ADR-0020 amendment).

### Changed — durable DNS-based endpoints
- DNS-discovered AD sources no longer pin the specific server DNS returned at add time.
  The source now stores the **SRV lookup itself** — `ldaps+srv://_gc._tcp.<domain>` (Global
  Catalog) or `ldaps+srv://_ldap._tcp.dc._msdcs.<domain>` (Domain Controllers) — and
  **re-resolves it on every connection** with priority/weight ranking and bounded failover, so
  connections stay valid as domain controllers are added, renamed, or retired. The add-source
  picker offers these durable endpoints (individual servers appear only as "currently resolves
  to" information); manual entry of a specific server remains available and is labeled as
  pinned. Failover applies to **network errors only** — a rejected credential is never re-sent
  to another DC (lockout protection, ADR-0009). Durable locators travel in reference-config
  exports, so shared team configs survive infrastructure changes too.
- Existing sources pinned to a specific server keep working unchanged; re-add via discovery to
  switch them to the durable locator.

### Changed — UI clarity
- The activity-bar **"Sites"** view is renamed **"SharePoint Sites"** — with Confluence, Jira,
  and LDAP/AD reference sources in the same container, the unqualified name was ambiguous.

### Fixed — LDAPS trusts the operating-system trust store
- Pilot finding: `LDAP error: unable to get local issuer certificate`. LDAP is raw TLS (it
  bypasses VS Code's patched networking), so internal-CA certificates failed against Node's
  bundled roots. LDAPS/StartTLS now trusts, in addition to Node's defaults: the **OS trust
  store** (Node's system-CA API, feature-detected), standard Linux CA bundles,
  `NODE_EXTRA_CA_CERTS`, and a new machine-scoped admin setting
  **`aiSharePoint.ldap.caCertificatesFile`** (PEM bundle) for deterministic behavior on any
  runtime. Certificate failures now classify distinctly with that remediation in the message.
  `tlsRejectUnauthorized` remains default-true.
- 11 new unit tests (142 total): locator parsing/ranking/port mapping, per-connection SRV
  re-resolution, network-only failover boundary, PEM splitting, trust-source layering/dedup.

## 0.4.0 — 2026-06-11

**SharePoint write-back** lands (ADR-0021) — the repo → site direction of PLAN §7 — plus
**revert-to-commit** (ADR-0005) and **secret-free reference-config sharing** (ADR-0013). With
this release every roadmap pillar that can be built and verified without a live tenant ships.

### Added — write-back (ADR-0021)
- **Apply Repository to SharePoint (write-back)…** on managed connections: edits to
  `lists/*.json` / `pages/*.json` (hand-written or assistant-drafted), once committed, are
  planned as artifact-level operations — create/update lists, add/update columns, create/update
  modern pages incl. web-part canvas, publish — previewed in full and applied only on explicit
  confirmation. Conservative semantics: **deletions are a separate per-push opt-in**, system
  libraries are never deleted, renames and column deletion/retyping are out of scope (flagged),
  lookup/calculated columns are warnings (manual setup).
- **Safety pipeline on every push**: clean-tree guard (uncommitted edits refuse write-back) →
  **freshness gate** (live site re-serialized and compared byte-identically to the plan's base —
  any drift aborts) → **safety snapshot** of the pre-push live state committed to
  `.aisharepoint/snapshots/<stamp>/` → sequential apply with stop-on-first-error → **reconcile
  pull + commit** so the repo always ends equal to the live state. Partial failures preserve
  intent in commit history.
- **Write scopes only at write time**: reads keep `Sites.Read.All`; the first write requests
  delegated `Sites.ReadWrite.All` + `Sites.Manage.All` (incremental consent; admin guide
  documents pre-consent). Engine is Microsoft Graph v1.0 — no new dependencies (ADR-0021 amends
  the PnPjs plan; PnPjs re-scoped to nav/theme later).
- **The AI stays read-only**: chat/tools draft repo edits and point to the human-approved flow;
  they cannot apply changes.

### Added — revert to commit (ADR-0005)
- **Revert Site to Commit…**: pick any snapshot commit from the repo history; the file inventory
  at that ref is read from the committed manifest and run through the same write-back pipeline —
  preview, deletions opt-in, freshness gate, and a fresh safety snapshot that makes the revert
  itself revertible ("undo the undo").

### Added — reference-config sharing (ADR-0013)
- **Export Reference Config (secret-free)…** / **Import Reference Config…**: share Confluence/
  Jira/LDAP source descriptors (including the working auth method, ADR-0015) and bookmarks with
  the team. Secret-free **by construction** (explicit field allowlist, no keychain code path, no
  accounts/ids) plus a leak scan before write; import regenerates ids, skips name collisions,
  and prompts recipients to verify with their own credentials.

### Notes
- 12 new unit tests (131 total): push planner round-trip (serialize → parse → empty plan),
  placeholder-id resolution, stop-on-first-error, deletions opt-in, freshness gate, export
  forbidden-key/leak-scan assertions, import validation.
- Live-tenant pilot validation required for the Graph write endpoints (canvas PATCH behavior
  varies by tenant ring) — same posture as all adapters; diagnostics export is the channel.

## 0.3.0 — 2026-06-11

Enterprise test candidate: a read-only **LDAP / Active Directory** connector with DNS
auto-discovery, plus **bookmarks** for reusable reference queries.

### Added — LDAP / Active Directory connector (ADR-0020)
- **DNS auto-discovery**: derives the AD domain from the workstation
  (`USERDNSDOMAIN`/`LOGONSERVER`/host FQDN/`resolv.conf`) and resolves standard AD **SRV**
  records (`_gc._tcp.<domain>` global catalog, `_ldap._tcp.dc._msdcs.<domain>` domain
  controllers), ranked by priority/weight, base DN derived as `DC=…`. **AI SharePoint: Discover
  Active Directory (DNS)** shows results; the add-source wizard offers discovered endpoints with
  manual fallback. No server addresses are hard-coded.
- **Read-only queries** via `ldapts` (pure-JS, native-gate clean): simple bind with your own AD
  account; free text uses AD **ANR** (matches name/login/email), raw LDAP filters pass through;
  fetch an entry by DN. Server-side size + time limits, a curated non-sensitive attribute set
  (never password attributes), bind + search only — no write path. Agent tools `#spSearchContext`
  / `#spContextItem` work against AD.
- **Account-lockout protection (ADR-0009) is enforced for AD**: an `invalidCredentials` bind is
  classified as an auth failure, never auto-retried, and trips the breaker before the AD lockout
  threshold.
- **TLS**: LDAPS (636/3269) preferred; `aiSharePoint.ldap.tlsRejectUnauthorized` (default true)
  and `aiSharePoint.ldap.useStartTls`. LDAP is direct TCP to the DC (not proxied) — documented,
  with internal-CA guidance in the Admin Guide.

### Added — bookmarks (ADR-0010)
- Save named, reusable **queries or item locators** per reference source (CQL/JQL/LDAP filter, or
  a page id / issue key / DN). The Reference Sources view is now two-level (sources → bookmarks);
  click to run. Commands: **Add / Run / Remove Bookmark**. Agent tools: `#spBookmarks` (list),
  `#spRunBookmark` (run by name). Locators only — never credentials.

### Notes
- Navigation/theme serialization for site repos is **deferred**: it requires SharePoint REST with
  a different token audience that can't be validated in this build environment (see
  `docs/ROADMAP_STATE.md`). The serializer is ready to accept it when that read path lands.
- 25 new unit tests (106 total). LDAP/AD and bookmark live paths are unit-tested + API-verified;
  validate against a real DC during the pilot (same posture as the Confluence/Jira adapters).

## 0.2.0 — 2026-06-11

Two roadmap pillars land in their first production slices: **SharePoint-as-code (Git pull)**
and the **read-only context-source framework** with Confluence + Jira. Work was built in
restartable increments tracked in `docs/ROADMAP_STATE.md`.

### Added — site repositories (Track B, ADR-0019)
- **Configure Site Repository (Git)…** per managed connection: local repo (auto-init),
  optional remote on **GitHub.com or GitHub Enterprise Server**, review gate (**PR-gated**
  default or direct push), and best-practice hygiene files (`.gitattributes` LF normalization,
  `.gitignore`, generated-content README).
- **Pull Site to Repository**: deterministic serialization of site structure (lists + columns,
  modern pages + web-part canvas, manifest) — preview first, apply on confirm, structured
  commit. Re-pulling an unchanged site produces **no diff**. Pulls refuse to write on embedded
  credential-shaped content or files past GitHub's 100 MB limit (warn at 50 MB).
- **Push Site Repository to GitHub/GHES** via the user's own git (VS Code Git extension — the
  extension holds no Git credentials, never force-pushes). PR-gated pushes create
  `sharepoint-sync/<timestamp>` branches and open the compare/PR page (works identically on
  GHES). **Egress control:** remotes restricted to the machine-scoped
  `aiSharePoint.sync.allowedRemoteHosts` allowlist (default `github.com`), re-validated at
  every push.

### Added — reference sources (Track A, PLAN §9)
- **Confluence and Jira adapters** (Cloud + Data Center): API-token/Basic and PAT auth,
  verify-on-connect with a single deliberate read, CQL/JQL/free-text search, page/issue fetch
  with plain-text bodies.
- **Reference Sources view** with add/test/remove, lockout indication, and cache clearing.
- **Account-lockout protection (ADR-0009)**: rejected credentials are never auto-retried;
  exponential backoff between user retries; a circuit breaker freezes the source after 3
  consecutive auth failures until an explicit, warned reset. Network errors never count.
- **Read-safety (ADR-0011/0012)**: TTL result cache (default 15 min) and result caps,
  configurable via `aiSharePoint.context.cacheTtlMinutes` / `context.maxResults`.
- **3 new agent tools**: `#spSources`, `#spSearchContext`, `#spContextItem` — read-only,
  stored-credential only, cached and capped.
- 24 new unit tests (86 total), covering the serializer no-diff invariant, remote allowlist,
  lockout state machine, cache, and adapters.

## 0.1.1 — 2026-06-11

Fixes from the first round of enterprise pilot feedback.

### Fixed
- **Sign-in behind corporate proxies / TLS inspection.** MSAL's default HTTP client bypassed VS
  Code's networking, so token requests failed with `ClientAuthError: network_error` wherever a
  proxy or TLS-inspection appliance sat in the path. Both sign-in providers now route through a
  fetch-based network client, so *all* extension traffic (sign-in and Graph alike) honors VS
  Code's proxy settings (`http.proxy` / system proxy) and the operating-system trust store
  (`http.systemCertificates`). Network errors now include proxy-specific remediation advice, and
  the Admin Guide §3 documents the full proxy/TLS-inspection posture.
- **Walkthrough "Install GitHub Copilot" link.** The link now reliably opens the **GitHub
  Copilot Chat** extension page (with a marketplace search for "github copilot chat" as
  fallback), names the correct extension, and the step **auto-completes** when Copilot Chat is
  already installed or a sign-in is detected.

### Added
- **Copilot status detection.** The extension tracks whether Copilot Chat is installed and
  whether Copilot models are available (signed in + entitled), exposed as context keys. The
  Usage & Budget view now shows guided setup states ("install Copilot Chat" / "sign in to
  GitHub") instead of zeroed counters when Copilot isn't ready.
- New commands: **AI SharePoint: Install GitHub Copilot Chat** and **AI SharePoint: Check
  Copilot Status** (guided verification of install + sign-in + model availability).

## 0.1.0 — 2026-06-11

First deployable release: the governed foundation (auth, chat/agent surface, cost governance,
operability) on top of the Phase 0 spike. SharePoint access is **read-only** in this release.

### Added
- **`@sharepoint` chat participant** with `/site`, `/sites`, `/usage`, `/help`, live site context
  (silent-auth only), conversation history, and budget-aware responses.
- **Language Model Tools** for Copilot agent mode: `#spConnections`, `#spSiteOverview`,
  `#spPages`, `#spUsage` (all read-only).
- **Device-code sign-in** (`msal-device-code`) for VDI/remote/locked-down environments, sharing
  the per-tenant keychain cache with the browser flow.
- **Custom Entra app support** (`aiSharePoint.auth.clientId`) plus sovereign-cloud site URLs
  (`.sharepoint.us`, `.sharepoint.cn`) and an authority-host allowlist.
- **Budget guardrails**: soft cap (warn) and hard cap (block, with explicit per-request
  override), `budget.mode` = `block` | `warn` | `off`, economy-first default model policy,
  pre-flight token/unit estimates.
- **Activity-bar container** with three views: **Sites** (test/open/copy/role/sign-out/remove),
  **Usage & Budget** (gauge, today, per-model, per-task), **Support & Diagnostics** (export,
  error reports with badge, logs, guides, privacy notice, ID rotation).
- **Usage Dashboard** webview: 30-day SVG chart, budget bar with cap markers, model/task tables,
  strict CSP, fully theme-aware.
- **Anonymized diagnostics export** (ADR-0018): local-only usage counters + redacted error
  reports → JSON + Markdown bundle with salted-hash pseudonyms, full preview, and a blocking
  leak scan before anything is written. Anonymous install ID is rotatable.
- **Central redaction layer** applied to all logs and captured errors (JWTs, bearer/basic
  credentials, emails/UPNs, GUIDs, tenant hostnames, IPs, user paths, secret querystrings).
- **Getting-started walkthrough** (5 steps with illustrations), marketplace icon, welcome views.
- **Quality gates**: 42 unit tests (`node:test`), native-dependency gate (ADR-0016), repo secret
  scan, GitHub Actions CI that typechecks, tests, scans, and packages the VSIX.

### Changed
- Usage ledger compacted to per-day aggregates with a capped recent tail (was: unbounded array);
  failed/cancelled requests are now metered too (they are billed at send time).
- Site connections moved to user-level (global) storage with one-time migration; MSAL cache is
  now keyed **per tenant** so one sign-in serves all of a tenant's sites.
- `Ask Copilot` shows the model, a token estimate, and streams into a dedicated output channel.
- Status-bar gauge gained budget-state coloring and a rich tooltip.
- Auth settings are machine-scoped and validated (HTTPS + known Microsoft login hosts only);
  declared under `capabilities.untrustedWorkspaces.restrictedConfigurations`.
- Loopback sign-in pages are static and parameter-free (no reflected content).

### Security
- Sign-out and connection removal wipe the tenant's MSAL cache from the OS keychain.
- Webview hardened: `default-src 'none'`, nonce'd style/script, no external resources.
- See [SECURITY.md](docs/SECURITY.md) for the full posture.

## 0.0.1 — 2026-06-10

Phase 0 spike: Copilot metering via `vscode.lm`, MSAL interactive sign-in, site resolution via
Microsoft Graph, usage status bar, plan + 17 ADRs.
