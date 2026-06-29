# AI SharePoint

**Govern and explore SharePoint Online with GitHub Copilot — with metered usage, budget
guardrails, enterprise-grade authentication, and privacy-first diagnostics.**

AI SharePoint connects Visual Studio Code to your SharePoint Online tenant and puts a
Copilot-backed assistant next to it. Ask `@sharepoint` about your sites, get live overviews of
lists and pages, plan site structures — while every AI request is metered against **your own
Copilot entitlement** and capped by **your budget**, and while every credential stays in **your
OS keychain**. Nothing this extension collects ever leaves your machine unless you explicitly
export it.

> **Release 0.71.0.** Shipped: governed Copilot chat/agent surface, enterprise auth
> (browser + device-code, custom Entra app, sovereign clouds), site-as-code **pull / write-back /
> revert** with Git + GitHub/GHES governance (ADR-0019/0021/0005), read-only reference sources
> (Confluence, Jira, **LDAP/Active Directory with DNS auto-discovery**, **GitHub/GHES**, databases,
> and more), bookmarks, secret-free team config sharing, local Copilot activity metering,
> **opt-in anonymized telemetry** (Splunk HEC / OTEL — off by default), white-label packaging,
> and the anonymized diagnostics pipeline. The AI itself remains read-only — every SharePoint
> write is a previewed, snapshot-guarded human command.

---

## Features

### 💬 `@sharepoint` chat participant
- Ask about your connected sites in natural language; the assistant reads live site context
  (silently — it never pops a sign-in window from a chat question).
- Slash commands: `/site` (live overview), `/sites`, `/usage`, `/help`.
- In **Copilot agent mode**, 40+ tools are available for auto-invocation or `#`-referencing.
  The reads run freely — site overviews, pages, usage, reference-source search
  (`#spSiteOverview`, `#spPages`, `#spUsage`, `#spSources`, `#spSearchContext`, `#spContextItem`,
  `#spBookmarks`, …). Every **write** tool (SharePoint write-back, Confluence page edits, drafting
  a Teams/Outlook message, …) is **approval-gated** — it produces a preview and only acts on your
  explicit confirmation; the agent loop can never write unattended.

### 🔐 Enterprise-grade sign-in
- **System-browser sign-in** (authorization-code + PKCE on a loopback port) or **device-code
  sign-in** for VDI, remote hosts, and locked-down desktops.
- Works in commercial, **GCC High (`.sharepoint.us`)** and **21Vianet (`.sharepoint.cn`)** clouds.
- Tokens cached **per tenant** in the OS keychain (macOS Keychain / Windows Credential Manager /
  Linux libsecret) — never in files, settings, or the repo. One-click **sign out** wipes them.
- Bring your own Entra app registration (`aiSharePoint.auth.clientId`) when your tenant blocks
  the default first-party app. Auth settings are **machine-scoped** so a malicious workspace
  cannot redirect your sign-in.

### 📊 Copilot activity visibility
- Every request the extension makes is counted locally: model, tokens, success/failure —
  **factual counts only**. Premium-request consumption against your plan is **not estimated**:
  without an authoritative source it would mislead; your GitHub billing page is that source.
- **Status-bar counter** shows today's request count; the **Copilot Activity** view and
  dashboard break the month down by model and task.
- **Activity Dashboard** webview: 30-day request chart, per-model and per-task breakdowns.
- Economy-first model policy: the cheapest entitled model is used unless you pick another.

### 🩺 Privacy-first diagnostics (built for secure environments)
- Feature-usage counters and **redacted** error reports are stored **locally only**.
- **Export Diagnostics Bundle** produces an anonymized JSON + Markdown pair: salted-hash
  pseudonyms instead of tenant names, no emails/GUIDs/tokens/paths, **previewed** in full and
  **leak-scanned** before a single byte is written. Share it with IT or the development team
  through whatever channel your enterprise permits.
- Anonymous install ID is random and **rotatable** — never your machine ID.

### 🔁 SharePoint as code (pull · write-back · revert)
Mirror a managed site's lists, columns, and modern pages into a local Git repo; push to
GitHub.com or your corporate GHES behind a machine-scoped host allowlist and PR gate. Edit the
files (or let the assistant draft edits), commit, and **Apply Repository to SharePoint** —
previewed, drift-checked, safety-snapshotted, deletions opt-in. **Revert Site to Commit**
restores any earlier snapshot through the same pipeline.

### 📚 Read-only reference sources
Confluence and Jira (Cloud/Data Center) plus **LDAP/Active Directory with DNS auto-discovery**
(SRV records from your workstation's domain) — all lockout-safe (a rejected credential is never
auto-retried; 3 strikes freezes the source), cached, result-capped, and shareable with the team
via secret-free config export/import.

### 🗂 SharePoint Sites, Reference Sources, Usage, and Support views
A dedicated activity-bar container with connection management (test, role change, sign-out,
remove), reference sources + bookmarks, live usage/budget breakdowns, and one-click access to
logs, error reports, the user guide, and the privacy notice.

---

## Getting started

1. Install **GitHub Copilot** (and sign in) — AI features run through your own entitlement via
   the official VS Code Language Model API.
2. Install this extension's VSIX (`Extensions: Install from VSIX…`) or from your private gallery.
3. Run **AI SharePoint: Connect SharePoint Site** (or use the SharePoint Sites view) — pick a role
   (*managed* or read-only *reference*) and a sign-in method.
4. Open Chat and ask `@sharepoint /site` — or just ask a question about your site.

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

## Develop / build

Plain npm — the **same commands on macOS, Linux, and Windows**. `--verbose` gives full
install diagnostics (useful behind a proxy or a private registry).

**macOS / Linux (bash/zsh):**

```bash
npm install --verbose
npm run compile      # bundle to dist/ (or: npm run watch)
npm run typecheck    # tsc --noEmit
npm test             # unit tests (node:test)
npm run check:native # ADR-0016 gate: pure-JS dependency tree
npm run scan:secrets # PLAN §6 gate: no secret-shaped content in the repo
npm run package      # produce the VSIX
```

**Windows (PowerShell):**

```powershell
npm install --verbose
npm run compile
npm run typecheck
npm test
npm run package
```

`cmd.exe` is identical — the npm commands are the same on every platform.

### Behind a corporate proxy or private registry (internal TLS certs)

If your registry/proxy presents internally-issued certificates, **don't blanket-disable TLS** —
work through these in order. Keep `--verbose` throughout so you can see exactly which host and
which dependency is involved.

**1. Trust the OS certificate store** (recommended; Node 22.9+). Set `--use-system-ca` before installing:

```bash
# macOS / Linux (bash/zsh)
export NODE_OPTIONS=--use-system-ca
npm install --verbose --no-audit --no-fund
```

```powershell
# Windows PowerShell
$env:NODE_OPTIONS = '--use-system-ca'
npm install --verbose --no-audit --no-fund
```

```bat
:: Windows cmd.exe
set NODE_OPTIONS=--use-system-ca
npm install --verbose --no-audit --no-fund
```

**2. Add the specific CA bundle.** If a dependency still fails on a self-signed CA the OS store
doesn't have (or you're on older Node), point `NODE_EXTRA_CA_CERTS` at your corporate CA bundle —
bash `export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`, PowerShell
`$env:NODE_EXTRA_CA_CERTS = 'C:\path\to\corp-ca.pem'`, cmd `set NODE_EXTRA_CA_CERTS=C:\path\to\corp-ca.pem` —
then re-run the install.

**3. Last resort — ignore TLS errors (⚠️ security risk).** Only if (1)–(2) can't be arranged and
you are on a **trusted** network. `--strict-ssl=false` disables certificate verification, so the
install is exposed to man-in-the-middle tampering; use it for a single install, then re-enable:

```bash
npm install --strict-ssl=false --verbose
npm config set strict-ssl true   # re-enable afterward
```

On a quarantining registry that withholds just-released versions (e.g. `could not find
prettier-3.9.3.tgz`), the relaxed `^X.0.0` ranges let `npm install` fall back to the prior (N-1)
release — delete any stale `package-lock.json` first so it isn't pinned to the withheld version.

### Windows: `npm warn cleanup` / "operation not permitted, rmdir"

These are **warnings, not errors** — the install still succeeds. npm fetches per-platform binaries
(esbuild ships one per OS) and prunes the ones this machine doesn't need; antivirus / Explorer /
OneDrive often hold those folders open, so the cleanup `rmdir` is denied. Confirm with
`npm run package`. To avoid the noise, build in a local (non-synced) folder and exclude it from
antivirus.

Press <kbd>F5</kbd> to launch the Extension Development Host. Copilot features require the GitHub
Copilot extension installed and signed in; SharePoint features require a Microsoft 365 account.

## Telemetry

**Out of the box this extension transmits nothing**, and there is no built-in vendor endpoint —
local capture of usage counters defers to VS Code's telemetry setting (`aiSharePoint.diagnostics.usageCapture`),
and error capture can be disabled entirely.

Two paths can send data off the machine, both controlled by you:

- the explicit, previewed, leak-scanned **diagnostics export** (a manual, one-time file you choose
  to share); and
- **opt-in usage telemetry** to a Splunk HEC and/or OTEL (OTLP) endpoint *you* configure (off by
  default). When enabled, only anonymized, categorical metrics + environment are sent — never
  free-form text, content, or PII — and connection details/tokens are stored write-only in the OS
  keychain (never shown again, never in settings, never in an export).

See [PRIVACY.md](docs/PRIVACY.md) for exactly what each path includes.

## Redistributing / white-labeling

This build ships without a fixed publisher identity or repository link. To distribute it under
your own identity, see **[REBRANDING.md](REBRANDING.md)** — it lists every identity field to set
and how to repackage the `.vsix`.

## License

[MIT](LICENSE)
