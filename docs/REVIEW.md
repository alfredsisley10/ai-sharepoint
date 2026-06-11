# Enterprise readiness review — `main` (Phase 0 spike)

- Date: 2026-06-11
- Scope: everything on `main` as of `bbb6743` — plan, ADRs, source, build, packaging.
- Verdict up front: **the architecture and documentation are unusually strong for a spike; the
  implementation is a credible Phase 0 but is not yet shippable to an enterprise user.** The gaps are
  concrete and closable: no UI surfaces beyond five palette commands and a status-bar item, no
  support/diagnostics path, no budget enforcement, no tests/CI, no marketplace packaging metadata,
  and a handful of correctness/security findings listed below. The 0.1.0 release on this branch
  addresses every item marked **[addressed]**.

---

## 1. What is genuinely good (keep)

| Area | Assessment |
|---|---|
| **ADR discipline** | 17 ADRs + a 600-line plan with resolved decision log. Rare at this stage; makes the project auditable — exactly what enterprise architecture review boards want. |
| **ToS-correct Copilot use** | `vscode.lm` only (ADR-0001), no scraped/back-door Copilot API. This is the single most important compliance decision and it is right. |
| **Honest cost model** | Percentage-of-allowance *estimate*, clearly labeled, never impersonating the bill (ADR-0003). Honesty-as-a-feature framing holds up. |
| **Secrets posture** | All secret material flows through `SecretStorage` → OS keychain; config stores handles, not values. MSAL cache encrypted at rest via keychain. Correct by construction. |
| **Auth flow** | MSAL public client, auth-code + PKCE, ephemeral loopback port, 5-minute timeout, silent-refresh-first. Matches Microsoft's recommended native-app pattern. |
| **Cross-platform purity** | Pure-JS dependency tree, no shell-outs, no path pinning (ADR-0016). One VSIX for macOS/Win x64/Win ARM/Linux. |
| **Code quality** | Strict TS, small modules, isolated clock (`nowIso`), clean DI through constructors. Easy to extend — which this release does. |

## 2. Consistency findings (plan ↔ implementation ↔ packaging)

| # | Finding | Severity | Status |
|---|---|---|---|
| C1 | PLAN §11 repo layout promises `sync/`, `context/`, `workspace/`, `agent/`, `mcp/`, `core/` — none exist. Expected at Phase 0, but nothing in the README scoped what *is* implemented vs. planned per phase. | Low | **[addressed]** README now states the phase and scopes shipped vs. planned features explicitly. |
| C2 | PLAN §4 promises budget caps ("soft cap warn, hard cap block"), a Cost view, and model auto-downshift; none implemented. The status bar shows a percentage with no enforcement behind it. | High | **[addressed]** Budget guard (soft/warn + hard/block + explicit override), Usage & Budget tree view, economy-model default policy. |
| C3 | PLAN §5 promises a Sites tree view, connection test, and provider stubs; only a palette command existed; no way to list, test, sign out of, or remove a connection (offboarding gap — see S4). | High | **[addressed]** Sites view with test/remove/sign-out/role change; device-code provider added behind the same interface. |
| C4 | PLAN §6 promises log redaction and pre-commit secret scanning; neither existed (no logging layer at all beyond raw output). | High | **[addressed]** Central redacting logger; redaction unit-tested; CI secret-pattern gate. |
| C5 | `package.json` lacked icon, license, keywords, gallery banner, `capabilities` declarations; no LICENSE or CHANGELOG file. `vsce package` warns and a marketplace/private-gallery listing would look abandoned. | Medium | **[addressed]** Full marketplace metadata, LICENSE (MIT), CHANGELOG, icon, walkthrough. |
| C6 | No tests and no CI of any kind, while ADR-0016 explicitly defines a CI gate ("no `.node`, no gyp" is "a CI gate, not a one-time check") that therefore did not exist. | High | **[addressed]** Unit tests (node:test), native-dep gate script, GitHub Actions workflow that typechecks, tests, scans, and packages the VSIX. |
| C7 | Usage ledger (`UsageMeter`) stores an **unbounded** array in `globalState` and rewrites it on every request. Months of use → multi-MB state writes per request. | Medium | **[addressed]** Ledger compaction: per-day/per-model/per-label aggregates with a capped recent-record tail. |
| C8 | A metered request that fails or is cancelled mid-stream records **nothing**, but a premium request is consumed at send time. The meter systematically under-counts on flaky networks. | Medium | **[addressed]** Metering moved to a `finally` path — recorded with whatever output tokens were received. |
| C9 | MSAL cache handle is keyed **per site URL** (`msal-cache:<url>`), so two sites in the same tenant force two interactive sign-ins and two cache blobs. | Low | **[addressed]** Cache keyed per tenant host; existing per-site caches still read (migration). |
| C10 | `SitesStore` lives in `workspaceState`: connections vanish when the user opens a different folder. Site connections are user-level resources until PLAN §10 workspaces exist. | Medium | **[addressed]** Moved to `globalState` with one-time migration from `workspaceState`. |

## 3. Security findings

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | `aiSharePoint.auth.tenantAuthority` is a plain workspace-overridable setting. A malicious repo's `.vscode/settings.json` could silently redirect interactive sign-in to a hostile authority. | **High** | **[addressed]** Auth settings are `machine`-scoped and declared in `capabilities.untrustedWorkspaces.restrictedConfigurations`; authority host is validated against an allowlist before use. |
| S2 | Raw Graph error bodies (which can carry tenant/site identifiers and odata diagnostics) flow unredacted into notifications and any future logs. | Medium | **[addressed]** All logging passes through a redaction layer (JWTs, bearer values, emails/UPNs, GUIDs, tenant hostnames); notifications show sanitized summaries with details in the log. |
| S3 | No way to capture or export error state meant the de-facto enterprise support path would be screenshots of raw error toasts — uncontrolled data egress. | High | **[addressed]** Anonymized diagnostics bundle with preview + leak-scan before anything is written (see §5). |
| S4 | No sign-out/credential wipe: removing a connection had no command, and nothing deleted the keychain blobs (offboarding/shared-workstation gap). | High | **[addressed]** Sign out per connection and remove-with-secret-wipe; both wipe the MSAL cache from the keychain. |
| S5 | The loopback success page reflects the AAD `error` query parameter into HTML without encoding (`Sign-in failed: ${error}`) — low-impact reflected content on localhost, but trivially avoidable. | Low | **[addressed]** Static, parameter-free response pages; details only in the redacted log. |
| S6 | `connectSite` URL validation accepts only `*.sharepoint.com` — blocks GCC High/DoD (`sharepoint.us`), 21Vianet (`sharepoint.cn`) tenants. A *functional* finding with a security edge: forcing users to bypass validation breeds workarounds. | Medium | **[addressed]** Sovereign-cloud domains accepted; matching Graph/login endpoints documented in the admin guide. |

## 4. Enterprise usefulness assessment

**The concept earns its place.** Intranet/comms teams maintain SharePoint estates with no
review/version-control story; "site-as-code + Copilot + spend governance + local-only secrets" is a
real gap in the market. The decisions most enterprises will probe — where do tokens live (keychain),
what leaves the machine (nothing), what does the AI cost (estimated %-of-allowance with caps) — all
have defensible answers in the ADRs.

**What an enterprise pilot would have blocked on (now closed in 0.1.0):**

1. **No support path** — the moment the extension misbehaves inside a locked-down tenant, the user
   has nothing to send IT or the vendor. → the anonymized diagnostics export (§5) is purpose-built
   for this.
2. **No conditional-access realism** — interactive loopback auth fails in VDI/thin-client setups and
   wherever default-browser policies interfere; enterprises need **device-code flow**. → shipped.
3. **First-party Graph PowerShell client ID is increasingly blocked** by tenant policy; enterprises
   need to bring their own app registration. → `aiSharePoint.auth.clientId` (machine-scoped).
4. **No budget enforcement** — a cost *display* without caps fails the plan's own bar ("user in
   control of spend"). → soft/hard caps with explicit override.
5. **No discoverable UI** — palette-only is not deployable to non-developer site owners. → activity
   bar container with Sites/Usage/Support views, welcome views, a walkthrough, and a usage dashboard.

**Honest scope statement:** the deep pillars (two-way sync, 3-way merge, provisioning agent, the §9
adapter matrix) remain roadmap. The 0.1.0 release makes the *foundation* deployable: governed Copilot
access, enterprise-grade auth, site connections, read-only chat/agent tools over connected sites, and
a complete operability/support story. That is a coherent, shippable slice — not a façade over
unimplemented promises.

## 5. The requested diagnostics capability (gap → design)

`main` records usage but has **no error capture, no anonymization, and no export**. The 0.1.0
design (ADR-0018) closes this with a **local-first, consent-explicit pipeline**:

- **Capture**: command/chat/tool usage counters and error reports are recorded *locally only*;
  nothing is ever transmitted by the extension.
- **Anonymize at capture time**: salted short-hashes for hostnames/tenants, identifiers stripped from
  messages and stack traces (paths reduced to extension-relative), JWT/bearer/email/GUID scrubbing.
- **Export under user control**: an explicit command builds the bundle (JSON + human-readable
  Markdown), shows a **full preview**, runs a **leak scan** (defense in depth — export refuses to
  write if any secret-shaped content survives), then saves where the user chooses, for hand-off
  through whatever channel the enterprise permits.
- **Rotatable pseudonym**: a random installation ID (never `machineId`) correlates reports from the
  same install; one command rotates it and the hash salt.

## 6. Post-build code-review findings (0.1.0 branch)

An independent multi-angle review pass over the 0.1.0 diff produced 18 candidates. Fixed in
this release: leak-scan patterns tightened to stay a superset of the redaction layer (bearer
length, `access_token`/`sig`/`code` keys); site overview's lists+pages reads parallelized; a
fragile duplicate pre-flight `countTokens` (an unguarded failure point) removed from
*Ask Copilot*; usage figures unified on `BudgetGuard` verdicts with a single clock read per
report; dead code removed (`anonUrlHost`, unused `copilot.blocked` error code).

**Accepted follow-ups** (real but non-blocking; tracked for 0.2):

| # | Finding | Why deferred |
|---|---|---|
| R1 | Per-call MSAL `PublicClientApplication` construction and per-request token acquisition (multiple keychain IPC round-trips per overview) → memoize providers per cache handle, reuse tokens until expiry | Perf only; correctness unaffected; touches the auth core, wants real-tenant testing |
| R2 | Short-TTL cache for chat/tool site context (repeat questions re-fetch identical data) | Matches planned ADR-0011 cache framework — build once, there |
| R3 | Telemetry/state writes per event → debounced flush | Bounded blobs today; revisit with usage data |
| R4 | Dashboard re-renders whole webview per meter event while visible → postMessage incremental update | Visual churn only during bursts |
| R5 | `recent` ledger tail is persisted but unread → drop field (with migration) | Touches persisted-state shape; do deliberately with a migration test |
| R6 | Shared single source for the SharePoint host-suffix pattern + MSAL `toAccessToken`/silent-acquire helpers + a `confirmModal` helper (5 near-duplicates each) | Mechanical dedup, no behavior change |
| R7 | `setBudget` / export snapshot re-embed setting keys & defaults → route through `readBudgetConfigFromSettings` | Drift risk documented; values currently consistent |

## 7. Residual risks / explicitly out of scope for 0.1.0

- Sync/merge/provisioning pillars (PLAN §7–§8 write paths) — roadmap, clearly labeled in docs.
- Live billing API read (ADR-0003 auto-numerator) — the local estimator ships first; the REST
  numerator remains future work.
- The local MCP server surface (ADR-0017) — LM tools ship now; the stdio MCP mirror is next.
- Proxy nuances: VS Code's patched `fetch` honors `http.proxy` in current builds; classic PAC edge
  cases are documented in the admin guide rather than re-implemented.
- The multiplier table is a maintained estimate; values drift as GitHub changes pricing. Mitigated by
  user-overridable table + "estimate" labeling everywhere.
