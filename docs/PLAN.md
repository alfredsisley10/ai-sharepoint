# ai-sharepoint — Implementation Plan

A Visual Studio Code extension that uses **GitHub Copilot as the AI provider** to drive
**SharePoint Online** site development and maintenance, with **Git/GitHub** as the system of
record for the site's "code."

> Status: **Releases 0.1–0.4 shipped.** Delivered: Phases 0–1 (§4 cost governor with
> enforcement, §5 auth incl. device-code, §6 secrets/redaction, ADR-0018 diagnostics export);
> §7 sync core — pull, **write-back** (ADR-0021, Graph-based slice), **revert-to-commit**
> (ADR-0005 core) with Git/GitHub-GHES governance (ADR-0019); §8 read-only agent surface (LM
> tools; mutations remain human-approved commands); §9 framework + Confluence/Jira/**LDAP-AD**
> adapters (ADR-0020) with bookmarks (ADR-0010); §10 secret-free config sharing (ADR-0013
> slice). Remaining: nav/theme serialization (live-tenant SP REST), 3-way merge editor,
> agent-initiated mutations, the further §9.2 adapter matrix, multi-workspace switching, the
> local MCP server (ADR-0017). See [`docs/ROADMAP_STATE.md`](./ROADMAP_STATE.md) for live
> state and [`docs/adr/`](./adr) for rationale.

---

## 1. Vision & success criteria

The user opens VS Code, authenticates to a SharePoint Online tenant, and works with a Copilot-backed
chat agent that can:

1. **Answer governance/QA objectives** — *"Verify I have no duplicate content"*, *"Ensure all links
   are working"* — by reading the synchronized site and reporting findings.
2. **Build advanced site elements** — *"Create a polished, customer-facing product-management site…"* —
   by generating and applying SharePoint artifacts (pages, lists, content types, web parts, navigation,
   theming) that remain editable by end users with **native SharePoint functions** afterward.
3. Do all of the above while keeping the user **in control of Copilot spend** and **never leaking
   secrets** into a public repo.

The extension is successful when a user can express a high-level objective in natural language and get
a reviewed, version-controlled, reversible change applied to their site — with full visibility into
what it cost in Copilot usage.

---

## 2. The two constraints that shape everything

Before the feature list, two hard realities drive the whole design. Getting these wrong wastes the
project; the rest of the plan is built around them.

### 2.1 How an extension can *actually* use Copilot

GitHub Copilot has **no general-purpose public API** that arbitrary apps can call with a key. The
supported, ToS-compliant way for a VS Code extension to use Copilot's models is the
**[VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)**
(`vscode.lm`), which routes requests through the **signed-in user's own Copilot entitlement**:

- `vscode.lm.selectChatModels()` → enumerate the models the user is entitled to (this is our
  "what models are available" surface).
- `model.sendRequest()` → run a chat request; `model.countTokens()` → count tokens for a prompt.
- We surface our agent as a **Chat participant** (e.g. `@sharepoint`) via the
  [Chat](https://code.visualstudio.com/api/extension-guides/chat) and
  [Language Model Tools](https://code.visualstudio.com/api/extension-guides/tools) APIs, so the agent
  can call our SharePoint/Git "tools" in an agentic loop.

**Implication for cost tracking (important and honest):** `vscode.lm` exposes **token counts**, not
**dollars** or **premium-request balance**. Copilot's consumer billing is a *premium-request* model
with **per-model multipliers** (the cheap base model is effectively unmetered; stronger models cost a
multiplier of one premium request each). The API does **not** stream us the user's remaining balance.
So our "ongoing cost" feature is necessarily an **estimator**, built from:

- a **maintained model→multiplier table** (shipped with the extension, updatable without a release —
  see §4), and
- our own **request + token meter** for this extension's traffic.

We will be explicit in the UI that this is *our* measured usage against a published multiplier table,
not a live read of the GitHub bill. This honesty is a feature: it's exactly what stops a user from
"unknowingly using up all their tokens." **Decided (ADR-0001):** we standardize on `vscode.lm`; no
direct Copilot/GitHub Models endpoint (out of ToS for Copilot-entitlement consumption).

### 2.2 What "SharePoint site as code" means

SharePoint Online is **not natively file-based**. A site is lists, libraries, **modern pages** (stored
as list items whose `CanvasContent1` is web-part JSON), site columns, content types, navigation,
theme, and permissions. There is no built-in "export the site to a folder of files." So the sync layer
must **define a serialization** — a deterministic mapping between live site artifacts and files on disk
that Git can version and diff.

Our foundation for this is the **PnP Provisioning** model (the closest thing to an official
"site-as-template" representation), complemented by per-artifact JSON for things the template doesn't
capture cleanly (e.g. individual page canvas content). The engine is **PnPjs in-process**
(ADR-0002). The serialization format is detailed in §7.

---

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  VS Code Extension (TypeScript)                                        │
│                                                                        │
│  ┌────────────────┐   ┌──────────────────┐   ┌──────────────────────┐ │
│  │ Chat Agent     │   │ Copilot/Cost     │   │ Command palette &    │ │
│  │ @sharepoint    │──▶│ Governor         │   │ Tree views (Sites,   │ │
│  │ (LM Tools loop)│   │ (model picker,   │   │ Sync status, Cost)   │ │
│  └───────┬────────┘   │  meter, budget)  │   └──────────────────────┘ │
│          │            └──────────────────┘                            │
│          ▼                                                             │
│  ┌───────────────────────── Tool layer (LM tools) ──────────────────┐ │
│  │  SP read/query │ SP apply/provision │ Sync ops │ Git ops │ QA    │ │
│  └───────┬───────────────────┬───────────────────────┬─────────────┘ │
│          ▼                    ▼                       ▼               │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────────────┐  │
│  │ Auth Provider│   │ Sync Engine      │   │ Secret Store         │  │
│  │ (pluggable;  │   │ (serialize,      │   │ (VS Code             │  │
│  │  MSAL public │   │  diff, 3-way     │   │  SecretStorage →     │  │
│  │  client def.)│   │  merge, filters) │   │  OS keychain)        │  │
│  └──────┬───────┘   └────────┬─────────┘   └──────────────────────┘  │
└─────────┼───────────────────┼────────────────────────────────────────┘
          ▼                    ▼
   Microsoft Graph /     Local working tree  ──▶  Git  ──▶  Enterprise GitHub
   SharePoint REST /     (serialized site)
   PnP
```

Seven foundational subsystems, each independently testable:

1. **Copilot Cost Governor** (§4)
2. **SharePoint Authentication** (§5)
3. **Secret Storage** (§6)
4. **Two-way Sync + Git/GitHub** (§7)
5. **Agentic capability layer** (§8) — the payoff that sits on top of 1–4 (and reads 6 for context).
6. **Read-only context-source framework** (§9) — pluggable adapters across collaboration (reference SharePoint, Confluence, Jira), observability (Splunk, SignalFx, AppDynamics, Grafana, Aternity), Microsoft cloud (Intune, Azure & O365 consoles), databases (SQL Server, Oracle, PostgreSQL, MySQL, MongoDB, Databricks), and enterprise apps (ServiceNow, Workday) — sharing auth/bookmarks/backoff/cache/read-safety; no Git/writes.
7. **Workspaces** (§10) — scoped, shareable profiles bundling reference sources + bookmarks + localization; secret-free export.

---

## 4. Pillar 1 — Copilot integration & cost governance

**Goal:** the user always knows which models exist, their relative cost, and the running cost of *this
extension's* usage — and can cap it.

**Model discovery**
- Enumerate via `vscode.lm.selectChatModels()`; show vendor, family, id, max input tokens.
- Annotate each with a **relative-cost badge** from the multiplier table (e.g. `Base ·0×`, `1×`, `≈10×`)
  and a plain-language tier (Economy / Standard / Premium).

**Cost meter — percentage-of-allowance is the headline number** *(per Decision C)*
- Wrap every `sendRequest` in a metering decorator that records: model, input tokens (`countTokens`),
  output tokens, wall time, premium-request units = `multiplier × requestCount`.
- Persist a rolling ledger (per session / day / month) in workspace state.
- The **primary UI is a percentage gauge**, not a dollar figure: *"~35% of your premium-request
  allowance used this month."* We deliberately do **not** show precise billing; a clearly-labeled
  relative estimate is the goal.
- Status-bar item shows the gauge: `◇ 35% · ~3 req today` with hover detail; a **Cost** tree view with
  per-objective breakdown ("this *Create site* task used ~9 premium requests / +4% of allowance").

**Where the gauge's numbers come from — hybrid, auto-first** *(per Decision C / ADR-0003)*. The user
typing in an allowance is the **fallback**, not the default:
- **Numerator (consumed) — auto-read when possible.** Pull actual usage from GitHub's
  [enhanced billing usage REST API](https://docs.github.com/en/rest/billing/usage)
  (`GET /users/{username}/settings/billing/usage`, line items for product = Copilot, SKU = Copilot
  Premium Request) using the VS Code GitHub session. Requires a token with **billing-read** scope and
  an account on the enhanced billing platform; if that scope/grant isn't available, fall back to our own
  `vscode.lm` request/token meter as the numerator.
- **Denominator (allowance/budget) — auto-fill when possible, confirm otherwise.** Derive the included
  allowance/budget from the same usage report where exposed; otherwise prompt once for the user to
  confirm/override.
- **Always keep our own meter running** regardless of billing-API availability, so the gauge works
  before the scope is granted and offline.
- **`vscode.lm` itself exposes no quota/balance** — only tokens — so the REST billing path is the only
  programmatic route to real consumption figures.
- **Heads-up on the billing model shift:** GitHub
  [moved Copilot to usage-based billing on 2026-06-01](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/),
  replacing the fixed monthly premium-request allowance with an included budget + metered overage. The
  gauge is built to read "spend/usage against a budget" so it stays correct under the new model.

**Budget guardrails**
- User sets a soft cap (warn) and hard cap (block) per session/day/month.
- Pre-flight estimate before large agentic runs: *"This objective may take ~8–15 premium requests on
  GPT-class models; proceed / switch to economy model / cancel."*
- Auto-downshift policy: route cheap operations (link checks, summarization) to the base/economy model;
  reserve premium models for generation/reasoning steps.

**Maintainable multiplier table**
- Ship a default `model-costs.json`; allow an updatable copy in user settings; optional fetch of a
  newer table from this repo's `main` so prices can be corrected without an extension release.
- **Never** present the table as the live GitHub bill — label clearly as an estimate.

**Deliverables:** model picker UI, metering decorator, ledger store, status bar + Cost view, budget
settings + enforcement, multiplier table loader.

---

## 5. Pillar 2 — SharePoint authentication (pluggable, MSAL-first)

**Goal:** connect to SharePoint Online sites with a provider abstraction, shipping the **known-good**
method first and leaving room for every other method.

**Provider interface**
```ts
interface SharePointAuthProvider {
  id: string;                       // 'msal-public-interactive', 'device-code', 'cert-app-only', …
  displayName: string;
  acquireToken(scopes: string[]): Promise<AccessToken>;
  supportsSilentRefresh: boolean;
}
```

**Default & priority — MSAL Public Client, interactive browser**
- `@azure/msal-node` `PublicClientApplication`, **authorization-code + PKCE** with a **loopback
  redirect** (system browser → `http://localhost:<port>`).
- Uses the **Microsoft Graph PowerShell first-party app**
  (`14d82eec-204b-4c2f-b7e8-296a70dab67e`) — already validated in the target tenant, broad
  pre-consented delegated Graph scopes, no app registration required by the user.
- Token cache **persisted encrypted** via the Secret Store (§6); silent refresh when possible.

**Other methods to support behind the same interface (future-enabled, stubbed now)**
- Device-code flow (headless / restricted browser environments).
- Custom **registered Azure AD app** (user supplies client id; supports tenant-restricted scopes).
- App-only: **certificate** credential and **client-secret** credential (confidential client) for
  unattended automation.
- VS Code's built-in **Microsoft auth provider** (`vscode.authentication`) as a convenience option
  (limited scopes / VS Code's own app).
- Explicitly **deprecated/​guarded**: ROPC (username/password) — available but warned against.

**Connection management**
- A **Sites** tree view: add/edit/remove site connections; each binds a site URL ↔ auth provider ↔
  cached token reference. Multiple tenants/sites concurrently.
- Each connection has a **role**: **managed** (full sync/Git/revert lifecycle, §7) or **reference**
  (read-only context only — no sync, no Git, no writes; see §9). Both roles use the same auth providers
  above; the role governs what the rest of the system is allowed to do with the connection.
- Connection test command (resolve site, read root web title) before first sync.

**SharePoint operation engine — decided: PnPjs in-process** *(Decision B)*. We use PnPjs
(`@pnp/sp`, `@pnp/graph`) running inside the extension — no PowerShell or module install required on
the host, cleanest packaging. If a future provisioning operation proves un-round-trippable in PnPjs,
we revisit an optional PnP-PowerShell bridge as an isolated add-on (see ADR-0002).

**Deliverables:** auth provider abstraction, MSAL interactive provider (done first, end-to-end),
provider stubs/registration for the rest, Sites tree view, connection test.

---

## 6. Pillar 3 — Secret storage (public-repo-safe)

**Goal:** secrets live on the host, never in the repo, never in code.

- All tokens, refresh tokens, MSAL cache blobs, client secrets, certificate references go through the
  VS Code **`SecretStorage`** API → backed by the **OS keychain** (macOS Keychain / Windows Credential
  Manager / Linux libsecret).
- **Nothing** secret in workspace files, settings JSON, or logs. Config files store **references**
  (key handles), not values.
- Ship a `.gitignore` and a pre-commit guard (e.g. gitleaks/secretlint) so an accidental secret can't
  be pushed to the **public** repo. Redaction layer on all extension logging/telemetry.
- Certificates: store the secret material in the keychain; the working tree holds only a non-secret
  thumbprint/reference.
- **Workspace export is secret-free by construction** (§10): the exporter reads only the non-secret
  config store and has no code path to the keychain, so shared workspace files can never carry
  credentials; a pre-export scan double-checks.

**Deliverables:** secret-store wrapper, config-vs-secret separation, ignore + pre-commit scanning,
log redaction.

---

## 7. Pillar 4 — Two-way sync with Git/GitHub

**Goal:** keep a serialized copy of the **core site** in a local Git working tree, push to Enterprise
GitHub, detect changes made *directly in SharePoint*, and resolve conflicts — syncing the site's
"code," not its bulky static artifacts.

**Three explicit operations** — each runs through the same **preview → approve → apply → commit**
pipeline (no silent writes, every applied change recorded in Git):

1. **Pull & reconcile (SharePoint → local).** Detect changes a user made *directly in SharePoint*
   (including content/data edits, not just structure) since the last sync, and reconcile them against
   local work. This is the inbound half of the 3-way merge below: clean changes fast-forward into the
   working tree; overlaps surface in the merge editor. Pull is the default first step of any sync so we
   never push onto a stale base.
2. **Push (local → SharePoint).** Apply changes developed locally (hand-edited or agent-authored) to
   the live site via PnPjs. Always preceded by a freshness check (an implicit pull); if SharePoint moved
   under us, we reconcile first rather than blindly overwrite. The plan is shown before any write, and
   the per-site review gate (ADR-0004) governs how the resulting commit reaches GitHub.
3. **Revert live site to a prior commit (Git history → SharePoint).** Restore the active SharePoint
   site to the serialized state captured in any earlier commit. Mechanics and guardrails:
   - Compute the diff between the **current live site** and the **target commit's** serialized state,
     then apply the changes needed to make live match target (a *roll-forward to an old state*, not a
     Git history rewrite).
   - **Take a safety snapshot first:** pull current live state into a fresh commit *before* applying, so
     the revert is itself reversible ("undo the undo").
   - **Structure vs. data is explicit.** Reverting structural "code" (pages, columns, content types,
     nav, theme) is well-defined. Reverting **user-entered content/list data** is destructive and often
     undesired, so the revert UI lets the user choose scope — *structure only* (default) vs.
     *structure + content* — and clearly flags what each will delete or overwrite.
   - **Flag non-reversible deltas.** Some changes can't be losslessly inverted (e.g. a since-deleted
     column whose data is gone, lost version history, broken permission inheritance). The preview lists
     these as "cannot fully restore" rather than silently doing a partial job.
   - Requires explicit confirmation showing exactly what will be created/updated/deleted; commits the
     resulting state with a `Revert SharePoint to <sha>` message.

**Serialization (the source-of-truth mapping)**
- Site structure via a **PnP provisioning template** (`template.xml`/`.json`): lists, libraries, site
  columns, content types, navigation, theme, features.
- **Modern pages** as individual files: page metadata + decoded `CanvasContent1` web-part JSON, one
  file per page, so diffs are reviewable and Copilot can edit them.
- Deterministic ordering/formatting so re-serializing an unchanged site produces **no diff** (critical
  for clean change detection).

**Change detection**
- Local side: Git is the truth for local edits.
- Remote side: Microsoft Graph **delta queries** + item `ETag`/`Modified`/`Editor`/`TimeLastModified`
  to find what changed in SharePoint since the last sync.
- Maintain a **last-synced snapshot** (common ancestor) per site to enable real 3-way merges.

**Conflict management**
- **3-way merge** (base = last-synced snapshot, ours = local Git, theirs = live SharePoint).
- Non-overlapping changes auto-merge; overlapping changes surface in VS Code's **merge editor** with
  clear "Local vs. SharePoint" labeling and per-artifact granularity.
- Sync is **transactional/previewed**: show a plan ("apply 3 page edits to SharePoint, pull 1 list
  change locally") before writing anything; dry-run mode.

**Filters (sync the site, not the bulk)**
- Default filter excludes large/binary static artifacts (media libraries, large attachments, packaged
  assets); includes the structural "code" (pages, lists schema, content types, navigation, theme).
- Filter is **user-customizable** (glob + size + content-type rules), shown in a settings UI.
- **GitHub size guidance surfaced in-product:** warn approaching **50 MB**, hard-block at the **100 MB**
  per-file limit; recommend exclusion (or Git LFS) and flag total-repo bloat. We do **not** publish
  artifacts to any registry — GitHub holds the site "code" only.

**Git/GitHub integration**
- Initialize/attach the working tree to a repo, commit per sync with structured messages
  ("Pull: 2 pages changed by <editor> on <date>"), push to **Enterprise GitHub** remote.
- Respect enterprise auth (the active GitHub session / `gh`).
- **Review gate is configurable per site connection** *(Decision D)*: each site chooses **PR-gated**
  (every SharePoint-affecting change opens a pull request for review before merge) or **direct-push**
  (commit straight to a working branch). Default to PR-gated for production-tagged sites.

**Deliverables:** serializer/deserializer, snapshot store, delta-based change detector, 3-way merge +
merge-editor integration, filter engine + size guard UI, Git commit/push pipeline, dry-run/preview,
**pull-and-reconcile**, **push-with-freshness-check**, and **revert-to-commit** (safety snapshot +
structure/content scoping + non-reversible-delta detection) — see ADR-0005.

---

## 8. Pillar 5 — Agentic SharePoint development (the payoff)

Sits on top of pillars 1–4 as **Language Model Tools** the `@sharepoint` agent can call in a loop, with
every mutating action routed through the **preview → approve → apply → commit** path.

**Surfacing to Copilot — dual local surface, one core** *(ADR-0017, research in `docs/research/`).*
Capabilities are exposed two ways over a **single shared capability core** (SharePoint client, sync
engine, §9 framework, bookmarks): (1) **VS Code Language Model Tools** (`registerTool` +
`contributes.languageModelTools`, `when`-gated by role/state) that **Copilot agent mode** auto-invokes
and users `#`-reference; and (2) a **local stdio MCP server** (`registerMcpServerDefinitionProvider` +
`resolveMcpServerDefinition` for keychain auth) exposing the same tools + all §9 data sources to local
MCP clients. **Local-only:** the cloud-hosted GitHub coding agent and the deprecated GitHub-App Copilot
Extension/skillset path are **out of scope**; no secret ever leaves the machine.

**Read/QA tools** (power objectives like *"no duplicate content"*, *"all links working"*)
- Query site structure & content; crawl pages for links and validate (internal + external) with a
  report; detect duplicate/near-duplicate content; surface findings as a reviewable report, optionally
  opening fixes as proposed edits.

**Cross-source tools** (power *"ensure Confluence aligns with the SharePoint product info site"*)
- Read any read-only context source (§9) — reference SharePoint, Confluence, Jira, Splunk, Intune,
  Databricks, SQL Server, including saved **bookmarks** — alongside the managed SharePoint site, compare
  them, and report misalignments. The agent may propose changes to the **managed SharePoint site** only;
  it never writes to a reference source.

**Authoring/provisioning tools** (power *"create a product-management site…"*)
- Create/modify lists, content types, site columns, navigation, theme; compose **modern pages** with
  web parts; wire up structured data (e.g. a Products list driving product-detail pages with
  description, when-to-use / when-not-to-use, cost & billing, how to request, how to get support,
  product/support owner contacts).
- **Maintainability requirement is first-class:** generated sites must stay editable with **native
  SharePoint functions** — prefer out-of-the-box lists, page templates, and web parts over custom code
  (SPFx) so end users can maintain content without the extension. The agent is told to prefer
  no-code/low-code SharePoint primitives.

**Agent guardrails**
- Mutations are **never silent** — the agent proposes a plan, the user approves, changes are applied and
  committed to Git (so everything is reversible/reviewable).
- Cost-aware: the agent reports the estimated premium-request cost of an objective up front (§4) and
  honors budget caps.

**Deliverables:** tool implementations (read/QA + authoring), the `@sharepoint` chat participant +
agent loop, objective→plan→approval UX, link-check and duplicate-detection analyzers, the
product-site authoring recipe as a flagship scenario/test.

---

## 9. Pillar 6 — Read-only context-source framework

**Goal:** let the agent **read** content from many external systems as *context* for managing the
active site — e.g. *"Ensure the Confluence site aligns with the SharePoint product info site,"* or
pulling reference data from a Jira queue, a Splunk search, an Intune policy, a Databricks table, or a
SQL Server query. Every source is **strictly read-only** (no version control, no serialization, no
merge, no write path) and is enforced as such by the connection **role** (§5) and by least-privilege
read scopes. The design is a **framework**: source-specific *adapters* plug into one set of shared
services, so each new system reuses the same auth, bookmarks, backoff, caching, and read-safety.

### 9.1 Shared framework services (every source inherits these)

- **Pluggable auth (all available methods per source).** One `ContextSourceAuthProvider` contract;
  each source ships every auth method its platform supports (matrix in §9.2). Secrets always go through
  the keychain (§6); Microsoft sources reuse the §5 MSAL stack.
- **Standard-user auth first** *(ADR-0014).* Most users will **not** have formal API provisioning
  (app registrations, service accounts, API clients) — they have only their normal *user* access. So
  each adapter prioritizes methods a standard user already has: **interactive browser login** (OAuth /
  SSO, including the §5 MSAL first-party-app pattern) **with the resulting token cached** in the
  keychain, and **Basic auth** (username/password). Privileged API integrations are offered but are
  **not required**; the default per source is the most-accessible working method, not the most
  "official" one.
- **Verify on connect, then guard in active use** *(ADR-0009).* We **cannot assume non-prod test
  instances exist** (most users won't have them; where they do, it's a separate credential in a
  separate auth domain — see Decision E). So safety runs against the user's real access: a single
  deliberate **verification read** confirms a credential right after entry, and thereafter **every
  failed login during active use is tracked**.
- **Auth-method discovery** *(ADR-0015 — resolves Decision K).* Each source supports **all** its
  methods; rather than make the user pick, the framework **probes them and discovers which works for
  this user**, then **saves the working method** as a non-secret descriptor in the workspace. Discovery
  is the verify-on-connect probe and uses a **lockout-safe order** — no-password methods (interactive
  browser / SSO / device-code / token) first, then password-based (Basic) **once, never looped** —
  bounded by the backoff/caps above. The saved method travels in workspace export/import (§10), so a
  teammate starts with the known-good method pre-selected and only supplies their own credential.
- **Lockout-safe auth-failure handling** *(ADR-0009 — security-critical).* Failed authentications are
  tracked per account/credential with **exponential backoff** and a **hard stop below the org lockout
  threshold** (conservative default, e.g. stop after 3 failures). We **never auto-retry a known-bad
  secret** — after a credential failure we require explicit user re-entry rather than re-sending the
  same password. Auth failures (don't retry the secret) are distinguished from transient network
  errors (safe to retry with backoff). A per-account circuit breaker prevents lockouts, which matters
  most for the Basic-auth / standard-user paths above (SQL Server, Confluence/Jira DC, Splunk, Grafana,
  AppDynamics).
- **Bookmarks** *(ADR-0010).* Named, **non-secret** pointers to elements we want to reuse — e.g. a Jira
  saved filter / JSM queue / a queue for a specific person; a `server/db/schema/table` or a named SQL
  query; a Splunk saved search or SPL; a Databricks `catalog.schema.table`; an Intune policy. Stored in
  workspace/user config (locators only — credentials stay in the keychain), surfaced in the Reference
  Sources view and callable by the agent by name.
- **Read-through caching with TTL** *(ADR-0011).* Result sets cache locally for a configurable default
  duration (e.g. 15 min) keyed by source + query/locator, with per-source / per-bookmark TTL overrides,
  manual refresh/invalidate, and cache excluded from Git. Cuts round trips and load on source systems.
- **Non-impacting / read-safe query policy** *(ADR-0012).* Per-source rules to minimize impact:
  **MSSQL** uses `WITH (NOLOCK)` + `READ UNCOMMITTED` + `ApplicationIntent=ReadOnly` + row/`TOP` caps +
  query timeouts; **Splunk** bounds time ranges and caps results; **Databricks** uses read-only SQL with
  row caps; all sources cap result size and time out long queries.
- **Unified surface.** One **Reference Sources** tree view across all source types (add/edit/remove,
  scope, bookmarks, connection test) and one common **agent read/search tool** (§8). Any fixes the agent
  proposes target the **managed SharePoint site only** — never a reference source.
- **Workspace-scoped.** Sources and bookmarks belong to the active **workspace** (§10), so different
  work efforts keep separate reference sets; credentials remain local and are never part of a workspace.

### 9.2 Source adapters (all methods of authentication per source)

| Source | Deployment(s) | Auth methods (all supported) | Read access | Example bookmarks | Read-safety notes |
|---|---|---|---|---|---|
| **Reference SharePoint** | M365 Cloud | §5 MSAL stack (interactive default; device-code; cert / client-secret app-only; custom AAD app; ROPC guarded) | sites, pages, lists, content types (PnPjs) | a site, a list, a view | role-guarded read-only |
| **Confluence** | Cloud + DC/Server | Cloud: API token (Basic), OAuth 3LO, scoped tokens. DC: PAT (Bearer), **Basic (known-good, `atlassian-python-api`-validated)** | spaces, pages, CQL search | a space, a page, a CQL query | read-only scopes |
| **Jira** | Cloud + DC/Server | Same Atlassian methods as Confluence (Cloud: API token / OAuth 3LO / scoped; DC: PAT / Basic) | issues, projects, JQL search, JSM **queues**, saved filters | a JQL / saved filter, a JSM queue, a **queue for a specific person** | read-only scopes |
| **Splunk Cloud** | Cloud | Bearer **auth token (JWT)** — recommended; session-key (login); Basic | SPL via search-jobs REST, saved searches | a saved search, an SPL query, an index/sourcetype | bounded time range + result caps; cache aggressively |
| **Microsoft Intune** | M365 Cloud (Graph) | §5 MSAL stack — delegated interactive default; app-only (cert / secret); managed identity. Graph `deviceManagement` **read** scopes | managed devices, compliance & config policies, apps | a policy, a device group, a saved filter | read-only Graph scopes |
| **Azure Databricks** | Azure | Entra ID via MSAL (AAD token); Databricks **PAT**; OAuth U2M / M2M (service principal); managed identity | Unity Catalog metadata; SQL via Statement Execution API on a SQL warehouse | a `catalog.schema.table`, a SQL query, a warehouse | read-only SQL; row caps; Delta MVCC (no lock hint needed) |
| **Microsoft SQL Server** | On-prem + Azure SQL | SQL auth (user/pass); Integrated/Windows (Kerberos/NTLM); Azure AD (interactive / password / service principal / managed identity); certificate | `SELECT` queries; schema introspection | `server/db/schema/table`, a named query | **`WITH (NOLOCK)`** + `READ UNCOMMITTED` + `ApplicationIntent=ReadOnly` + `TOP`/row caps + timeouts |
| **Aternity (EUEM)** | Cloud (Alluvio/Riverbed) | OAuth 2.0 (client-credentials API client) — recommended; Basic auth (OData feeds) | end-user-experience & app-performance metrics, device health via REST / OData | an OData feed/report, an application, a device/user scope | bounded time ranges + result caps; cache aggressively |
| **SignalFx** (Splunk Observability) | Cloud | API **access/org token** (`X-SF-Token`) — recommended; user session token | metrics, detectors, dashboards, charts via REST / SignalFlow | a SignalFlow program/chart, a detector, a metric/dimension filter | bounded time ranges + result caps; cache |
| **AppDynamics** (APM) | Cloud (SaaS) + on-prem controller | OAuth 2.0 (API client id/secret → bearer) — recommended; Basic auth (`user@account:password`) | applications, business transactions, metrics, health rules, events via Controller REST | an application, a business transaction, a metric path | bounded time ranges + result caps; cache |
| **Grafana** | Cloud + DC/self-hosted | Service-account token / API key (Bearer) — recommended; Basic auth | dashboards, panels, datasources, alerts; datasource-proxy queries via HTTP API | a dashboard, a panel, a datasource query | bounded time ranges + result caps; cache |
| **Azure Console** (ARM) | Azure Cloud | §5 MSAL stack — interactive default; service principal (cert/secret); managed identity; Azure CLI passthrough. ARM **read** roles | subscriptions, resource groups, resources & configs via ARM REST + **Resource Graph** (KQL) | a subscription/RG scope, a Resource Graph query, a resource | read-only RBAC roles; result caps |
| **Office 365 Console** (M365 admin) | M365 Cloud (Graph) | §5 MSAL stack — delegated interactive default; app-only (cert/secret); managed identity. Graph **read** scopes | users, groups, licenses, directory, service health, usage reports via Microsoft Graph | a report, a group, a license/SKU scope | read-only Graph scopes; result caps |
| **Oracle Database** | On-prem + Cloud (OCI) | DB user/password (native); Oracle Wallet; Kerberos/OS auth; Entra ID/IAM integration | `SELECT` queries; schema introspection (`node-oracledb`) | a `service/schema/table`, a named query | read-only session; `FETCH FIRST n ROWS` caps + timeouts; MVCC (no lock hint) |
| **PostgreSQL** | On-prem + Azure/AWS/cloud | password (SCRAM/md5); GSSAPI/Kerberos; certificate; LDAP; Entra ID (Azure PG) | `SELECT` queries; schema introspection (`pg`) | a `db/schema/table`, a named query | `default_transaction_read_only` + `statement_timeout` + `LIMIT`; MVCC |
| **MySQL** | On-prem + Azure/AWS/cloud | native / `caching_sha2_password`; SSL cert; LDAP/PAM; Entra ID (Azure MySQL) | `SELECT` queries; schema introspection (`mysql2`) | a `db/table`, a named query | read-only session + `LIMIT` + `max_execution_time`; InnoDB MVCC |
| **MongoDB** | On-prem + Atlas/cloud | SCRAM (user/password); x.509 cert; LDAP; Kerberos; OIDC; AWS IAM | `find` / `aggregate` reads (`mongodb`) | a `db/collection`, a named find/aggregate | `readPreference=secondary` + `limit()` + `maxTimeMS`; read-only user |
| **ServiceNow** | Cloud | Basic (user/password) — standard-user; OAuth 2.0; mutual TLS | Table API records, encoded-query reads, reports | a table + encoded query, a saved report | `sysparm_limit` + pagination; read-only role; result caps |
| **Workday** | Cloud | OAuth 2.0 (API client / ISU); WS-Security Basic (SOAP) | RaaS reports, REST resources, SOAP web services | a RaaS report, a REST resource, a saved query | report-based reads; pagination + result caps |

> **Reading the matrix:** "recommended" marks the most robust method, but per ADR-0014 the adapter's
> **default is whatever the standard user can actually use** — typically the interactive-browser
> (token-cached) or Basic-auth path — falling back to API-client/service-principal methods only when the
> user has them. Basic and interactive paths are first-class, not deprecated.

**Deliverables:** the `ContextSourceAuthProvider` contract + connection `role` plumbing & sync-engine
guard; standard-user-first auth (interactive-browser token-capture + Basic) per adapter;
**auth-method discovery** (lockout-safe probe → persist working method in the workspace, ADR-0015);
verify-on-connect; the shared services (auth-failure backoff/lockout protection, bookmarks, TTL cache,
read-safe query policy, unified view + agent tool); the source adapters in the matrix above with all
listed auth methods; cross-source alignment objective. See ADR-0006/0007 (Confluence, reference
SharePoint) and ADR-0008–0012 (framework + adapters, backoff, bookmarks, caching, read-safe queries).

---

## 10. Pillar 7 — Workspaces (scoped, shareable profiles)

**Goal:** support many parallel work efforts through named **workspaces**. Each workspace owns its own
reference data sources, bookmarks, and localization, so a user switches between unrelated efforts
cleanly and works efficiently in each. Workspaces are **exportable to share with the team** — but
**secrets and authentication details never leave the local machine**.

**What a workspace contains (non-secret config only)**
- Reference-source **descriptors**: source type, base URL/host, the **discovered working auth *method***
  (the descriptor only — e.g. `confluence-dc-basic`, ADR-0015), scopes, role — but **never credentials**.
- **Bookmarks** (locators, ADR-0010).
- **Localization**: language/locale, date & number formats, time zone, units.
- Optional per-workspace settings (active managed-site binding, sync filter profile, cost caps).

**Secrets stay local (always).** Credentials live in the keychain (§6), keyed per machine/user; a
workspace references a secret only by **handle**, never by value. The keychain is never part of a
workspace.

**Switching & storage.** An active-workspace selector swaps the visible sources, bookmarks, and
localization; multiple workspaces are stored locally and switched without reauthentication beyond what
each machine already holds.

**Export / import — secret-free by construction** *(ADR-0013)*
- Export emits a portable definition (JSON/YAML) drawn **solely from the non-secret config store** —
  source descriptors (incl. the **discovered working auth method**, ADR-0015), bookmarks, localization.
  The exporter has **no code path to the keychain**, so no tokens, passwords, MSAL caches, or API keys
  can be included; a **pre-export scan** asserts the file is secret-free (defense in depth with §6).
- On import, the recipient gets sources/bookmarks/localization pre-populated **with the known-good auth
  method already selected**, is **prompted to supply their own credentials** (stored in their own
  keychain), and re-verifies on connect (re-discovering if that method no longer works for them).
- Because exports are secret-free, they are safe to commit/share even in the public repo — though we
  still recommend treating them as internal config.

**Deliverables:** workspace model + local store; active-workspace switcher; workspace-scoping of
sources/bookmarks/localization; persisted **discovered auth method** per source (ADR-0015); secret-free
export/import with pre-export scan; localization settings. See ADR-0013, ADR-0015.

---

## 11. Tech stack & repo layout

- **Language:** TypeScript; VS Code Extension API (`vscode.lm`, Chat, LM Tools, `SecretStorage`,
  `authentication`).
- **Auth:** `@azure/msal-node`. **SharePoint:** PnPjs (`@pnp/sp`, `@pnp/graph`) in-process.
  **Git:** `simple-git` / VS Code Git API; GitHub via the active session / `gh`.
- **Context sources (read-only):** Confluence/Jira via official REST (Cloud + DC); reference SharePoint
  + Intune via PnPjs / Microsoft Graph; Splunk via search-jobs REST; Databricks via the SQL Statement
  Execution API; SQL Server via `mssql`/`tedious`; Oracle (`node-oracledb`), PostgreSQL (`pg`), MySQL
  (`mysql2`), MongoDB (`mongodb`); Aternity (REST/OData), SignalFx (`X-SF-Token` REST), AppDynamics
  (Controller REST), Grafana (HTTP API); ServiceNow (Table API), Workday (RaaS/REST/SOAP). All behind
  the §9 adapter framework.
- **Cross-platform (ADR-0016):** runs on macOS, Windows x64, **Windows ARM**, and Linux from one VSIX —
  pure-JS deps only (no native binaries), no OS/CPU pinning, no shell-outs. A CI gate verifies the
  dependency tree stays native-free; the one caveat is future DB drivers like `node-oracledb`.
- **Build:** TypeScript + esbuild bundle (`vscode` external); `@azure/msal-node` for the MSAL loopback
  flow.
- **Quality gates:** gitleaks/secretlint pre-commit; unit + integration tests; a sandbox tenant for
  end-to-end sync/auth tests.

```
src/
  copilot/      model discovery, metering, budget, multiplier table
  auth/         provider interface + msal-public + stubs, Sites view
  secrets/      SecretStorage wrapper, redaction
  sync/         serializer, snapshot, delta, merge, filters, git
  context/      read-only framework: auth-failure backoff, bookmarks, TTL cache, read-safe query policy
    adapters/   reference-SharePoint, confluence, jira, splunk, intune, databricks, mssql,
                oracle, postgres, mysql, mongodb, aternity, signalfx, appdynamics, grafana,
                azure-console, o365-console, servicenow, workday
    Sources view, role guard
  workspace/    workspace model + store, switcher, secret-free export/import, localization
  core/         shared capability core (one impl behind both LM tools and MCP)
  agent/        chat participant, LM tools, analyzers, authoring recipes
  mcp/          local stdio MCP server + mcpServerDefinitionProvider (ADR-0017)
  ui/           tree views, status bar, settings, merge integration
docs/           PLAN.md, adr/
```

---

## 12. Phased roadmap

| Phase | Outcome | Key risk retired |
|------|---------|------------------|
| **0. Spike** | Prove `vscode.lm` model enumeration + a metered request; prove MSAL interactive auth with the Graph PowerShell app reads a site. | The two §2 constraints. |
| **1. Foundations** | Secret store, MSAL provider end-to-end, Sites view, Cost Governor (discovery + meter + caps), **workspace model + switcher**. | Auth, secrets, cost visibility, scoping. |
| **2. Sync core** | Serialize→Git→push; remote delta detection; dry-run + filters + size guard. | "Site as code" round-trips cleanly. |
| **3. Conflicts** | 3-way merge + merge-editor; direct-in-SharePoint edits handled; revert-to-commit. | Two-way correctness + safe revert. |
| **4. Agent — QA & cross-source** | `@sharepoint` with read/QA tools; link-check + duplicate-content; context-source **framework** (shared auth-failure backoff, auth-method discovery, bookmarks, TTL cache, read-safe queries) + first adapters (reference SharePoint, Confluence, Jira) + alignment objective. | Agentic loop + tool safety; read-context + lockout safety + auth discovery. |
| **5. Agent — authoring & surfaces** | Provisioning tools; flagship product-management-site scenario; maintainability validation; **dual exposure — LM tools (agent mode) + local MCP server** over a shared core (ADR-0017). | The headline use case + Copilot agent-mode/MCP access. |
| **6. Hardening & more sources** | Remaining adapters (Splunk, Intune, Databricks, SQL Server, Aternity, SignalFx, AppDynamics, Grafana) + all auth methods, **workspace export/import (secret-free)**, perf, telemetry/redaction, docs, marketplace packaging. | Breadth, sharing & release. |

---

## 13. Decisions

**Resolved** (see [`docs/adr/`](./adr) for rationale):
- **A — Copilot consumption:** `vscode.lm` only. No direct API-key path (Copilot doesn't offer one
  within ToS). → ADR-0001.
- **B — SharePoint engine:** PnPjs in-process. → ADR-0002.
- **C — Cost model:** a **percentage-of-allowance gauge**, **hybrid auto-first** (auto-read consumed
  usage via the billing REST API; manual entry only as fallback), not precise billing. → ADR-0003.
- **D — Review gate:** **configurable per site connection** (PR-gated or direct-push). → ADR-0004.
- **F — Confluence deployment:** support **both** Cloud and Data Center/Server; default provider chosen
  per connection (Cloud API token / DC PAT / OAuth 3LO). → ADR-0006.
- **G — Read-only context sources:** reference SharePoint sites **and** Confluence are read-only context
  only; no Git, no writes, enforced by connection role + read-only scopes. → ADR-0006, ADR-0007.
- **H — Context-source framework:** a growing set of read-only adapters — collaboration, observability,
  Microsoft cloud, databases (SQL Server, Oracle, PostgreSQL, MySQL, MongoDB, Databricks), and
  enterprise apps (ServiceNow, Workday) — on a shared framework (all-methods auth, lockout-safe backoff,
  bookmarks, TTL cache, read-safe queries incl. MSSQL `NOLOCK` and MVCC read-only sessions elsewhere).
  → ADR-0008–0012. Adding a source = one adapter.
- **I — Workspaces:** scoped profiles (reference sources + bookmarks + localization) with **secret-free
  export and import**; credentials always stay in the local keychain. → ADR-0013.
- **J — Standard-user auth first:** adapters default to methods a normal user already has —
  interactive-browser (token-cached) and Basic — not privileged API integrations, which remain optional.
  → ADR-0014.
- **K — Auth-method discovery + persistence:** ship **all** methods, **probe to discover** which works
  for the individual user (lockout-safe order), and **save the working method** in the workspace config
  so it's pre-selected and shareable (descriptor only; credentials stay local). → ADR-0015.
- **L — Cross-platform:** one VSIX for macOS / Windows x64 / Windows ARM / Linux; pure-JS, no native
  binaries, no OS-specific code. → ADR-0016.
- **M — Copilot surface integration (local-only):** expose capabilities as **VS Code Language Model
  Tools** (agent mode) **+ a local stdio MCP server** over one shared core. **Out of scope:** cloud
  coding agent, remote/hosted MCP, and the deprecated GitHub-App Copilot Extension/skillset path. →
  ADR-0017.
- **E — No reliance on non-prod test instances:** we **do not assume** users have sandbox instances
  (most won't; where they do it's a separate credential in a separate auth domain). Safety is enforced
  at runtime against real access — verify-on-connect plus active-use failed-login tracking — not via a
  test environment. Multi-instance testing is *supported* but *not required*. (Resolved as a design
  stance; → ADR-0009/0014.)

**Still open:** none. (The former Decision K — per-source standard-user method confirmation — is
resolved by **auth-method discovery + persistence**, ADR-0015: the system probes and learns the working
method instead of requiring it to be confirmed up front. A non-prod environment for end-to-end testing
remains *nice-to-have*, not required.)

---

## 14. Key risks

- **Copilot API scope:** `vscode.lm` exposes tokens, not dollars/balance — mitigated by the
  estimator + caps, and by clear labeling. If GitHub later exposes usage, we wire it in.
- **Round-trip fidelity:** not every SharePoint artifact serializes losslessly. Start with a supported
  subset (pages, lists, content types, nav, theme); explicitly scope what's *not* synced.
- **Conflict edge cases:** concurrent edits to the same page region — mitigated by 3-way merge +
  human-in-the-loop merge editor; never auto-overwrite.
- **Maintainability drift:** agent could produce sites users can't maintain natively — mitigated by a
  hard preference for OOB/no-code primitives and a maintainability check in Phase 5.
- **Secret leakage into a public repo:** mitigated by SecretStorage + ignore rules + pre-commit
  scanning + log redaction.
- **Read-only context boundary:** the integration must never write to a reference source (any §9
  adapter) — enforced by the connection **role** (sync/Git refuse `reference` connections), read-only
  scopes where applicable, and shipping no write path for these sources.
- **Account lockout from bad credentials:** repeated auth attempts could lock real accounts — and we
  can't assume a sandbox to test against — so it's mitigated at runtime against real access:
  verify-on-connect, per-account failure tracking, exponential backoff, a hard stop below the org
  lockout threshold, and never auto-retrying a known-bad secret (ADR-0009). This matters most for the
  standard-user / Basic-auth paths we prioritize (ADR-0014).
- **Query impact on source systems:** read queries could load production systems — mitigated by the
  read-safe query policy (MSSQL `NOLOCK`/`READ UNCOMMITTED`/`ReadOnly`, row/time caps, Splunk bounded
  ranges) and the TTL cache reducing round trips (ADR-0011, ADR-0012).
- **Stale or sensitive cached data:** cached reference data can go stale or hold sensitive content —
  mitigated by configurable TTLs + manual refresh, and by excluding the cache from Git.
- **Secret leakage via workspace export:** a shared workspace could carry credentials — mitigated by
  secret-free-by-construction export (no keychain code path) + a pre-export scan; import re-prompts for
  each user's own credentials (ADR-0013).
- **Tool/MCP exposure widening access:** surfacing capabilities to agent mode and local MCP clients
  could broaden what the agent can reach — mitigated by `when`-gating, role-guarded read-only tools, and
  a **local-only** stdio MCP server (no remote/cloud endpoint, no secret egress); the same auth/read
  guards as direct use apply (ADR-0017).
