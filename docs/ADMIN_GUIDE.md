# AI SharePoint — Enterprise Administration Guide

For IT administrators deploying release **0.2.x** into managed environments. Companion
documents: [SECURITY.md](SECURITY.md) (threat model / data flows) and [PRIVACY.md](PRIVACY.md)
(data handling, exports).

---

## 1. What this extension is (one paragraph for the review board)

A VS Code extension that lets users connect to SharePoint Online sites they already have access
to (delegated, read-only in this release) and ask a GitHub-Copilot-backed assistant about them,
with local metering and budget caps on Copilot consumption. It runs entirely client-side: **no
vendor service, no telemetry transmission, no stored server-side state**. Credentials live in
the OS keychain via VS Code SecretStorage; diagnostics never leave the machine except by
explicit, previewed, leak-scanned user export.

## 2. Deployment

### VSIX distribution
Build (`npm ci && npm run package`) or take the CI artifact (`ai-sharepoint-<version>.vsix`), then:

- **Manual:** Extensions view → `…` → *Install from VSIX…*, or
  `code --install-extension ai-sharepoint-<version>.vsix`.
- **Fleet:** distribute via your software-management tooling invoking the `code
  --install-extension` CLI per user, or host in a **private extension gallery** (e.g. an
  internal marketplace) so updates flow normally.
- The package is platform-neutral (pure JS, ADR-0016): one VSIX for macOS, Windows x64,
  Windows ARM, Linux. No native binaries, no install scripts.

### Prerequisites per user
- VS Code ≥ 1.95 and the **GitHub Copilot** extension with an entitled account (your existing
  Copilot for Business/Enterprise rollout governs models and policies).
- A Microsoft 365 account with access to the SharePoint sites they'll connect.

### Remote development (SSH / WSL / containers / Codespaces)
The extension runs on the workspace side (`extensionKind: ["workspace"]`). The browser loopback
sign-in may not be reachable from remote hosts — users should pick **device-code sign-in**
there. SecretStorage on remote hosts is provided by VS Code's secret bridge to the local client.

## 3. Network endpoints

Allow these HTTPS (443) endpoints from developer machines:

| Endpoint | Purpose | When |
|---|---|---|
| `login.microsoftonline.com` (or sovereign: `login.microsoftonline.us`, `login.partner.microsoftonline.cn`) | Microsoft Entra sign-in (MSAL public client) | Sign-in / token refresh |
| `graph.microsoft.com` | Site/list/page reads (delegated `Sites.Read.All`) | Site features |
| `microsoft.com/devicelogin` (user's browser, any device) | Device-code completion page | Device-code sign-in only |
| GitHub Copilot service endpoints | AI requests — made by the **GitHub Copilot extension**, not by this extension directly | Chat / Ask Copilot |

The extension itself opens **no other** connections: no update checks, no telemetry posts, no
CDN fetches. The Usage Dashboard webview loads zero external resources (CSP `default-src
'none'`).

**Sovereign-cloud note:** sign-in authorities for GCC High / 21Vianet are configurable
(`aiSharePoint.auth.tenantAuthority`); Graph calls currently target the commercial
`graph.microsoft.com` endpoint — full sovereign Graph endpoints are on the roadmap. Pilot
accordingly.

### Additional endpoints by feature
| Feature | Endpoints |
|---|---|
| Reference sources (optional) | Your Atlassian hosts: `*.atlassian.net` (Cloud) and/or internal Confluence/Jira Data Center hosts — read-only REST |
| Site repository push (optional) | `github.com` and/or your GitHub Enterprise Server host — via the user's own git |

### Proxies and TLS inspection (MITM)
**Every** outbound request the extension makes — Microsoft Graph reads *and* Microsoft Entra
sign-in/token traffic (MSAL is wired to a custom network client) — travels through the extension
host's `fetch`, i.e. VS Code's networking layer. That means it follows:

- **Proxy settings**: `http.proxy` if set, otherwise the OS/system proxy, per VS Code's
  `http.proxySupport` behavior (default `override`). Authenticated proxies are handled by VS
  Code's proxy support.
- **Trust store**: VS Code loads operating-system certificates by default
  (`http.systemCertificates`: `true`), so TLS-inspecting proxies work as long as your corporate
  root CA is deployed to the OS trust store (standard in managed fleets).

If sign-in fails with `network_error` while normal browsing works, verify in order: (1) the
machine's OS trust store contains the inspection CA, (2) `http.proxy`/system proxy is visible to
VS Code (`Developer: Show Logs… → Network`), (3) `login.microsoftonline.com` (or your sovereign
authority) and `graph.microsoft.com` are allowlisted on the proxy. PAC-file edge cases follow VS
Code's own behavior — test one machine before fleet rollout.

## 4. Entra ID options

### Default: Microsoft Graph PowerShell first-party app
Out of the box the extension signs in as the well-known **Microsoft Graph PowerShell**
public-client app (`14d82eec-204b-4c2f-b7e8-296a70dab67e`) with delegated `Sites.Read.All`.
Many tenants already permit it; consumption is delegated-only, so users can never exceed their
own SharePoint permissions.

If your tenant requires admin consent for it, grant consent in Entra admin center →
*Enterprise applications*.

### Recommended for managed fleets: bring your own app registration
1. Entra admin center → *App registrations* → **New registration** (single tenant).
2. **Authentication** → *Add a platform* → **Mobile and desktop applications** → add redirect
   URI `http://localhost` and enable **Allow public client flows** (required for device code).
3. **API permissions** → *Microsoft Graph* → *Delegated* → `Sites.Read.All` (+ `offline_access`
   is requested automatically by MSAL) → **Grant admin consent**.
4. Distribute settings (machine scope — see §5):
   - `aiSharePoint.auth.clientId`: your app (client) ID.
   - `aiSharePoint.auth.tenantAuthority`: `https://login.microsoftonline.com/<your-tenant-id>`
     (locks sign-in to your tenant and lets conditional access target the app precisely).

Benefits: your own conditional-access policies, sign-in logs attributed to a named app, ability
to disable the first-party app entirely.

### Conditional access / MFA / VDI
Both sign-in methods are standard MSAL public-client flows and respect CA policies. For
environments where the browser loopback breaks (kiosk/VDI, no default browser, restrictive
redirect handling), **device-code** is the supported path — consider communicating it as the
default for those user groups.

## 5. Managing settings centrally

Auth-critical settings are **machine-scoped**: they can only be set in user/machine settings,
never by a workspace — and they're additionally declared as restricted in untrusted workspaces.
Distribute them via your settings-management mechanism (managed `settings.json`, profile
defaults, or imaging):

```jsonc
{
  // Lock sign-in to your tenant + your app registration
  "aiSharePoint.auth.tenantAuthority": "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000",
  "aiSharePoint.auth.clientId": "11111111-1111-1111-1111-111111111111",

  // Fit the gauge to your Copilot plan; keep hard-blocking on
  "aiSharePoint.copilot.monthlyPremiumRequestAllowance": 300,
  "aiSharePoint.budget.mode": "block",
  "aiSharePoint.budget.softLimitPercent": 80,
  "aiSharePoint.budget.hardLimitPercent": 100,

  // Diagnostics capture is local-only; followVSCode defers to your telemetry stance
  "aiSharePoint.diagnostics.usageCapture": "followVSCode",
  "aiSharePoint.diagnostics.errorCapture": true
}
```

The authority host is validated against known Microsoft login endpoints; a non-standard host
(e.g. ADFS) must be explicitly allowlisted in `aiSharePoint.auth.additionalAuthorityHosts`
(machine-scoped) or sign-in refuses to start.

## 6. Site repositories: GitHub.com / GitHub Enterprise Server governance

Site sync (ADR-0019) serializes SharePoint structure into local Git repos and pushes via **the
user's own git** — the extension holds no Git credentials and never force-pushes.

- **Egress control:** pushes are only possible to hosts in the machine-scoped setting
  `aiSharePoint.sync.allowedRemoteHosts` (default `["github.com"]`). Add your GHES host to
  enable internal pushes; remove `github.com` to forbid cloud pushes entirely. Validation runs
  at configure time and again at every push; workspaces cannot override it.
- **Recommended server-side setup** for site repos: protect the base branch (require PRs +
  review, disallow force pushes), and keep the extension's **PR-gated** mode (default) so every
  site snapshot lands as a reviewable pull request — the compare-URL flow works identically on
  github.com and GHES.
- **Content gates:** pulls refuse to write when credential-shaped content is detected inside
  serialized site data, and enforce GitHub's file-size limits (warn 50 MB / block 100 MB).
- Git itself must be installed (the built-in VS Code Git extension is used). Credential setup
  (HTTPS credential manager, SSH keys) follows your existing developer onboarding.

## 7. Reference sources (Confluence / Jira / LDAP / AD) — notes for admins

- Strictly **read-only**: the extension ships no write path to these systems; results are
  size-capped and cached briefly on the client.
- Standard-user credentials (Atlassian API tokens / DC PATs / AD passwords) are stored per
  machine in the OS keychain and wiped on source removal.
- **Lockout protection:** rejected credentials are never auto-retried and three consecutive
  failures freeze the source until an explicit user reset — designed to stay below typical
  account-lockout thresholds (ADR-0009). This matters most for **Active Directory**, where the
  bind account is a real user account.

### LDAP / Active Directory (ADR-0020)

- **Auto-discovery** uses only the workstation's own configuration: the DNS domain from
  `USERDNSDOMAIN` / host FQDN / `resolv.conf`, then standard AD **SRV** lookups —
  `_gc._tcp.<domain>` (global catalog, ports 3268/3269) and `_ldap._tcp.dc._msdcs.<domain>`
  (domain controllers, ports 389/636). No server addresses are hard-coded; users can always
  enter one manually. The base DN is derived as `DC=…` from the domain.
- **Transport:** LDAP is raw TCP/TLS to the DC — it does **not** traverse the VS Code/HTTP
  proxy. Ensure workstations can reach your DCs/GC on 636/3269 (preferred) or 389/3268.
- **TLS / internal CA:** Node validates LDAPS certs against its own bundled CA list, **not** the
  OS trust store. If your DCs present an internal-CA certificate, either deploy that CA to a
  location Node trusts (e.g. `NODE_EXTRA_CA_CERTS`) or have users enable StartTLS
  (`aiSharePoint.ldap.useStartTls`) appropriately. `aiSharePoint.ldap.tlsRejectUnauthorized`
  defaults to **true**; only disable it for isolated lab testing.
- **Least privilege & read-safety:** simple bind as the user's own account; bind + search only;
  every search carries server-side size and time limits; only non-sensitive attributes are
  requested. Consider a dedicated low-privilege read account if you prefer not to use personal
  credentials, though the standard-user path is the default (ADR-0014).

## 8. Data, support, and offboarding

- **What's stored where:** see [PRIVACY.md](PRIVACY.md) — connection descriptors and local
  meters in VS Code extension storage; tokens only in the OS keychain.
- **Support flow:** users export an anonymized diagnostics bundle (previewed + leak-scanned)
  and hand it to your service desk or attach it to a vendor issue. Bundles carry a random,
  rotatable install ID — no user/machine/tenant identifiers. Your service desk can safely
  forward them externally.
- **Offboarding / shared machines:** *Sign Out of Site* or *Remove Site Connection* wipes the
  tenant's MSAL token cache from the keychain. Uninstalling the extension removes its
  SecretStorage entries per VS Code's standard behavior; keychain hygiene tooling can also
  target entries prefixed `aiSharePoint:`.
- **Audit:** sign-ins appear in Entra sign-in logs (under the chosen app); SharePoint reads are
  delegated Graph calls attributable to the user.

## 9. Verifying a build (supply-chain checks)

From a clean checkout:

```bash
npm ci
npm run typecheck && npm test        # 42 unit tests, incl. redaction/leak-scan suites
npm run check:native                 # ADR-0016: dependency tree is pure JS
npm run scan:secrets                 # repo contains nothing secret-shaped
npm run package                      # reproduces the VSIX
npx @vscode/vsce ls                  # list exactly what ships in the package
```

CI (`.github/workflows/ci.yml`) runs the same gates on every push and uploads the VSIX
artifact. The only runtime dependency is `@azure/msal-node` (Microsoft's auth library); the
bundle is built with esbuild and ships no install/postinstall scripts.
