# AI SharePoint — User Guide

This guide covers everything in release **0.4.0**. If you only read one section, read
[Quick start](#quick-start); if something breaks, jump to
[Troubleshooting](#troubleshooting) and [Getting help](#getting-help-diagnostics-export).

**Changes to SharePoint are always human-approved.** The assistant itself is read-only — it
reads sites, answers questions, and drafts changes as repo file edits. Since 0.4.0 you can
**apply** a site repository back to SharePoint (lists, columns, modern pages) and **revert** a
site to any earlier commit — every write is previewed, freshness-checked, and snapshot-guarded.
Navigation/theme and AI-autonomous provisioning remain on the roadmap (see `docs/PLAN.md`).

---

## Contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Quick start](#quick-start)
4. [Connecting SharePoint sites](#connecting-sharepoint-sites)
5. [The activity-bar views](#the-activity-bar-views)
6. [Chatting with @sharepoint](#chatting-with-sharepoint)
7. [Agent-mode tools](#agent-mode-tools)
8. [Site repositories: SharePoint as code](#site-repositories-sharepoint-as-code-git) — pull, write-back, revert
9. [Reference sources](#reference-sources-confluence--jira) — Confluence, Jira, LDAP/AD, sharing
10. [Projects](#projects-scope-sourcesbookmarks-and-give-sharepoint-goals--memory) — scopes, goals/instructions, AI-managed memory
11. [Copilot activity and the dashboard](#copilot-activity-and-the-dashboard)
12. [Getting help: diagnostics export](#getting-help-diagnostics-export)
13. [All commands](#all-commands)
14. [All settings](#all-settings)
15. [Troubleshooting](#troubleshooting)
16. [FAQ](#faq)

---

## Requirements

| Requirement | Why |
|---|---|
| VS Code **1.95+** | Language Model & Chat APIs |
| **GitHub Copilot Chat** extension (marketplace search: “github copilot chat”), signed in | All AI features run through *your* Copilot entitlement — the extension has no AI keys of its own. Run **AI SharePoint: Check Copilot Status** to verify install + sign-in |
| A Microsoft 365 account with SharePoint access | Site features; read permission on the sites you connect |
| Network access to Microsoft endpoints | See the [Admin Guide](ADMIN_GUIDE.md#3-network-endpoints) for the exact allowlist |

The extension is pure JavaScript — one VSIX runs on macOS, Windows x64, Windows ARM, and Linux.

## Installation

**From a VSIX file** (typical in enterprises):

1. Get the `ai-sharepoint-<version>.vsix` from your IT portal or the project's CI artifacts.
2. In VS Code: **Extensions** view → `…` menu → **Install from VSIX…** — or run
   `code --install-extension ai-sharepoint-<version>.vsix`.
3. Reload when prompted. A new **AI SharePoint** icon appears in the activity bar.

Your administrator may also publish it through a private extension gallery — then it installs
like any marketplace extension.

## Quick start

1. Click the **AI SharePoint** activity-bar icon → **Connect a Site** (or run
   `AI SharePoint: Connect SharePoint Site` from the Command Palette).
2. Enter your site URL, pick a **role** and a **sign-in method** (see next section), and
   complete the Microsoft sign-in.
3. Open **Chat** and type `@sharepoint /site` — you'll get a live overview of your site.

The interactive walkthrough (`AI SharePoint: Open Getting Started Walkthrough`) repeats these
steps with illustrations.

## Connecting SharePoint sites

`AI SharePoint: Connect SharePoint Site` walks three steps:

**1 — Site URL.** Any SharePoint Online site you can open in a browser, e.g.
`https://contoso.sharepoint.com/sites/Marketing`. Commercial (`.com`), GCC High (`.us`) and
21Vianet (`.cn`) clouds are accepted.

**2 — Connection role.**

| Role | What it enables |
|---|---|
| **managed** | Chat/tools reads **plus** the full site-as-code lifecycle: pull to Git, write-back, revert |
| **reference** | Read-only forever — chat/tool context only; sync and write-back refuse it |

Pick *reference* for sites you only want the assistant to read. Roles can be changed any time
from the SharePoint Sites view context menu.

**3 — Sign-in method.**

| Method | Use when |
|---|---|
| **System browser** (recommended) | Normal desktops. Opens your browser; supports SSO, MFA, conditional access. |
| **Device code** | VDI/thin clients, remote dev hosts (SSH/WSL/containers), or when the browser flow is blocked. You get a short code to enter at `https://microsoft.com/devicelogin` on any device. |

Both methods cache tokens **per tenant** in your OS keychain, so connecting a second site in the
same tenant won't ask you to sign in again. Sign-in is per machine and per user; nothing is
shared.

> **Tenant blocks the sign-in app?** Some organizations disable the Microsoft first-party app
> this extension uses by default. Your admin can allow it, or register a custom app and set
> `aiSharePoint.auth.clientId` — see the [Admin Guide](ADMIN_GUIDE.md#4-entra-id-options).

## The activity-bar views

### SharePoint Sites
One row per connection — icon shows the role (cloud = managed, eye = reference) and color shows
verification state (green = verified, yellow = not yet signed in / signed out). Hover for URL,
account, and last-verified time. Click a row to open the site in your browser.

Context menu (right-click): **Test Site Connection** · **Copy Site URL** · **Change Connection
Role** · **Sign Out** (wipes the tenant's cached tokens from the keychain) · **Remove
Connection** (also wipes tokens unless another connection uses the same tenant).

### Reference Sources
Your read-only context: Confluence, Jira, LDAP/AD, databases, Vertex AI Search, Power BI,
ServiceNow, Splunk. Add (+), test, browse & bookmark, schema tools, and the ER diagram all live
here — see [Reference sources](#reference-sources-confluence--jira). When a project is active,
the view header shows it and the list is scoped to that project's sources.

### Projects
Group reference sources into a named scope, give @sharepoint **goals** and **instructions**,
and let it keep a separate **AI-managed context** it learns over time — see
[Projects](#projects-scope-sourcesbookmarks-and-give-sharepoint-goals--memory). Click a project
to activate it; the active project scopes chat and the Reference Sources view.

### Copilot Activity
Factual, locally measured counts of the requests this extension made: today / this month, plus
expandable **By model** / **By task** breakdowns (with token totals). The title-bar button opens
the dashboard. Premium-request consumption against your plan is **not** estimated — your GitHub
billing/plan page is the authoritative source.

### Communications
Teams/Outlook drafts waiting for **your** approval — nothing sends without it (the badge counts
pending drafts). Draft yourself or ask @sharepoint to prepare one.

### Support & Diagnostics
Everything operational: **Export Diagnostics Bundle**, **Error Reports** (the view badge shows
the count; **right-click → Delete Error Reports** to clear them, with confirmation), extension
**logs**, **Verbose Wire Logging** (below), the **walkthrough**, this **user guide**, the
**privacy notice**, and **Rotate Anonymous Install ID**.

> **Don't see one of these views?** VS Code remembers per-view visibility: right-click the
> **AI SharePoint** activity-bar header and re-check any unchecked view (sections can also be
> collapsed to a thin header at the bottom — click to expand). After an extension update,
> reload the window when prompted so newly added views register.

#### Verbose wire logging — see exactly what crossed each integration

Click **Verbose Wire Logging** in the Support view (or run *Toggle Verbose Wire Logging*) and
the AI SharePoint log shows every integration's traffic as `[wire:…]` lines — request (`→`),
response (`←`), failure (`✗`) — with method/target, status, timing, and capped payload detail:
Graph (SharePoint/Teams/Outlook), Confluence/Jira, MSAL sign-in, LDAP binds & searches, the
exact SQL sent to databases (with the server's error frames), MongoDB specs, Vertex AI Search,
Power BI, Copilot prompts/responses, and each chat tool call. **Secrets never appear**: auth
headers are masked to their scheme, sign-in/token bodies are withheld entirely, passwords are
structurally never logged, secret-shaped fields are scrubbed, and database/directory **result
data is summarized (counts + columns), not dumped**. It's local-only, excluded from diagnostics
bundles, and intentionally noisy — turn it off after debugging.

## Chatting with @sharepoint

Open the Chat view and address `@sharepoint`:

```
@sharepoint what's on my Marketing site?
@sharepoint /site Marketing
@sharepoint draft a landing-page outline for our product catalog
@sharepoint /usage
```

- **Site context is automatic — when the question is about a site**: if you reference a
  connected site (by URL or name) or use SharePoint vocabulary, the assistant reads the site's
  lists and pages live and answers from real data. Questions aimed elsewhere (Splunk, a
  database, ServiceNow, …) skip the site read entirely — no reflexive *"Reading <site>…"* —
  and the assistant fetches site data itself if the conversation turns to it.
- **Every step narrates**: rounds show the model and step (*"Asking GPT-4.1…"*, *"Step 2: …
  reviewing the results…"*), each tool call shows an input-aware line (*"Searching CMDB for
  …"*), and each completed call reports what came back (*"Search of CMDB: 12 result(s) —
  continuing…"*), so long multi-tool turns are followable end to end.
- **Reference sources are searchable in chat**: ask things like _“search Confluence for content
  about AI automation and aggregate what's relevant”_ — the assistant calls the same read-only
  tools available in agent mode (search, fetch item, run bookmark), shows each step, and can
  end by **proposing bookmarks** for the queries worth keeping (you approve in a confirmation
  dialog). Each model round is counted in the Copilot Activity view.
- **Sign-in is never triggered from chat.** Context reads use cached credentials only; if the
  cache has expired, the assistant tells you to run *Test Site Connection* instead of popping a
  browser window mid-conversation.
- The model is whatever you've selected in the chat model picker; every request uses your own
  Copilot subscription.

Slash commands: `/site <url or name>` · `/sites` · `/usage` · `/help`.

## Agent-mode tools

In Copilot **agent mode**, these read-only tools are available — Copilot invokes them
automatically when relevant, or you can `#`-reference them in any chat prompt:

| Tool | What it returns |
|---|---|
| `#spConnections` | Your configured connections (name, URL, role, verified) |
| `#spSiteOverview` | Site title/description + lists/libraries + pages |
| `#spPages` | Modern pages with URLs and last-modified times |
| `#spUsage` | This extension's request activity (local counts) |
| `#spSources` | Your configured reference sources (Confluence/Jira) |
| `#spSearchContext` | Search a reference source (text, CQL, or JQL) |
| `#spContextItem` | One Confluence page (by id) or Jira issue (by key) |

Example: *“Using #spSiteOverview, write a one-paragraph summary of the Marketing site for our
newsletter.”*

Tools never write to SharePoint and never trigger interactive sign-in.

## Site repositories: SharePoint as code (Git)

Managed connections can mirror their site's structural "code" into a local Git repository and
push it to **GitHub.com or your corporate GitHub Enterprise Server** (ADR-0019). This release
ships the **pull direction** (SharePoint → repo); pushing changes back into SharePoint is the
next roadmap phase.

**1. Configure** — right-click a *managed* site → **Configure Site Repository (Git)…**: pick a
folder (a Git repo is initialized if needed), optionally a remote (the host must be on your
admin's allowlist — `github.com` by default), and a review gate:

| Gate | Behavior |
|---|---|
| **PR-gated** (recommended) | Pushes go to a `sharepoint-sync/<timestamp>` branch and the pull-request page opens — your branch protections and reviews apply |
| **Direct push** | Pushes the base branch directly |

The extension also drops best-practice hygiene files into the repo: `.gitattributes` (LF
normalization keeps snapshots identical across Windows/macOS/Linux), `.gitignore`, and a README
marking the content as generated.

**2. Pull** — **Pull Site to Repository**: the live site (lists + columns, modern pages +
web-part canvas) is serialized deterministically into `lists/*.json`, `pages/*.json`, and a
manifest. You get a **preview** of added/updated/removed files first; nothing is written until
you confirm, then the change is committed with a structured message. Re-pulling an unchanged
site produces **no diff** — Git history shows only real site changes. Pulls are blocked if
credential-shaped content (tokens/keys) is found embedded in site data, or any file exceeds
GitHub's 100 MB limit.

**3. Push** — **Push Site Repository to GitHub/GHES**: re-validates the remote host against the
allowlist, then pushes per your review gate. Authentication is your own Git setup (credential
manager / SSH) — the extension never handles Git credentials and never force-pushes.

**4. Write back** — edit the repo files (or have `@sharepoint` draft the edits), **commit**,
then run **Apply Repository to SharePoint (write-back)…**. You get an operation-level preview
(create/update lists, columns, pages); deletions are a separate, explicit opt-in and system
libraries are never deleted. Before writing, the live site is **re-checked for drift** (if
someone changed it since your preview, the push aborts) and a **safety snapshot** of the
pre-push state is committed to `.aisharepoint/snapshots/`. Operations apply in order and stop
at the first error; afterwards the repo is reconciled with the live state. First write asks for
consent to the write scopes (see Admin Guide).

**5. Revert** — **Revert Site to Commit…** picks any earlier snapshot commit and runs the same
pipeline to make the live site match it (ADR-0005): same preview, same deletions opt-in, and the
safety snapshot makes the revert itself revertible.

> Not serialized (roadmap): navigation, theme, list items/documents, permissions — listed in
> every preview. Renames and column deletion/retyping are out of scope (flagged, manual).

## Reference sources: Confluence & Jira

Connect **read-only** context the assistant can search alongside SharePoint — Confluence and
Jira, Cloud or Data Center (more source types are roadmap).

- **Add** (Reference Sources view → `+`): pick type and deployment, enter the base URL, then a
  credential — Cloud uses your **email + API token** (create one at id.atlassian.com →
  Security → API tokens); Data Center offers a **personal access token** or username+password.
  The credential is stored only in your OS keychain and verified with a **single** read.
- **Use in chat / agent mode**: `#spSources` lists sources, `#spSearchContext` searches (plain
  text, or raw **CQL**/**JQL** for precision), `#spContextItem` fetches a page (by id) or issue
  (by key, e.g. `ENG-42`). Example: *“Using #spSearchContext, find Confluence pages about our
  release process and compare them with my SharePoint site's pages.”*
- **Pre-cached catalogs (fast local browsing)**: the first *Browse & Bookmark* on a source
  offers to **pre-cache the global set** of Confluence spaces / Jira projects + favourite
  filters + JSM queues. Big instances load page-by-page with a **"Keep loading?" check every
  `context.catalogCheckpointSeconds`** (15 s default) — loading pauses while the prompt waits,
  so the source is never overtaxed, and stopping keeps a usable partial. The cache **expires**
  after `context.catalogTtlHours` (24 h default): you then choose refresh / use the expired
  copy / live capped browse. Refresh any time: right-click → *Pre-cache Source Catalog*.
- **Read-safety**: results are capped (`context.maxResults`) and cached
  (`context.cacheTtlMinutes`, default 15 min — clear via the view's title button). Sources are
  read-only by construction: there is no write path.
- **Account-lockout protection (important)**: a rejected credential is **never retried
  automatically**; after 3 consecutive failures the source locks (red icon) to protect your
  account from org lockout policies. *Test Context Source* re-prompts for a fresh credential;
  *Reset Source Auth Lockout* (context menu) reopens a locked source — check with your admin
  first.

### Aliases & descriptions: name sources the way you talk about them

Give any source a short **chat alias** and a one-line **description** — optional steps when
adding, or any time via right-click → **Edit Alias & Description**:

- **Alias** (e.g. `CMDB`): the handle you use in chat — *"@sharepoint find information about
  application X in the **CMDB** database"* goes straight to that connection. Aliases are
  **unique** (validated as you type) so a reference is never ambiguous, matched
  case-insensitively, and shown on the source's row in the view.
- **Description** (e.g. *"ServiceNow CMDB replica: application & service inventory"*): shown to
  Copilot with every request, so when you don't name a source the model still picks the right
  one for the question.
- Both travel with **Export/Import Reference Config**, so the whole team shares the same
  vocabulary (still secret-free; colliding aliases are dropped with a warning on import).

### LDAP / Active Directory (with DNS auto-discovery)

Reference AD users, groups, and OUs read-only — with **no server address to type** on a
domain-joined machine.

- **Add** (Reference Sources → `+` → *LDAP / Active Directory*): the extension reads your
  workstation's domain (from `USERDNSDOMAIN`, the host FQDN, or `/etc/resolv.conf`) and queries
  DNS **SRV** records (`_gc._tcp.<domain>`, `_ldap._tcp.dc._msdcs.<domain>`) to find domain
  controllers and global-catalog servers. You connect to the **lookup itself** — e.g.
  `ldaps+srv://_gc._tcp.corp.example` — which re-resolves on every connection and fails over
  across servers, so the source keeps working as domain controllers change over time (specific
  servers are shown only as "currently resolves to" info). The base DN is derived for you;
  entering one specific server manually remains possible. Then sign in with **your own AD account** — UPN
  (`you@corp.example`), `DOMAIN\you`, or a full DN — and password. Run
  **AI SharePoint: Discover Active Directory (DNS)** any time to just see what DNS returns.
- **Search**: free text uses AD **ANR**, so `#spSearchContext` with *"Jane Doe"* matches name,
  login, and email at once; or pass a raw LDAP filter like `(&(objectClass=user)(department=R&D))`.
  `#spContextItem` fetches one entry by its distinguished name (DN).
- **Read-safety**: searches carry a server-side size limit (the result cap) and time limit;
  only a curated, non-sensitive attribute set is requested (name, mail, title, department,
  group membership…) — never password attributes. It is bind + search only; there is no write
  path.
- **Lockout protection is critical here** — a wrong AD password is the fastest way to lock a
  real account, so the breaker (3 strikes, no auto-retry) applies exactly as above.
### Databases (SQL Server, PostgreSQL, MySQL, MongoDB)

Reference **read-only** data from enterprise databases (Oracle is excluded for packaging
reasons — ADR-0022):

- **Add** (Reference Sources → `+`): pick the engine. PostgreSQL/MySQL/MongoDB take a
  connection URL with the database name — e.g. `postgresql://pghost/reporting`,
  `mysql://myhost/app`, `mongodb://mongo/ops` (`mongodb+srv://` supported). Sign in with a
  database account — a **least-privilege read-only account is recommended**.
- **SQL Server is fully guided** — no connection string to get right. The wizard prompts for
  each element separately and builds (then live-verifies) the connection from your answers:
  1. **Server FQDN** (hostname only — pasting the SSMS "Server name" like
     `server.corp.com\INSTANCE,14330` here pre-fills the next steps);
  2. **Instance name** (empty for the default instance);
  3. **TCP port** (empty to resolve via SQL Browser when an instance is set; an explicit port
     connects directly and — exactly like SSMS/SqlClient — wins over the instance name for
     routing);
  4. **Database name**;
  5. **Certificate handling** — choose **"Trust server certificate"** (the SSMS checkbox
     equivalent) when the server's certificate is self-signed or doesn't match the FQDN you
     connect with; validation is skipped for that source only;
  6. **Sign-in method** — **SQL Server Authentication** (database login) or **Windows
     Authentication** (NTLM — `CORP\user` or `user@corp.example` + password; passwordless SSO
     is not possible in a portable extension) — then username and password. The connection is
     verified with a single read before anything is saved, and a rejected login now includes
     **SQL Server's own error message** (login failed vs. cannot open database vs. wrong
     instance) so the fix is obvious.
  The equivalent URL forms, if you script sources via export/import:
  `mssql://sqlhost:14330/Sales` (direct port) or `mssql://sqlhost/Sales?instance=PROD`
  (SQL Browser, UDP 1434), plus `?trustServerCertificate=true`.
- **Query from chat**: ask `@sharepoint` to run a `SELECT` (or provide one) — only single,
  read-only SELECT statements are accepted (write/DDL/EXEC keywords are blocked by a guard,
  on top of server-side read-only sessions where the engine supports them); MongoDB takes a
  JSON spec `{"collection": "...", "filter": {...}, "limit": n}`. Results are row-capped
  (`context.maxResults`) and time-limited.
- **Browse & Bookmark** lists the database's tables/collections and saves capped sample-row
  queries as bookmarks — **you can tailor the SQL before saving**, and edit any bookmark's
  name/query later (inline pencil or right-click → *Edit Bookmark*; database queries stay
  validated read-only). The agent can propose query bookmarks after exploring
  (`#spSuggestBookmark`, approval required).
- **Two indexing options (ADR-0024)**, both Copilot-powered, named for what they look at:
  - **Index Database Schema** — reads every table/view your account can access, then Copilot
    writes descriptive summaries (tags/synonyms/purposes). Sends **names and types only** —
    e.g. `group_cio` gets tagged *ownership* so *"records owned by X"* finds it.
  - **Index Database Content Types** — samples a bounded set of rows per table, reduces them
    locally to top distinct values per column, and Copilot describes **what the values are**
    ("ISO country codes", "statuses: Active/Retired"). This option does send sampled values
    to Copilot (the consent dialog says so) — but **nothing from the database is ever
    persisted**: the samples exist only for the request, and only Copilot's descriptive
    summaries are stored to aid navigation and search.
  Both honor `aiSharePoint.context.allowSchemaIndexing`; *View Database Schema & Semantic
  Index* shows exactly what's stored; `#spDbSchema` gives the model the right columns before
  it writes a SELECT. **Indexes are shared via Export/Import Reference Config**, so one
  teammate's indexing run benefits everyone.
- **Build Database ER Diagram (ADR-0030)** — for the common enterprise case where **no foreign
  keys are declared** and nobody is sure what joins to what. The run is **sized by your
  database, not by fixed numbers**: a sizing pass reads approximate row counts from catalog
  statistics (cheap — never `COUNT(*)`), the candidate budget scales with the catalog, and
  then each candidate pair's **real join rate is probed in both directions**. Pairs where both
  tables are small (≤50k rows) get **complete join tests**; larger targets start with
  right-sized samples that **escalate toward completeness while the database answers fast**
  and back off the moment it doesn't (slow probes pause the run; repeated strain de-escalates
  it). A **Thorough mode** additionally tests *every* type-compatible column pair across the
  small tables. Candidates come from the schema and the indexes above (FK-shaped names,
  matching non-generic names, identifier tags that agree); **only match counts are read, never
  row data**, and a consent dialog states the plan first. ≈100% match reads as a designed-in
  relationship; a high-but-partial rate still counts (subsets are normal); **full one way +
  partial the other marks an intentional subset**, and the saved note says which side needs a
  LEFT JOIN — the inner-vs-outer distinction, measured rather than guessed. The result
  persists with the schema (complete-join verifications flagged), renders as a **Mermaid ER
  diagram** plus a rate table in *View Database Schema & Semantic Index*, travels with
  reference-config exports, and is fed to chat so multi-table questions JOIN on the right
  columns.
- **Small scopes are swept completely, in every mode**: when ≤12 tables are in scope, *every*
  type-compatible column pair is probed — junction tables join on columns whose names share
  nothing (`member_dn` → `distinguishedName`), so measurement, not naming, finds them. Tables
  without row statistics (fresh exports) are included with bounded samples; only tables known
  to be huge sit out of the sweep.
- **The run escalates when it finds little — with your say-so**: after the native pass you're
  offered the **cast pass** (failed probes are re-tested comparing both sides as text — the fix
  for legacy `ntext`/`text` columns that `=` cannot compare at all, and for `int ↔ varchar`
  keys), and then the **large-table pass** (big tables included with strictly bounded samples,
  never full scans). Pick **Maximum** mode to run every escalation automatically. Joins proven
  through casts are marked *(cast)* everywhere, and chat is told to CAST both sides when
  writing them.
- **Scope and seed the run**: the wizard first lets you **scope the tables** — type
  comma-separated prefixes/keywords (e.g. `fin_, gl_`; shared prefixes usually mean a shared
  objective) to pre-select, then search and multi-select by hand. A scoped run **merges** into
  the model: findings outside the scope survive, re-probed pairs take the fresh measurement —
  map a 100-table database one neighborhood at a time. You can also hand over **known joins by
  pasting a working SQL query** — *every* join condition is extracted (aliases resolved,
  compound `ON … AND …` clauses included), or paste bare `table.column = table.column`
  equalities; when the SQL is too gnarly to parse, **Copilot summarizes it into target joins**
  (you approve sending the pasted SQL first). Extracted joins are probed first, probed with
  casts when they cross types, and kept even at low measured rates (marked *defined*). In the
  AI modes you can also **describe the data** for Copilot (*"SAP FI tables — MANDT is the
  client key on every table"*), which is weighted into its join hypotheses and remembered for
  the next run.
- **Refine the ER diagram from chat**: paste a join you know is right — *"@sharepoint test this
  join: `FROM Orders o JOIN Customers c ON o.customer_id = c.id`"* (SQL with aliases or a bare
  `table.column = table.column` both work). If it's already in the ER model you get the stored
  relationship; otherwise the **live join rate is probed** on the spot and reported. Ask to
  **save** it and — after your confirmation in chat — the diagram is extended; user-defined
  joins are kept even below the automatic thresholds (marked *defined*, measured rates still
  shown), so known-but-messy joins stay on the map.
- **TLS** trusts the OS store and the shared pinned CA bundle setting
  (`aiSharePoint.ldap.caCertificatesFile` — applies to all non-HTTP sources).

### Vertex AI Search (Google enterprise search)

Connect your organization's **Vertex AI Search** app (the enterprise Gemini search portal):

- **Add** (Reference Sources → `+` → *Vertex AI Search*): pick **"Find my search app via
  Google SSO"** and the wizard lists your projects and apps (probing global/us/eu) — no IDs to
  know. Or choose manual entry and **paste any URL you have** — including the **corporate
  search page you open via SSO**
  (`https://vertexaisearch.cloud.google/<region>/home/cid/<app id>?csesidx=…` — the region and
  app id are read from it; the `csesidx` session id is ignored), a Cloud Console link, or the
  serving config. It pre-fills whatever the URL carries; the corporate page doesn't name the
  hosting project, so the wizard offers **"Find the project for me"** — it scans the projects
  your Google sign-in can see and probes which one hosts the app (no IDs to know). Manual entry
  remains for accounts that use the app without any project role (`gcloud projects list` —
  locally or at shell.cloud.google.com — or ask whoever shared the page).
- **SSO via the gcloud CLI (recommended)**: each call uses a **live token from your existing
  `gcloud auth login` session** — your corporate Google SSO — and nothing is ever stored.
  No CLI? Paste an OAuth access token instead (kept in your OS keychain; ~1 h lifetime, the
  error message tells you when to refresh it).
- **No GCP access at all?** (Common when the search page is reached via **Entra ID / Azure AD
  SSO** federation.) Everything you need is in the **search page's own network traffic**: press
  `F12` → **Network** on the page, run a search, click the request named `search`/`answer`/
  `servingConfigs` — its **URL embeds `projects/<number>/locations/…/engines/…`** (paste it
  into the wizard's project step; a project *number* works like an ID), and its **Request
  Headers carry `Authorization: Bearer …`** — copy the token value (without the word `Bearer`)
  as the pasted-token sign-in. The token is your own session's (~1 h); re-paste via *Test
  Context Source* when it expires.
- **Search and analysis in chat**: plain searches return enterprise hits; ask for analysis and
  the `#spVertexAnswer` tool returns a **Gemini-grounded answer with citations** from your
  corpus (*"@sharepoint ask Vertex what our data-retention policy says"*).

### ServiceNow

Reference your instance's ITSM and CMDB records **read-only**:

- **Sign-in**: **Browser session** is recommended for SSO and needs **no admin OAuth setup** —
  sign in to ServiceNow in your browser, then paste your session cookies. Every paste shape is
  accepted and normalized to a proper cookie header: the **Cookie request header** (DevTools →
  Network → any request — most reliable; **raw or parsed both work**: right-click the header →
  *Copy value*, or toggle the *Raw* view and copy the whole `Cookie: …` line), the
  **Application/Storage → Cookies table** rows (select the full set and copy; tab-separated is
  fine), **Firefox's Copy-All JSON**, or one-`name=value`-per-line exports. Some instances
  additionally require the **page CSRF token** for API calls — if complete, fresh cookies
  still return *"User Not Authenticated"*, supply the optional **X-UserToken** when the wizard
  asks: in the same signed-in tab, DevTools → **Console** → type `g_ck` → Enter → copy the
  printed value. After the paste the wizard confirms the **cookie names**
  it captured (values are never shown) and warns if `JSESSIONID` is missing. If a session is
  rejected, the error shows **what ServiceNow actually returned** (its error message, the title
  of any HTML/login page, or the SSO gateway it redirected to) plus the replayed cookie names —
  a *freshly captured* set that fails usually means the paste missed some of the host's cookies
  (copy the whole Cookie header) or a security gateway in front of the instance, **not** expiry.
  Read-only; re-captured the same way when the session does expire (*Test Context Source*
  offers **Refresh Sign-in**). Basic and OAuth token/OAuth-client paths remain available.
- **Add** (Reference Sources → `+` → *ServiceNow*): enter the instance URL
  (`https://yourorg.service-now.com`) and sign in — **least-privilege integration account**
  (Basic) or an OAuth bearer token. The wizard then **lists the tables your account can
  read** and you pick a default from the list (or "no default"); nothing to type. Instance
  ACLs decide what's visible, and the lockout breaker protects the account.
- **Ask naturally**: free text searches the default table's text index
  (*"@sharepoint search ServiceNow for the Berlin email outage"*); power users can pass a
  native encoded query (`active=true^priority=1`) or target any table with JSON —
  `{"table": "cmdb_ci_appl", "query": "ORDERBYDESCsys_updated_on", "limit": 25}`. Single
  records fetch as `table/sys_id`, with reference fields shown as display names.
- **Browse & Bookmark** enumerates your readable tables live (full catalog where permitted,
  the common ITSM/CMDB set otherwise) — each as a recently-updated query, default table
  first. Pair it with an alias like `CMDB` and chat reads the way you talk:
  *"find the app records owned by X in CMDB"*.

### Splunk

Search your logs and metrics **read-only** from chat:

- **Add** (Reference Sources → `+` → *Splunk*): the **management API URL** (usually port
  `8089`, not Splunk Web), an optional **default index**, and an optional Splunk Web URL for
  deep links. Sign in with an **authentication token** (Splunk Web → Settings → Tokens;
  recommended) or a least-privilege search account.
- **Sign-in**: pick **Browser SSO session** (recommended for SAML/SSO — no token or password
  needed). Complete SSO in your browser, then paste the **value of the `splunkd_<port>` cookie**
  (commonly **`splunkd_8000`**) — your live session key. The wizard's *"How to find the cookie"*
  button shows per-browser steps; in short:
  - **Edge / Chrome:** `F12` → **Application** tab → **Storage → Cookies →** your Splunk host →
    copy the **Value** of `splunkd_<port>`.
  - **Firefox:** `F12` → **Storage** tab → **Cookies** → your Splunk host → copy the value of
    `splunkd_<port>`.
  - **Safari:** enable *Settings → Advanced → "Show features for web developers"*, then
    **Develop → Show Web Inspector → Storage → Cookies** → copy the value of `splunkd_<port>`.

  Copy the **value only** (a long opaque string), not the cookie name. It uses your browser's own
  Splunk session and is re-captured the same way when it expires: when a previously-working
  source is rejected, *Test Context Source* says the session has likely expired and offers
  **Refresh Sign-in** — sign in to Splunk Web again, capture a fresh cookie, and it re-verifies
  and saves in one flow. An authentication **token** or **username/password** also work where
  permitted.
- **Search app**: on Splunk Cloud the wizard lists the apps you can access and asks which
  **search app** to run in — required when your instance disables the default `search` app and
  meters by a line-of-business app. Searches then dispatch in that app's namespace
  (`/servicesNS/-/<app>/…`); setup verifies it with a quick test search before saving.
- **Ask naturally**: *"@sharepoint search Splunk for smtp relay timeouts"* (keywords search the
  default index over the last 24 h), or use raw SPL — `search index=web error | stats count by
  host`, `| savedsearch "Errors by host"` — or JSON with `earliest`/`latest` to widen the
  window. Mutating/exfiltrating commands (`delete`, `collect`, `outputlookup`, `sendemail`, …)
  are blocked before anything is sent.
- **Browse & Bookmark** lists your saved searches and indexes as ready-made starter queries.

### Power BI (cloud)

Analyze Power BI data without leaving chat — **read-only, with your existing sign-in**:

- **Add** (Reference Sources → `+` → *Power BI (cloud)*): confirm the portal you use
  (`https://app.powerbi.com`), pick a sign-in, and the wizard **lists every dataset you can
  access** — pick a default for bare-DAX questions or "no default". No GUIDs to know.
- **Sign-in options** (all delegated — your own Power BI access, never more):
  - **Microsoft sign-in — nothing to install (recommended)**: a normal browser or device-code
    sign-in that authenticates **as the Azure CLI app** (a Microsoft first-party app already
    authorized for the Power BI service), so it needs **no tenant admin approval, no app
    registration, and no CLI on the machine** — the path for standard users when the
    Microsoft 365 option ends in *"… needs admin approval"*. Sign in once; refresh happens
    silently (the sign-in appears as "Microsoft Azure CLI" in your sign-in log).
  - **Azure CLI (az) session**: same consent posture, using your existing `az login`; tokens
    are never stored — every call asks the CLI.
  - **Microsoft 365 sign-in** (shared with SharePoint): zero extra setup where your tenant
    permits the shared sign-in app to request Power BI scopes; some tenants require admin
    approval for it.
  - **Paste an access token**: no CLI needed either — run
    `az account get-access-token --resource https://analysis.windows.net/powerbi/api` at
    **shell.azure.com** (browser-based, nothing to install) and paste the result (~1 h
    lifetime; re-paste via *Test Context Source*).
- **Browse & Bookmark** lists every dataset you can see (My workspace + group workspaces),
  each with a starter `EVALUATE INFO.TABLES()` bookmark that reveals the model's tables.
- **Analyze in chat**: *"@sharepoint run EVALUATE TOPN(20, 'Sales') against the Sales Model
  dataset"* — queries are `{"dataset": "<name or id>", "dax": "EVALUATE …"}` under the hood,
  DAX-only (read-only by API design), row-capped, and your Power BI licenses, workspace roles,
  and row-level security apply exactly as in the service.

## Communications: Teams & Outlook drafts you approve

Have findings reach people — **without the assistant ever sending anything itself**:

- **Prepare** a draft: *Draft Teams Message…* / *Draft Outlook Email…* (view title buttons),
  or ask `@sharepoint` — *"draft a Teams message to jdoe@corp.example summarizing this"* —
  which queues via a confirmation-gated tool. Individuals only (max 10 recipients).
- **Approve**: drafts wait in the **Communications** view (the badge counts pending
  approvals). Reviewing opens the **full text in the editor** plus a modal naming every
  recipient; recipients are **resolved against your directory first** (a typo aborts with the
  exact addresses). Only your explicit approval sends — from your account, so tenant
  compliance/DLP applies as always.
- **Outlook safety valve**: *Save to Outlook Drafts* puts the draft in your mailbox without
  sending — finish and send from Outlook itself. (Teams has no equivalent: Microsoft Graph has
  no “unsent Teams message” — direct Teams messaging always posts live, which is why it needs
  `Chat.ReadWrite` consent. Outlook drafts use `Mail.ReadWrite`, separate from `Mail.Send`.)
- **Teams without admin consent — Incoming Webhooks.** If your tenant won't grant
  `Chat.ReadWrite`, a channel owner can create a **Teams Incoming Webhook** (channel ••• →
  Connectors → Incoming Webhook, or a Power Automate “Workflows” webhook) — **no app
  registration, no admin consent, no Graph**. Run *AI SharePoint: Configure Teams Webhook…*
  (Communications view title bar), paste the URL (stored only in your OS keychain), and name
  it. Teams drafts then gain a **“Post to <name>”** button in the approval dialog that delivers
  a card to that **channel**. The trade-off: a webhook posts to a channel, not a 1:1/group
  chat, and can’t @-mention individuals — your recipient list appears as a **“For:”** line in
  the card. Approval, preview, and discard work exactly as for the Graph path.
- Send-capable Graph permissions (`Chat.ReadWrite`, `Mail.Send`, …) are requested **only** by
  this flow, on first use (ADR-0025); the webhook path needs none of them.

### Projects: scope sources/bookmarks and give @sharepoint goals + memory

The **Projects** view (activity bar — between *Reference Sources* and *Copilot Activity*; if
it's not visible, right-click the AI SharePoint header and re-check **Projects**, or run
*Projects: Create Project…* from the Command Palette, which works regardless) is the home for
this. A project groups reference sources
(bookmarks follow their sources) and carries context for the assistant:

- **Create** (Projects view → **+**, or *Projects: Create Project…*): name, description,
  **goals** (what the project is for), **instructions & common reference context** (your
  baseline guidance — e.g. *"prefer the CMDB for application questions; cite Confluence pages"*),
  then pick the member sources.
- **Activate** by clicking a project in the view (or *Projects: Switch*). The active project is
  marked, the Reference Sources header shows it, and chat tools / source resolution / bookmark
  listings are scoped to its members. Activating again offers to show **All sources**.
- **Two kinds of context, kept separate:**
  - **Yours** — goals + instructions, edited via *Edit Project*; shown to @sharepoint as
    user-authored.
  - **AI-managed** — as you teach @sharepoint durable behavior ("answer in German", "owners come
    from the CMDB"), it can **save that** into the project's AI context (you approve each note).
    It persists across sessions, is never mixed with your instructions, and you can **view,
    edit, or clear** it via the **AI-managed context** row or *Projects: Manage AI Context*.
- **Share**: goals, instructions, AND the AI-learned context travel with **Export/Import
  Reference Config** — one teammate sets up and teaches a project, the whole team imports it
  (sources, aliases, bookmarks, database indexes, and project context) and signs in with their
  own credentials.

### Bookmarks: reusable pointers for your initiatives

Save the queues, spaces, filters, and entries you use repeatedly — per source, by name:

- **Guided (recommended):** click the **bookmark icon** on a source row (or right-click →
  *Browse Source & Add Bookmark…*). For **Jira** you pick from your **JSM queues** (each carries
  its own JQL), **favourite filters**, or **projects**; for **Confluence** you pick a **space**
  (saved as a recent-content query); for any source you can also *search first*, then bookmark
  either the query itself or one specific result (issue, page, directory entry).
- **Manual:** right-click a source → *Add Bookmark* and paste a raw CQL/JQL/LDAP filter or a
  page id / issue key / DN.
- **Use them:** bookmarks appear as children under their source (click to run), and in chat the
  agent can list them (`#spBookmarks`) and run them by name (`#spRunBookmark`) — e.g.
  *"run my 'IT Help: Unassigned' bookmark and summarize the queue."*
- **Let Copilot propose them:** in agent mode, after searching your sources the assistant can
  call `#spSuggestBookmark` to propose persisting a useful query — **you approve in a
  confirmation dialog before anything is saved**. Try: *"search Jira for the Phoenix initiative's
  open work and suggest bookmarks for the queries worth keeping."*

- **Share with your team**: **Export Reference Config (secret-free)…** writes a JSON of source
  descriptors + bookmarks (never credentials or accounts — verified by a leak scan); teammates
  **Import Reference Config…** and sign in with their own credentials, with the working auth
  method pre-selected.
- **TLS**: LDAPS (port 636/3269) is preferred, and internal-CA certificates are trusted via
  the **operating-system trust store** (plus `NODE_EXTRA_CA_CERTS` and the admin setting
  `aiSharePoint.ldap.caCertificatesFile` for a pinned corporate CA bundle). If you see "LDAPS
  certificate not trusted", ask IT to confirm the corporate CA is deployed or set that setting —
  details in the Admin Guide. For plain `ldap://`, `aiSharePoint.ldap.useStartTls` upgrades the
  connection. LDAP traffic goes **directly** to the DC (not via the VS Code proxy).

## Copilot activity and the dashboard

**What is counted.** The extension records every request it makes (model, input/output tokens,
success/failure) — factual, locally measured counts of its OWN activity. Failed or cancelled
requests are counted too, because GitHub charges at send time.

**What is NOT tracked — by design.** Premium-request consumption against your plan's monthly
allowance. There is no automated, authoritative way for the extension to read your real
allowance or bill, and the earlier locally estimated gauge proved misleading. **Your GitHub
billing/plan page is the only authoritative source**; the feature returns if an authoritative
API becomes available.

**The status-bar item** shows today's request count; click it for the dashboard.

**The dashboard** (`AI SharePoint: Show Copilot Activity Dashboard`): 30-day daily request
chart, per-model (with token totals) and per-task tables.

**Model policy.** By default the extension uses your cheapest entitled model (sorted by the
published premium-request multiplier — `0×`, `1×`, `10×`). Run `AI SharePoint: List Copilot
Models` to see each model's published multiplier and optionally pick a preferred default. In
chat, the chat UI's model picker wins.

**Resetting.** `AI SharePoint: Reset Copilot Activity Counters` clears the local history (it
does not affect GitHub billing).

## Getting help: diagnostics export

When something misbehaves — especially inside a locked-down environment where you can't just
screenshot internal URLs — use the diagnostics bundle:

1. Run **AI SharePoint: Export Diagnostics Bundle** (also in the Support view and on every error
   notification).
2. Choose the scope: **Full**, **Usage only**, or **Errors only**.
3. A **preview** opens showing the exact content. Nothing has been written yet.
4. Confirm **Save Bundle…** (writes `…-diagnostics-<timestamp>.json` + a readable `.md`
   companion) or **Copy JSON to Clipboard**.
5. Send the file to your IT contact or attach it to a GitHub issue.

What makes it safe to share — verifiable in the preview:

- Tenant hostnames appear as salted pseudonyms (`anon-3fa9c41d2b.sharepoint.com`); site names,
  URLs, and your account never appear.
- Error messages and stack traces are redacted at capture time (no tokens, emails, GUIDs, IPs,
  or user paths; stack frames keep only file basenames).
- No prompts, AI responses, or site content are ever stored, so they can't be exported.
- A **leak scan** runs before saving; if anything secret-shaped slipped through, the export
  refuses to write.
- The bundle's only identifier is a random **anonymous install ID** — rotate it any time
  (Support view) to sever correlation with earlier bundles.

Full details: [Privacy & Data Notice](PRIVACY.md).

## All commands

| Command | What it does |
|---|---|
| Connect SharePoint Site | Add a connection (URL → role → sign-in method) |
| Test Site Connection | Verify reachability; shows latency + signed-in account |
| Open Site in Browser / Copy Site URL | Convenience actions |
| Change Connection Role | Toggle managed ↔ reference |
| Sign Out of Site | Wipe the tenant's cached tokens from the keychain |
| Configure Site Repository (Git)… / Pull Site to Repository / Push Site Repository | Site-as-code sync (managed sites; see the Site repositories section) |
| Apply Repository to SharePoint (write-back)… | Write repo changes to the live site — previewed, freshness-checked, snapshot-guarded |
| Revert Site to Commit… | Make the live site match an earlier snapshot commit (ADR-0005) |
| Export / Import Reference Config | Share sources + bookmarks with the team, secret-free (ADR-0013) |
| Add / Test / Remove Context Source · Edit Alias & Description · Reset Source Auth Lockout · Clear Reference-Source Cache | Read-only reference sources (Confluence/Jira/LDAP/databases/Vertex AI Search) |
| Load/Refresh / Index / View Database Schema · Pre-cache Source Catalog | Schema understanding (ADR-0024) and catalog pre-cache per source |
| Draft Teams Message / Draft Outlook Email · Review & Send / Edit / Discard Communication Draft | Approval-gated communications (ADR-0025) |
| Configure Teams Webhook (no admin consent)… | Add/remove channel Incoming Webhooks so Teams drafts can post without `Chat.ReadWrite` |
| Edit Bookmark | Rename / modify a bookmark's saved query (SQL validated read-only) |
| Remove Site Connection | Remove descriptor (+ tokens if last connection in tenant) |
| Ask Copilot | One-shot prompt; streams into the “AI SharePoint — Copilot” output |
| List Copilot Models | Models with their published premium-request multiplier; optionally set the preferred default |
| Show Copilot Activity Dashboard | The webview dashboard (local request counts) |
| Reset Copilot Activity Counters | Clear local request history (confirmed) |
| Export Diagnostics Bundle | The anonymized support bundle (previewed + scanned) |
| Show / Delete Error Reports | Browse redacted error reports; open details; delete (also right-click **Error Reports** in Support & Diagnostics) |
| Rotate Anonymous Install ID | New random ID + hash salt |
| Open Extension Logs | The redacted log channel (level set via the gear menu) |
| Open User Guide / Privacy Notice / Walkthrough | Documentation |

## All settings

| Setting | Default | Notes |
|---|---|---|
| `aiSharePoint.copilot.preferredModelFamily` | `""` | Empty = cheapest entitled model |
| `aiSharePoint.auth.tenantAuthority` | `…/common` | **Machine-scoped**; host must be a known Microsoft login endpoint |
| `aiSharePoint.auth.clientId` | `""` | **Machine-scoped**; custom Entra app (see Admin Guide) |
| `aiSharePoint.auth.additionalAuthorityHosts` | `[]` | **Machine-scoped** authority-host allowlist additions |
| `aiSharePoint.diagnostics.usageCapture` | `followVSCode` | Local-only counters; `on` / `off` / follow VS Code telemetry |
| `aiSharePoint.diagnostics.errorCapture` | `true` | Local-only redacted error reports |
| `aiSharePoint.sync.allowedRemoteHosts` | `["github.com"]` | **Machine-scoped** — Git hosts site repos may push to (add your GHES host) |
| `aiSharePoint.context.cacheTtlMinutes` | `15` | Reference-source result cache TTL |
| `aiSharePoint.context.maxResults` | `25` | Reference-source result cap |
| `aiSharePoint.ldap.caCertificatesFile` | `""` | **Machine-scoped** — PEM bundle appended to OS/default trust for LDAPS |
| `aiSharePoint.context.catalogTtlHours` | `24` | Pre-cached catalog freshness window |
| `aiSharePoint.context.catalogCheckpointSeconds` | `15` | "Keep loading?" interval during catalog pre-cache |
| `aiSharePoint.context.allowSchemaIndexing` | `true` | **Machine-scoped** — allow Copilot schema indexing (names only) |
| `aiSharePoint.ldap.dnsServers` | `[]` | **Machine-scoped** — internal DNS IPs for AD SRV lookups (fixes VPN split-DNS) |
| `aiSharePoint.logging.verboseWire` | `false` | Full redacted request/response detail from every integration in the log |

## Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| “No Copilot models available” | Copilot Chat missing or signed out → run **Check Copilot Status** for guided fixes. Organization may need to enable Copilot. |
| Browser sign-in never completes | Pop-up/redirect blocked or no default browser (common in VDI) → reconnect using **device code**. |
| Sign-in fails with `network_error` | Corporate proxy / TLS inspection in the path → ensure VS Code sees your proxy (`http.proxy` or system proxy) and the corporate root CA is in the OS trust store. All extension traffic (including sign-in) uses VS Code's networking, so if Graph works, sign-in should too. Admin Guide §3. |
| `AADSTS…` error during sign-in | Tenant policy rejected the app → see Admin Guide (allow the first-party app or configure a custom `clientId`); check conditional-access requirements. |
| “Sign-in required for this site” in chat | Cached token expired and chat never prompts → run **Test Site Connection** once, then ask again. |
| “authority host … is not trusted” | A non-Microsoft authority was configured → fix `tenantAuthority`, or (if legitimate, e.g. ADFS) have IT add it to `additionalAuthorityHosts`. |
| 403 / “access denied” on a site | Your account lacks permission, or the tenant hasn't consented `Sites.Read.All` for the app → Admin Guide. |
| Pages list shows “unavailable” | Some tenants restrict the Graph Pages API → lists still work; this is expected. |
| 429 / throttled | Microsoft Graph throttling → the extension retries once automatically; wait a moment. |
| SQL Server "authentication rejected" but the login works in SSMS | Re-add the source with the guided wizard (it prompts for server, instance, port, database, certificate, and sign-in method separately — answer exactly as in SSMS) and read the appended **“server said: …”** detail: it is SQL Server's own message distinguishing a bad login, an inaccessible database, or a wrong instance. |
| "Could not initialize a Git repository" / repo not detected | Folder outside the workspace, Restricted Mode, or git missing → accept the wizard's "Add to Workspace" offer (or File → Add Folder to Workspace…), trust the window, and check `git --version`. |
| A view is missing AND not listed in the activity-bar header menu (e.g. no "Projects", old view names like "Usage & Budget") | A **torn installation**: VS Code cached an old interface manifest while newer code runs — the extension detects this and warns with the two versions. Reload the window; if it returns, **fully quit and restart VS Code** (not just reload); if it persists, uninstall the extension, restart, and reinstall the latest VSIX. |
| Network errors behind a proxy | VS Code's proxy settings apply (`http.proxy`) → see Admin Guide §Proxies. |

Still stuck? **Open Extension Logs** (set level to *Trace* via the gear), reproduce, then
**Export Diagnostics Bundle** and share it — that's exactly what it's for.

## FAQ

**Does this extension send my data anywhere?** No. It calls Microsoft Graph (for your sites) and
GitHub Copilot (for AI, through VS Code). It has no servers, no telemetry endpoint, no
auto-update of any table. The diagnostics bundle is written only where you save it.

**What does the AI see?** Your prompt plus, when relevant, the connected site's name,
description, list names, and page titles. Copilot requests are governed by your organization's
GitHub Copilot policies.

**Are the cost numbers my real bill?** No — they're this extension's own metered estimate (see
ADR-0003). They exist so you're never surprised, not to replace GitHub's billing page.

**Can it modify my SharePoint sites?** Only when *you* run the write-back or revert commands —
every write is previewed, drift-checked, snapshot-guarded, and applied under your own account.
The AI assistant and agent tools can never write; they draft repo file edits for you to apply.

**Where are my credentials?** In your OS keychain, keyed per tenant, removable via Sign Out /
Remove Connection. Never in settings, files, logs, or exports.
