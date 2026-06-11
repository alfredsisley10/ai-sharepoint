# AI SharePoint

**Govern and explore SharePoint Online with GitHub Copilot — with metered usage, budget
guardrails, enterprise-grade authentication, and privacy-first diagnostics.**

AI SharePoint connects Visual Studio Code to your SharePoint Online tenant and puts a
Copilot-backed assistant next to it. Ask `@sharepoint` about your sites, get live overviews of
lists and pages, plan site structures — while every AI request is metered against **your own
Copilot entitlement** and capped by **your budget**, and while every credential stays in **your
OS keychain**. Nothing this extension collects ever leaves your machine unless you explicitly
export it.

> **Release 0.1.0 — governed foundation.** This release ships the connection, chat/agent,
> cost-governance, and operability layers. Two-way site sync with Git and AI-driven provisioning
> (the [project plan](docs/PLAN.md)'s later phases) build on top of this foundation and are not
> yet included — the assistant is **read-only** toward SharePoint today.

---

## Features

### 💬 `@sharepoint` chat participant
- Ask about your connected sites in natural language; the assistant reads live site context
  (silently — it never pops a sign-in window from a chat question).
- Slash commands: `/site` (live overview), `/sites`, `/usage`, `/help`.
- In **Copilot agent mode**, four read-only tools are available for auto-invocation or
  `#`-referencing: `#spConnections`, `#spSiteOverview`, `#spPages`, `#spUsage`.

### 🔐 Enterprise-grade sign-in
- **System-browser sign-in** (authorization-code + PKCE on a loopback port) or **device-code
  sign-in** for VDI, remote hosts, and locked-down desktops.
- Works in commercial, **GCC High (`.sharepoint.us`)** and **21Vianet (`.sharepoint.cn`)** clouds.
- Tokens cached **per tenant** in the OS keychain (macOS Keychain / Windows Credential Manager /
  Linux libsecret) — never in files, settings, or the repo. One-click **sign out** wipes them.
- Bring your own Entra app registration (`aiSharePoint.auth.clientId`) when your tenant blocks
  the default first-party app. Auth settings are **machine-scoped** so a malicious workspace
  cannot redirect your sign-in.

### 📊 Copilot cost governance
- Every request is metered: model, tokens, and **premium-request units** from a maintained
  multiplier table — clearly labeled an **estimate**, never presented as the GitHub bill.
- **Status-bar gauge** (`% of monthly allowance`) turns yellow at your soft cap and red at the
  hard cap, which **blocks** further requests (with per-request override).
- **Usage Dashboard** webview: 30-day chart, per-model and per-task breakdowns, budget bar.
- Economy-first model policy: the cheapest entitled model is used unless you pick another.

### 🩺 Privacy-first diagnostics (built for secure environments)
- Feature-usage counters and **redacted** error reports are stored **locally only**.
- **Export Diagnostics Bundle** produces an anonymized JSON + Markdown pair: salted-hash
  pseudonyms instead of tenant names, no emails/GUIDs/tokens/paths, **previewed** in full and
  **leak-scanned** before a single byte is written. Share it with IT or the development team
  through whatever channel your enterprise permits.
- Anonymous install ID is random and **rotatable** — never your machine ID.

### 🗂 Sites, Usage, and Support views
A dedicated activity-bar container with connection management (test, role change, sign-out,
remove), live usage/budget breakdowns, and one-click access to logs, error reports, the user
guide, and the privacy notice.

---

## Getting started

1. Install **GitHub Copilot** (and sign in) — AI features run through your own entitlement via
   the official VS Code Language Model API.
2. Install this extension's VSIX (`Extensions: Install from VSIX…`) or from your private gallery.
3. Run **AI SharePoint: Connect SharePoint Site** (or use the Sites view) — pick a role
   (*managed* or read-only *reference*) and a sign-in method.
4. Open Chat and ask `@sharepoint /site` — or just ask a question about your site.
5. Run **AI SharePoint: Set Copilot Budget** to fit the gauge to your plan.

The in-product **walkthrough** (`AI SharePoint: Open Getting Started Walkthrough`) covers all of
this interactively.

## Documentation

| Document | Audience |
|---|---|
| [User Guide](docs/USER_GUIDE.md) | Everyone — every command, view, and workflow |
| [Admin Guide](docs/ADMIN_GUIDE.md) | IT — deployment, network allowlist, Entra app options, settings management |
| [Security](docs/SECURITY.md) | Security review — threat model, data flows, endpoints |
| [Privacy & Data Notice](docs/PRIVACY.md) | Everyone — what is stored, what an export contains |
| [Plan](docs/PLAN.md) & [ADRs](docs/adr) | Engineering — architecture and decisions |

## Develop

```bash
npm install
npm run compile      # bundle to dist/ (or: npm run watch)
npm run typecheck    # tsc --noEmit
npm test             # unit tests (node:test)
npm run check:native # ADR-0016 gate: pure-JS dependency tree
npm run scan:secrets # PLAN §6 gate: no secret-shaped content in the repo
npm run package      # produce the VSIX
```

Press <kbd>F5</kbd> to launch the Extension Development Host. Copilot features require the GitHub
Copilot extension installed and signed in; SharePoint features require a Microsoft 365 account.

## Telemetry

This extension **transmits nothing**. Local capture of usage counters defers to VS Code's
telemetry setting by default (`aiSharePoint.diagnostics.usageCapture`), and error capture can be
disabled entirely. Data leaves the machine only through the explicit, previewed, leak-scanned
diagnostics export. See [PRIVACY.md](docs/PRIVACY.md).

## License

[MIT](LICENSE)
