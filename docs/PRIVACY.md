# AI SharePoint — Privacy & Data Notice

_This notice is bundled with the extension (Support view → “Privacy & Data Notice”) so it is
available offline and version-matched._

## The one-sentence version

This extension **transmits nothing on its own by default**: everything it records stays on your
machine. Data leaves only by your choice, two ways — the **Export Diagnostics Bundle** command
(shows you the exact content first, anonymizes it at capture time, and refuses to export if a
final scan finds anything secret-shaped), or **opt-in usage telemetry** to a Splunk/OTEL endpoint
*you* configure (off by default; anonymized categorical metrics only — never content or PII).

## What the extension stores locally

| Data | Where | Contents | Control |
|---|---|---|---|
| Site connection descriptors | VS Code extension storage (global) | Site URL, display name, role, auth method id, tenant host, your UPN as last-signed-in account, timestamps | Remove via *Remove Site Connection* |
| Auth tokens / MSAL cache | **OS keychain** (via VS Code SecretStorage), one entry per tenant | Access/refresh tokens issued to you | Wipe via *Sign Out* / *Remove Connection* |
| Activity ledger | Extension storage | Per-day aggregates + a short tail of recent records: model id, token counts, task label (e.g. `chat`), success flag. **Never prompt or response text**, and no billing estimates | *Reset Copilot Activity Counters* |
| Feature-usage counters | Extension storage | Event names (e.g. `command`, `chat.request`, and resilience counters `chat.sendFailure`, `chat.autoRetry`, `chat.proxySuspected`, `context.probe`, `network.check`) with counts per day; tiny allowlisted **categorical** properties only (e.g. `kind=overflow`, `result=blocked`). **Never** prompt/response text, hosts, or error messages | `diagnostics.usageCapture` setting; *defaults to following VS Code's telemetry setting*. Stored locally; only forwarded off-machine if you opt into external telemetry (below) |
| Error reports | Extension storage | Classified code (e.g. `graph.forbidden`), **redacted** message and stack (no tokens, emails, GUIDs, IPs, hostnames, or user paths; stack frames keep file basenames only), occurrence counts | `diagnostics.errorCapture` setting; *Clear Error Reports* |
| Anonymous install identity | Extension storage | A random UUID + a random hash salt. **Not** `machineId`, not hardware-derived | *Rotate Anonymous Install ID* |

What is **never stored, anywhere**: your prompts, AI responses, SharePoint content (list items,
page bodies, documents), passwords, or raw tokens outside the keychain.

### Verbose wire logging (opt-in)

`aiSharePoint.logging.verboseWire` writes the full request/response detail of every integration
to the local **AI SharePoint output channel** for debugging. Redaction is layered and
fail-closed: authorization headers are reduced to their scheme (`Bearer ***`), sign-in/token
endpoint bodies are **withheld entirely**, credential-shaped fields are masked, database/LDAP
**result data is summarized (counts and column names), never dumped**, and every line passes the
same redaction filter that guards diagnostics exports. Wire logs live only in the VS Code log
folder on your machine and are **not** part of the diagnostics bundle.

## What the extension sends, and to whom

| Destination | What | When |
|---|---|---|
| Microsoft Entra / Microsoft Graph | Standard sign-in flows; delegated read requests for sites you connect | When you connect/test/ask about a site |
| GitHub Copilot (via VS Code's Language Model API) | Your chat/ask prompts plus, when relevant, site context (site name, description, list names, page titles) | When you use AI features |
| Your Splunk HEC / OTEL endpoint (**opt-in, off by default**) | Anonymized, categorical usage metrics + environment (event name, OS/VS Code version, extension version, anonymous install id). **Never** free-form text, prompts, content, or PII — non-categorical values are dropped before send | Only if you enable external telemetry and configure an endpoint (*Support & Diagnostics → Usage Telemetry*) |
| Anyone else | **Nothing.** We host no telemetry endpoint, crash uploader, or update pings — external telemetry goes only to an endpoint *you* own | — |

Copilot traffic is governed by your organization's GitHub Copilot data policies — this extension
adds no extra AI data path.

## The diagnostics bundle, in detail

Produced only by **AI SharePoint: Export Diagnostics Bundle**, in three steps you can verify:

1. **Anonymized assembly.** The bundle contains: extension/VS Code versions, OS platform +
   architecture, the anonymous install ID, an anonymized settings snapshot, connection
   *summaries* (tenant as `anon-xxxxxxxxxx.sharepoint.com` salted hash, role, auth method,
   verified flag), usage aggregates (per-day/model/task numbers), feature counters, and the
   redacted error reports. Identifier-shaped values are replaced by **salted short-hashes**
   (SHA-256 with a local random salt) so reports from the same install correlate without
   revealing the value. The salt itself is never exported.
2. **Preview.** The human-readable Markdown rendering opens in an editor; nothing has been
   written to disk. You confirm — or cancel.
3. **Leak scan.** The serialized JSON is scanned for JWTs, PEM blocks, bearer/basic
   credentials, password/secret assignments, email addresses, and raw (un-anonymized) tenant
   hostnames. Any such finding **blocks the export entirely**. GUID/IP-shaped strings produce a
   warning listed in the confirmation dialog.

You choose where the `.json` (+ `.md` companion) is saved and how it travels. Rotating the
anonymous ID severs the link between future and past bundles.

## Your controls, summarized

- `aiSharePoint.diagnostics.usageCapture`: `followVSCode` (default) / `on` / `off`
- `aiSharePoint.diagnostics.errorCapture`: `true` / `false`
- Commands: *Reset Copilot Activity Counters* · *Clear Error Reports* · *Rotate Anonymous Install ID*
  · *Sign Out of Site* · *Remove Site Connection*
- And the strongest control of all: the export simply never runs unless you run it.
