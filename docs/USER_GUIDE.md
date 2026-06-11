# AI SharePoint — User Guide

This guide covers everything in release **0.2.0**. If you only read one section, read
[Quick start](#quick-start); if something breaks, jump to
[Troubleshooting](#troubleshooting) and [Getting help](#getting-help-diagnostics-export).

**The assistant is read-only toward SharePoint**: it can sign in, read sites, lists, and
pages, answer questions, draft plans — and, since 0.2.0, **pull** a site's structure into a
local Git repository pushed to GitHub/GHES. It cannot change anything *in SharePoint* yet;
write-back and AI provisioning are the next roadmap phases (see `docs/PLAN.md`).

---

## Contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Quick start](#quick-start)
4. [Connecting SharePoint sites](#connecting-sharepoint-sites)
5. [The activity-bar views](#the-activity-bar-views)
6. [Chatting with @sharepoint](#chatting-with-sharepoint)
7. [Agent-mode tools](#agent-mode-tools)
8. [Site repositories: SharePoint as code](#site-repositories-sharepoint-as-code-git)
9. [Reference sources: Confluence & Jira](#reference-sources-confluence--jira)
10. [Copilot usage, budget, and the dashboard](#copilot-usage-budget-and-the-dashboard)
9. [Getting help: diagnostics export](#getting-help-diagnostics-export)
10. [All commands](#all-commands)
11. [All settings](#all-settings)
12. [Troubleshooting](#troubleshooting)
13. [FAQ](#faq)

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

| Role | Meaning today | Meaning later |
|---|---|---|
| **managed** | Read access for chat/tools | Full lifecycle: sync to Git, AI provisioning, revert (roadmap) |
| **reference** | Read access for chat/tools | Stays read-only forever — context source only |

Pick *reference* for sites you only want the assistant to read. Roles can be changed any time
from the Sites view context menu.

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

### Sites
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
the count), extension **logs**, the **walkthrough**, this **user guide**, the **privacy
notice**, and **Rotate Anonymous Install ID**.

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

> Not yet serialized (roadmap): navigation, theme, list items/documents, permissions — listed in
> each pull preview. Edit the site in SharePoint and pull; hand-editing repo files becomes
> useful when two-way push ships.

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
- **Read-safety**: results are capped (`context.maxResults`) and cached
  (`context.cacheTtlMinutes`, default 15 min — clear via the view's title button). Sources are
  read-only by construction: there is no write path.
- **Account-lockout protection (important)**: a rejected credential is **never retried
  automatically**; after 3 consecutive failures the source locks (red icon) to protect your
  account from org lockout policies. *Test Context Source* re-prompts for a fresh credential;
  *Reset Source Auth Lockout* (context menu) reopens a locked source — check with your admin
  first.

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
| Add / Test / Remove Context Source · Reset Source Auth Lockout · Clear Reference-Source Cache | Read-only Confluence/Jira sources |
| Remove Site Connection | Remove descriptor (+ tokens if last connection in tenant) |
| Ask Copilot (metered) | One-shot prompt; streams into the “AI SharePoint — Copilot” output |
| List Copilot Models | Models with relative cost; optionally set the preferred default |
| Show Usage Dashboard | The webview dashboard |
| Set Copilot Budget | Guided allowance / soft % / hard % editor |
| Reset Copilot Usage Meter | Clear local usage history (confirmed) |
| Export Diagnostics Bundle | The anonymized support bundle (previewed + scanned) |
| Show / Clear Error Reports | Browse redacted error reports; open details; clear |
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

**Can it modify my SharePoint sites?** Not in this release. All write capabilities (sync,
provisioning, revert) are roadmap items and will arrive behind preview-and-approve gates.

**Where are my credentials?** In your OS keychain, keyed per tenant, removable via Sign Out /
Remove Connection. Never in settings, files, logs, or exports.
