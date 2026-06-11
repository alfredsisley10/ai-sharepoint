# Changelog

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
