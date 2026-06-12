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
10. [Copilot usage, budget, and the dashboard](#copilot-usage-budget-and-the-dashboard)
11. [Getting help: diagnostics export](#getting-help-diagnostics-export)
12. [All commands](#all-commands)
13. [All settings](#all-settings)
14. [Troubleshooting](#troubleshooting)
15. [FAQ](#faq)

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
4. Run `AI SharePoint: Set Copilot Budget` and enter your plan's monthly premium-request
   allowance so the status-bar gauge is accurate.

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

### Usage & Budget
The live cost picture: headline gauge (% of allowance), today's requests, budget configuration,
and expandable **By model** / **By task** breakdowns. The title-bar buttons open the dashboard
and the budget editor.

### Support & Diagnostics
Everything operational: **Export Diagnostics Bundle**, **Error Reports** (the view badge shows
the count; **right-click → Delete Error Reports** to clear them, with confirmation), extension
**logs**, **Verbose Wire Logging** (below), the **walkthrough**, this **user guide**, the
**privacy notice**, and **Rotate Anonymous Install ID**.

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

- **Site context is automatic**: if your question references a connected site (by URL or name),
  or you have exactly one connection, the assistant reads the site's lists and pages live and
  answers from real data.
- **Reference sources are searchable in chat**: ask things like _“search Confluence for content
  about AI automation and aggregate what's relevant”_ — the assistant calls the same read-only
  tools available in agent mode (search, fetch item, run bookmark), shows each step, and can
  end by **proposing bookmarks** for the queries worth keeping (you approve in a confirmation
  dialog). Each model round is metered and the budget hard cap is enforced mid-conversation.
- **Sign-in is never triggered from chat.** Context reads use cached credentials only; if the
  cache has expired, the assistant tells you to run *Test Site Connection* instead of popping a
  browser window mid-conversation.
- **Budget-aware**: past your soft cap, responses begin with a warning; past your hard cap (in
  `block` mode), the request is refused with a button to adjust the budget.
- The model is whatever you've selected in the chat model picker; each answer is metered and
  the footer shows the premium units charged (when > 0).

Slash commands: `/site <url or name>` · `/sites` · `/usage` · `/help`.

## Agent-mode tools

In Copilot **agent mode**, these read-only tools are available — Copilot invokes them
automatically when relevant, or you can `#`-reference them in any chat prompt:

| Tool | What it returns |
|---|---|
| `#spConnections` | Your configured connections (name, URL, role, verified) |
| `#spSiteOverview` | Site title/description + lists/libraries + pages |
| `#spPages` | Modern pages with URLs and last-modified times |
| `#spUsage` | This extension's metered usage vs. your budget |
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
- **TLS** trusts the OS store and the shared pinned CA bundle setting
  (`aiSharePoint.ldap.caCertificatesFile` — applies to all non-HTTP sources).

### Vertex AI Search (Google enterprise search)

Connect your organization's **Vertex AI Search** app (the enterprise Gemini search portal):

- **Add** (Reference Sources → `+` → *Vertex AI Search*): pick **"Find my search app via
  Google SSO"** and the wizard lists your projects and apps (probing global/us/eu) — no IDs to
  know. Or choose manual entry and **paste any URL you have** (your corporate search page, a
  Cloud Console link, or the serving config) — it pre-fills whatever it carries and tells you
  where the app owner finds the rest.
- **SSO via the gcloud CLI (recommended)**: each call uses a **live token from your existing
  `gcloud auth login` session** — your corporate Google SSO — and nothing is ever stored.
  No CLI? Paste an OAuth access token instead (kept in your OS keychain; ~1 h lifetime, the
  error message tells you when to refresh it).
- **Search and analysis in chat**: plain searches return enterprise hits; ask for analysis and
  the `#spVertexAnswer` tool returns a **Gemini-grounded answer with citations** from your
  corpus (*"@sharepoint ask Vertex what our data-retention policy says"*).

### ServiceNow

Reference your instance's ITSM and CMDB records **read-only**:

- **Sign-in**: **Browser session** is recommended for SSO and needs **no admin OAuth setup** —
  sign in to ServiceNow in your browser, then paste your session cookies (DevTools → Application
  → Cookies, or the Cookie request header). Read-only; re-captured the same way when the session
  expires. Basic and OAuth token/OAuth-client paths remain available.
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
  Splunk session and is re-captured the same way when it expires (via *Test Context Source*). An
  authentication **token** or **username/password** also work where permitted.
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
  (`https://app.powerbi.com`), pick your Microsoft 365 sign-in, and the wizard **lists every
  dataset you can access** — pick a default for bare-DAX questions or "no default". Nothing to
  type, **no new credential**, no GUIDs to know.
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
  sending — finish and send from Outlook itself.
- Send-capable permissions (`Chat.ReadWrite`, `Mail.Send`, …) are requested **only** by this
  flow, on first use (ADR-0025).

### Projects: scope sources, bookmarks, and instructions per initiative

Group what belongs together and switch contexts in one click:

- **Create** (*Projects: Create Project…*): name, optional description, optional **baseline
  agent instructions** (prepended to every `@sharepoint` turn while active — e.g. *"prefer the
  CMDB for application questions; cite Confluence pages"*), then multi-pick the member sources;
  bookmarks follow their sources automatically.
- **Switch** via the Reference Sources title-bar button or *Projects: Switch* — the view header
  shows the active project, and chat tools, source resolution, and bookmark listings are
  scoped to its members. Pick **All sources** to disable scoping.
- **Share**: projects are included in **Export/Import Reference Config**, so a teammate
  importing your file gets the same scoped working set — sources, aliases, bookmarks, database
  indexes, and the project instructions.

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

## Copilot usage, budget, and the dashboard

**How metering works.** The extension records every request it makes (model, input/output
tokens) and prices it in **premium-request units** using a maintained model-multiplier table.
This is an **estimate** — honest by design (see ADR-0003): VS Code's API exposes tokens, not
your GitHub bill. Failed or cancelled requests are counted too, because GitHub charges at send
time.

**The gauge.** The status-bar item shows `% of monthly allowance · requests today`. It turns
<span>**yellow**</span> past your soft cap and **red** past your hard cap. Click it for the
dashboard.

**Budget enforcement** (`aiSharePoint.budget.mode`):

| Mode | Soft cap | Hard cap |
|---|---|---|
| `block` (default) | warn | **block** — palette requests offer a one-time “Proceed Once” override; chat refuses with guidance |
| `warn` | warn | warn |
| `off` | — | — (metering continues) |

**The dashboard** (`AI SharePoint: Show Usage Dashboard`): 30-day daily chart, budget bar with
cap markers, per-model and per-task tables, and action buttons. All figures are local estimates.

**Model policy.** By default the extension uses your cheapest entitled model (multiplier-sorted).
Run `AI SharePoint: List Copilot Models` to see relative costs (`0×`, `1×`, `10×`) and optionally
pick a preferred default. In chat, the chat UI's model picker wins.

**Resetting.** `AI SharePoint: Reset Copilot Usage Meter` clears the local history (it does not
affect GitHub billing).

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
| Edit Bookmark | Rename / modify a bookmark's saved query (SQL validated read-only) |
| Remove Site Connection | Remove descriptor (+ tokens if last connection in tenant) |
| Ask Copilot (metered) | One-shot prompt; streams into the “AI SharePoint — Copilot” output |
| List Copilot Models | Models with relative cost; optionally set the preferred default |
| Show Usage Dashboard | The webview dashboard |
| Set Copilot Budget | Guided allowance / soft % / hard % editor |
| Reset Copilot Usage Meter | Clear local usage history (confirmed) |
| Export Diagnostics Bundle | The anonymized support bundle (previewed + scanned) |
| Show / Delete Error Reports | Browse redacted error reports; open details; delete (also right-click **Error Reports** in Support & Diagnostics) |
| Rotate Anonymous Install ID | New random ID + hash salt |
| Open Extension Logs | The redacted log channel (level set via the gear menu) |
| Open User Guide / Privacy Notice / Walkthrough | Documentation |

## All settings

| Setting | Default | Notes |
|---|---|---|
| `aiSharePoint.copilot.monthlyPremiumRequestAllowance` | `300` | Gauge denominator |
| `aiSharePoint.copilot.preferredModelFamily` | `""` | Empty = cheapest entitled model |
| `aiSharePoint.budget.mode` | `block` | `block` / `warn` / `off` |
| `aiSharePoint.budget.softLimitPercent` | `80` | Warn threshold |
| `aiSharePoint.budget.hardLimitPercent` | `100` | Block threshold |
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
| Requests blocked by budget | You passed your hard cap → raise it (`Set Copilot Budget`), switch mode to `warn`, or use the one-time override. |
| SQL Server "authentication rejected" but the login works in SSMS | Re-add the source with the guided wizard (it prompts for server, instance, port, database, certificate, and sign-in method separately — answer exactly as in SSMS) and read the appended **“server said: …”** detail: it is SQL Server's own message distinguishing a bad login, an inaccessible database, or a wrong instance. |
| "Could not initialize a Git repository" / repo not detected | Folder outside the workspace, Restricted Mode, or git missing → accept the wizard's "Add to Workspace" offer (or File → Add Folder to Workspace…), trust the window, and check `git --version`. |
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
