# Changelog

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
