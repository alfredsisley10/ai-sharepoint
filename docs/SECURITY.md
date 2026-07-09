# AI SharePoint — Security

_Audience: security reviewers and engineers. Companions:
[ADMIN_GUIDE.md](ADMIN_GUIDE.md) (deployment) and [PRIVACY.md](PRIVACY.md) (data handling)._

## Architecture in one diagram

```
┌─ VS Code ────────────────────────────────────────────────────────────┐
│  AI SharePoint extension (pure JS, no native deps, no servers)       │
│                                                                      │
│   Chat/@sharepoint ── LM tools (gated writes) ──┐                    │
│   Commands / views / dashboard (CSP-locked)  │                       │
│        │                                     │                       │
│   CopilotService ──── vscode.lm ────────► GitHub Copilot (user's     │
│        │   (metered, cost-estimated)         own entitlement)        │
│        │                                                             │
│   SharePointClient ── fetch ────────────► graph.microsoft.com        │
│        │                 (Bearer, Sites.Read.All delegated)          │
│   MSAL public client ── system browser/device code ► login.microsoft │
│        │                                              online.com     │
│   SecretStore ────► VS Code SecretStorage ────► OS keychain          │
│   Diagnostics: local capture → redact/anonymize → preview →          │
│                leak-scan → user-chosen file (export is manual)       │
└──────────────────────────────────────────────────────────────────────┘
```

## Secrets

- **Single chokepoint:** every secret (MSAL token cache blobs) flows through `SecretStore` →
  VS Code `SecretStorage` → OS keychain (macOS Keychain / Windows Credential Manager / Linux
  libsecret). Keys are prefixed `aiSharePoint:`; caches are keyed **per tenant**.
- **No secret ever reaches**: settings, workspace files, extension storage, logs, telemetry,
  error reports, or diagnostics bundles (enforced by construction *and* by the export leak
  scan — see Defense in depth).
- **Lifecycle:** *Sign Out* and *Remove Connection* delete the keychain entries (the latter only
  when no other connection shares the tenant cache). Connection descriptors store only a cache
  *handle*, never material.

## Authentication

- **Flows:** MSAL public client — (a) authorization-code + **PKCE** with an ephemeral loopback
  listener on `127.0.0.1` (5-minute timeout, static parameter-free response pages, no reflected
  query content), and (b) **device code**. Silent refresh first in both. No ROPC, no client
  secrets, no embedded webview logins.
- **Authority validation:** the configured authority must be HTTPS and its host must be a known
  Microsoft login endpoint (commercial + sovereign) or explicitly allowlisted via a
  machine-scoped setting. This blocks sign-in redirection even if settings are tampered with.
- **Workspace-tampering resistance:** `auth.tenantAuthority`, `auth.clientId`, and
  `auth.additionalAuthorityHosts` are `"scope": "machine"` (a repository's `.vscode/settings.json`
  cannot set them) **and** are declared in
  `capabilities.untrustedWorkspaces.restrictedConfigurations`.
- **Least privilege:** reads use a single delegated scope — `Sites.Read.All`; users can never read
  more than their own SharePoint permissions allow. Optional **write-back** (ADR-0021) is the only
  SharePoint write path and is **human-approved**: it requests a write scope only on the first
  write — `Sites.Selected` by default (an admin grants the app each target site) or, when an org
  configures it, tenant-wide `Sites.ReadWrite.All`/`Sites.Manage.All` — and every change is
  previewed, drift-checked, and snapshot-guarded before it is applied. Chat/agent write tools
  route through the same previewed, explicitly-confirmed pipeline (see *AI surface*).

## AI surface

- Copilot consumption is exclusively via `vscode.lm` (ADR-0001) — the user's own entitlement,
  no API keys held by the extension, organization Copilot policies apply unchanged.
- Chat context and LM tools use **silent auth only** — an agent loop can enumerate metadata the
  user can already read, but can never trigger interactive sign-in or escalate scopes. Reads
  dominate the tool surface; the write tools that exist (SharePoint write-back, Confluence page
  edits, drafting Teams/Outlook messages, …) are **approval-gated** — each one produces a preview
  and acts only on the user's explicit confirmation, so the agent loop can never write unattended.
- Copilot consumption is **counted locally** — factual request/token counts, plus an optional
  cost estimate at a rate the user configures. There is no budget enforcement; the bound on a
  runaway loop is the user's own Copilot entitlement and their organization's Copilot policy.

## Webview (Copilot Activity Dashboard)

- CSP: `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'` — fresh nonce per
  render, zero external/local resources (`localResourceRoots: []`).
- All dynamic values pass through an HTML-escaper (unit-tested, including script-injection
  cases); charts are extension-side-generated inline SVG, no JS chart library.
- The page's only script wires three buttons to `postMessage`; messages map to fixed command
  IDs with no arguments.

## Logging & diagnostics

- **Redaction chokepoint:** the only logger wraps a `LogOutputChannel` and redacts before
  writing — JWTs, bearer/basic credentials, PEM blocks, secret-bearing query params, emails,
  GUIDs, tenant hostnames (all clouds), non-loopback IPs, and user-profile paths. Error stacks
  are reduced to file basenames. The same `redactError` feeds error reports.
- **Defense in depth for exports:** capture-time redaction → salted pseudonymization at
  assembly → full user preview → a final **blocking leak scan** of the serialized bundle
  (JWT/PEM/bearer/secret/email/raw-tenant patterns). The scan failing closed is unit-tested.
- The anonymous install ID is random (never `vscode.env.machineId`) and rotatable, with the
  hash salt rotating alongside it.

## Supply chain & build

- One production dependency: `@azure/msal-node` (Microsoft). Pure-JS tree verified by a CI gate
  (ADR-0016); no install scripts, no native binaries; esbuild bundle; `vsce ls` shows the full
  package manifest.
- CI: typecheck, 42 unit tests (redaction/anonymization/leak-scan suites included), native-dep
  gate, repo secret scan, VSIX build. No network access needed by tests.

## Known limitations / accepted risks (0.1.0)

| Item | Assessment |
|---|---|
| Loopback redirect uses `http://localhost:<port>` on the local machine | Standard MSAL native-app pattern; PKCE prevents code interception replay; listener binds 127.0.0.1, accepts one code, then closes. |
| Graph errors may transit memory unredacted before capture | Redaction applies at every *egress* (log/report/notification); raw text is never persisted. |
| Site metadata (names of lists/pages) is sent to Copilot as chat context | Inherent to the feature; documented in PRIVACY.md; governed by org Copilot policy; only metadata the user can read. |
| Commercial Graph endpoint only | Sovereign Graph endpoints are roadmap; documented in the Admin Guide. |
| Multiplier table can drift from GitHub pricing | Labeled estimate everywhere; user-adjustable allowance; never presented as billing. |

## Reporting a vulnerability

Report privately to the security contact your distributor provides (for example, a private
security-advisory channel or a dedicated security mailbox). Please do not file public issues for
suspected vulnerabilities. Include an anonymized diagnostics bundle when relevant — it is
designed to be safe to attach.

> Rebranding or redistributing this build? Set your own security contact here as part of the
> white-label steps in [REBRANDING.md](../REBRANDING.md).
