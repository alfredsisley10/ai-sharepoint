# Changelog

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
