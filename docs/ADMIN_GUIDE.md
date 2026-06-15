# AI SharePoint — Enterprise Administration Guide

For IT administrators deploying release **0.4.x** into managed environments. Companion
documents: [SECURITY.md](SECURITY.md) (threat model / data flows) and [PRIVACY.md](PRIVACY.md)
(data handling, exports).

---

## 1. What this extension is (one paragraph for the review board)

A VS Code extension that lets users connect to SharePoint Online sites they already have access
to (delegated — their own permissions, never more) and ask a GitHub-Copilot-backed assistant
about them, with local counting of the requests it makes (no estimated billing — GitHub is the
authoritative usage source). Site changes are
human-approved commands only (previewed, drift-checked, snapshot-guarded); the AI cannot write. It runs entirely client-side: **no
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
| `graph.microsoft.com` | Site/list/page reads (`Sites.Read.All`); write-back adds `Sites.ReadWrite.All` + `Sites.Manage.All` (delegated, consent at first write) | Site features |
| `microsoft.com/devicelogin` (user's browser, any device) | Device-code completion page | Device-code sign-in only |
| GitHub Copilot service endpoints | AI requests — made by the **GitHub Copilot extension**, not by this extension directly | Chat / Ask Copilot |

The extension itself opens **no other** connections: no update checks, no telemetry posts, no
CDN fetches. The Copilot Activity dashboard webview loads zero external resources (CSP `default-src
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
| Database sources (optional) | Your SQL Server (1433), PostgreSQL (5432), MySQL (3306), MongoDB (27017) hosts — direct TCP, read-only (ADR-0022) |
| Communications (optional) | `graph.microsoft.com` (same host as site reads) — Teams chats / Outlook mail, send-capable scopes only on first use (ADR-0025). Teams **Incoming Webhook** alternative posts to `*.webhook.office.com` (or the Power Automate `*.logic.azure.com` host of the configured webhook) — no Graph, no consent |
| Vertex AI Search (optional) | `discoveryengine.googleapis.com` (or regional `*-discoveryengine.googleapis.com`); SSO tokens come from the local gcloud CLI — no Google endpoints are contacted for auth by the extension itself (ADR-0026) |
| Power BI (optional) | `api.powerbi.com` — read-only Table/executeQueries REST (ADR-0027) |
| ServiceNow (optional) | Your instance host (`*.service-now.com` or custom) — read-only Table API (ADR-0028) |
| Splunk (optional) | Your Splunk management endpoint (typically `:8089`) — read-only SPL search jobs (queued at the concurrency cap like Splunk Web, always cleaned up), write/exfil commands blocked client-side, default 24 h window (ADR-0029) |
| Splunk Observability Cloud (optional) | `api.<realm>.signalfx.com` (e.g. `api.us1.signalfx.com`) — read-only metadata/state GETs, access token via `X-SF-TOKEN` (ADR-0032) |
| Grafana (optional) | Your Grafana host (`*.grafana.net` or self-hosted) — read-only `/api/*` GETs with a Viewer service-account token (ADR-0033) |

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
   is requested automatically by MSAL) → **Grant admin consent**. Optional feature scopes —
   each requested **only** when a user first uses that feature (incremental consent), never
   for reads:
   - **Write-back** (ADR-0021): `Sites.ReadWrite.All` (pages) + `Sites.Manage.All`
     (lists/columns).
   - **Communications** (ADR-0025 — Teams/Outlook drafts the user approves per message):
     `User.ReadBasic.All` (recipient resolution), `Chat.ReadWrite` (create chat + post),
     `Mail.ReadWrite` (mailbox draft), `Mail.Send` (send on approval). Tenant DLP/compliance
     applies — messages send as the user. **No-consent Teams alternative:** if you won't grant
     `Chat.ReadWrite`, users can deliver to a Teams **channel** via an **Incoming Webhook**
     (channel-owner-created connector or a Power Automate “Workflows” webhook) — no app
     registration, no admin consent, no Graph token; the webhook URL is stored in the user's OS
     keychain. Posts go to the channel (not 1:1 chats) and can't @-mention. Outlook drafts
     (`Mail.ReadWrite`, no `Mail.Send`) are the other no-send-consent path.
   - **Power BI** (ADR-0027): *Power BI Service* API → Delegated → `Workspace.Read.All` +
     `Dataset.Read.All` (read-only; the user's Power BI licenses/roles/RLS govern access).
     **No-consent alternative:** users can instead sign in **as the Azure CLI first-party
     app** — either through the installed CLI (`az login`) or, with nothing installed, via the
     extension's MSAL browser/device-code sign-in using the Azure CLI's public client id
     (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`). The app is already authorized for the Power BI
     service, so no app registration or per-app approval is needed; access remains delegated
     and license/RLS-governed, conditional access applies, and sign-in logs attribute the
     session to "Microsoft Azure CLI". Pasted short-lived tokens (e.g. from shell.azure.com)
     are the last resort.
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

  // Diagnostics capture is local-only; followVSCode defers to your telemetry stance
  "aiSharePoint.diagnostics.usageCapture": "followVSCode",
  "aiSharePoint.diagnostics.errorCapture": true,

  // Optional org policies (machine-scoped where marked)
  "aiSharePoint.context.allowSchemaIndexing": true,   // machine-scoped: Copilot schema indexing (names only)
  "aiSharePoint.sync.allowedRemoteHosts": ["github.com", "ghes.corp.example"],
  "aiSharePoint.ldap.caCertificatesFile": "/etc/pki/corp-roots.pem"
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
- **Write-back governance (ADR-0021):** writes to SharePoint are command-driven and
  human-approved only (the AI cannot apply changes); every push shows an operation-level
  preview, re-checks the live site for drift, commits a pre-push safety snapshot, applies
  sequentially with stop-on-first-error, and reconciles the repo afterwards. Deletions require
  a per-push opt-in; system libraries are never deleted; *Revert Site to Commit* uses the same
  pipeline. Writes are attributable to the user in SharePoint audit logs (delegated auth).
- Git itself must be installed (the built-in VS Code Git extension is used). Credential setup
  (HTTPS credential manager, SSH keys) follows your existing developer onboarding.

## 7. Reference sources (Confluence / Jira / LDAP / AD / databases / Vertex / Power BI / ServiceNow) — notes for admins

- Strictly **read-only**: the extension ships no write path to these systems; results are
  size-capped and cached briefly on the client.
- Standard-user credentials (Atlassian API tokens / DC PATs / AD passwords) are stored per
  machine in the OS keychain and wiped on source removal.
- **Lockout protection:** rejected credentials are never auto-retried and three consecutive
  failures freeze the source until an explicit user reset — designed to stay below typical
  account-lockout thresholds (ADR-0009). This matters most for **Active Directory**, where the
  bind account is a real user account.

### Databases (ADR-0022)

- **Read-only by layered construction**: a strict SQL guard (single SELECT/WITH statement;
  DML/DDL/EXEC/SELECT-INTO blocked — for SQL Server this guard is the write-barrier since
  T-SQL has no read-only session), plus server-side read-only sessions (PostgreSQL/MySQL),
  `READ UNCOMMITTED` + `readOnlyIntent` on MSSQL, `secondaryPreferred` on MongoDB, and row
  caps/timeouts everywhere. Recommend provisioning **read-only accounts** for users.
- Auth rejections feed the same lockout breaker as every source; TLS uses the OS trust store
  plus the shared pinned bundle (`aiSharePoint.ldap.caCertificatesFile`).
- Oracle is excluded (native-binary driver conflicts with the portable-VSIX rule, ADR-0016).
- **Schema indexing (ADR-0024):** with per-source user consent, table/column **names and types
  only — never row data** — can be sent to the user's own Copilot to build a semantic index
  (e.g. `group_cio` → ownership). Disable org-wide with
  `aiSharePoint.context.allowSchemaIndexing: false` (machine-scoped, workspace-immutable in
  untrusted workspaces). Catalogs live in VS Code global storage and are wiped with the source.

### Vertex AI Search (ADR-0026), Power BI (ADR-0027), ServiceNow (ADR-0028)

- **Vertex AI Search:** read-only `:search` / `:answer` calls. Default sign-in mode asks the
  workstation's **gcloud CLI** for a live SSO token per call (nothing stored); the fallback is
  a pasted OAuth access token in the OS keychain. The extension never holds Google refresh
  tokens or service-account keys.
- **Power BI:** reuses the Microsoft 365 sign-in (delegated `Workspace.Read.All` +
  `Dataset.Read.All`); no separate credential exists. Queries are DAX via `executeQueries` —
  a read-only API — and the user's licenses, workspace roles, and row-level security are
  enforced by the service.
- **ServiceNow:** read-only Table API. Recommend a least-privilege **read-only integration
  account** (Basic) or an OAuth token; ACLs on the instance govern what is visible. The same
  lockout breaker protects the account.
- **Catalog pre-cache:** users may pre-cache Confluence/Jira catalogs (spaces/projects/queues)
  for fast local browsing. Loading is paged and pauses for a "keep loading?" confirmation every
  `context.catalogCheckpointSeconds` (default 15 s), so large instances are never hammered;
  caches expire after `context.catalogTtlHours` (default 24 h).
- **Verbose wire logging** (`aiSharePoint.logging.verboseWire`, default off): full
  request/response detail from every integration to the local log for debugging — secrets
  redacted in layers (auth headers masked, token bodies withheld, credentials structurally
  absent), result data summarized, never exported in diagnostics bundles (see PRIVACY.md).

### LDAP / Active Directory (ADR-0020)

- **Auto-discovery** uses only the workstation's own configuration: the DNS domain from
  `USERDNSDOMAIN` / host FQDN / `resolv.conf`, then standard AD **SRV** lookups —
  `_gc._tcp.<domain>` (global catalog, ports 3268/3269) and `_ldap._tcp.dc._msdcs.<domain>`
  (domain controllers, ports 389/636). No server addresses are hard-coded; users can always
  enter one manually. The base DN is derived as `DC=…` from the domain.
- **Transport:** LDAP is raw TCP/TLS to the DC — it does **not** traverse the VS Code/HTTP
  proxy. Ensure workstations can reach your DCs/GC on 636/3269 (preferred) or 389/3268.
- **TLS / internal CA:** LDAPS contexts trust, in addition to Node's bundled roots: the **OS
  trust store** (via Node's system-CA API on current VS Code runtimes), standard Linux CA
  bundles, `NODE_EXTRA_CA_CERTS`, and an admin-pinned PEM bundle via
  `aiSharePoint.ldap.caCertificatesFile` (machine-scoped) — point that at your corporate
  root+intermediate chain for a deterministic result on any runtime. A failure surfaces as
  "LDAPS certificate not trusted" with these options in the message.
  `aiSharePoint.ldap.tlsRejectUnauthorized` defaults to **true**; only disable for isolated labs.
- **Remote/VPN users:** Node's resolver bypasses Windows NRPT / VPN split-DNS, and VPN clients
  apply corporate DNS with a delay after connect. The extension retries SRV lookups with
  backoff and remembers the last-good DC per source; for determinism, distribute
  `aiSharePoint.ldap.dnsServers` (machine-scoped) with your internal DNS server IPs —
  reachable by IP over the tunnel regardless of split-DNS rules.
- **Durable endpoints:** DNS-discovered sources store the SRV lookup itself
  (`ldaps+srv://_gc._tcp.<domain>`), re-resolved per connection with ranked failover — rotating
  or replacing DCs requires **no client reconfiguration**. Failover never re-sends a rejected
  credential to another DC (lockout protection). Only manually entered servers are pinned.
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
