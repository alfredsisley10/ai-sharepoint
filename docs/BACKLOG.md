# Product backlog — candidate work not yet scheduled

> **Purpose.** This file holds **shovel-ready feature candidates** that have been agreed in
> principle but not yet cut into a track in [`ROADMAP_STATE.md`](./ROADMAP_STATE.md). Each item is
> written to be pickable: the problem, the proposed behavior, the code it touches, and the bar it
> has to clear. When an item is picked up it graduates to an **ADR** (design rationale, next free
> number — `docs/adr/`) and a **track** in `ROADMAP_STATE.md` (execution checkboxes); the entry
> here then links to both. Nothing here is a commitment or a shipped feature.
>
> Conventions inherited from the rest of the repo: pure-JS only in production deps (ADR-0016),
> reference/context sources are strictly read-only (ADR-0012), secrets live in the OS keychain and
> never in exports/logs (ADR-0013, §6), and the AI surface never writes unattended (every write is
> preview-then-confirm).

---

## BL-1 — One-generation white-labeling: rebranded builds cannot themselves rebrand

**Area:** `src/branding/` · rebrand / white-label workflow · [`REBRANDING.md`](../REBRANDING.md)

### What problem would this solve?

The Rebrand / White-label workflow (command `aiSharePoint.rebrandExtension`, flow in
`src/branding/rebrandFlow.ts` / `rebrandVsix.ts`, documented in `REBRANDING.md`) currently produces
outputs — a rebranded `.vsix`, **minimal build components**, and a **full anonymized source tree** —
that each **carry a working copy of the rebrand engine, re-pointed at the new brand**. That is by
design today: `src/branding/originBrand.ts::rebrandOriginModule` regenerates the `ORIGIN_BRAND`
tokens so "the exported copy's own rebrand engine targets its new brand," keeping a green test suite
in the child.

The consequence is that a **downstream (rebranded) instance can itself generate further
rebrands/white-labels**, and so on without limit. The desired policy is **one generation**: the
**parent / origin** instance can mint rebrands, but a **rebranded instance must not be able to
continue the chain**.

### Proposed behavior

- Rebrand outputs ship **without** the rebrand/white-label capability:
  - **Rebranded `.vsix`** — omit the `aiSharePoint.rebrandExtension` command, its palette/menu
    entries, the Support & Diagnostics "Rebrand / White-label…" affordance, the associated NLS
    strings, and the bundled branding-engine code from the packaged bundle/manifest.
  - **Minimal build components** — exclude the branding-engine modules and the whitelabel
    scaffolding that would let the component set repackage a further rebrand.
  - **Full source** — exclude `src/branding/` (rebrand engine, flow, VSIX transform, export
    scaffold, `originBrand`) **and its tests** from the exported tree, plus the manifest
    command/menu wiring for the command. `REBRANDING.md` and the origin `.github` are already
    dropped from exports (per `REBRANDING.md`); extend that same "origin-coupled files removed"
    pass to the engine itself. The exported tree must still **compile and keep a green suite** with
    those modules and tests removed.
- The **origin / parent** build is unchanged and retains the full rebrand capability.
- Net effect: white-labeling becomes **terminal** — a rebranded copy is a normal product build with
  no self-rebrand surface.

### Affected areas (starting points)

- `src/branding/rebrandVsix.ts` — VSIX transform: strip the command + engine from the packaged
  manifest and bundle.
- `src/branding/exportScaffold.ts` and the full-source export path — exclude branding modules/tests
  from the emitted tree.
- `src/branding/rebrandFlow.ts` — the produce / where-to-put UX (its wording implies the copy can be
  maintained and re-shipped; clarify it is terminal).
- `src/branding/originBrand.ts` — no longer regenerate an engine for the child (the child has no
  engine to re-point).
- `package.json` / `package.nls.json` — conditional command + menu registration.
- Tests — drop/adjust branding tests **in the exported tree only**; keep the origin's branding tests
  green.
- Docs — `REBRANDING.md`, `docs/USER_GUIDE.md`, `docs/ADMIN_GUIDE.md`, `CHANGELOG.md`.

### Acceptance criteria

- A rebranded `.vsix` installed in VS Code exposes **no** rebrand command, menu item, or Support
  affordance.
- The full-source export contains **no** `src/branding/` rebrand engine and **no** path to
  regenerate one; `npm ci && npm run compile && npm test` is green in the exported tree.
- The minimal-components export cannot repackage a further rebrand.
- The origin build still rebrands **exactly as before**.
- All existing invariants still hold: native-free (`check:native`, ADR-0016), secret-free export
  (ADR-0013), and `check:vsix` packaging assertions.

### Open questions

- **Hard removal vs. origin-controlled toggle.** The request reads as a hard, one-generation
  removal — default to that. A later "allow exactly one more generation" flag the origin can opt
  into per export is a possible follow-up, not part of v1.
- **Extension-identity guidance.** `REBRANDING.md` already warns the extension ID is permanent;
  removing the engine doesn't change that, but the "maintain a white-labeled copy from scratch"
  section needs to state the copy is terminal (no further rebrands).

### References

`REBRANDING.md`; `src/branding/*`; command `aiSharePoint.rebrandExtension`; ADR-0013 (secret-free
export/import). **New ADR to be authored** (next free number — `0048` is currently the highest ADR on
disk).

---

## BL-2 — Generic REST/API + MCP reference-source connector (OpenAPI import/detection)

**Area:** `src/context/adapters/` · Pillar 6 read-only context framework · PLAN §9.1–§9.2

### What problem would this solve?

The §9.2 adapter matrix covers many *named* systems (Confluence, Jira, ServiceNow, Splunk, GitHub,
databases, …), but any **generic REST/HTTP API** — or an **MCP server** — that lacks a bespoke
adapter can't be added as a read-only reference source. Users want to point the assistant at an
arbitrary API endpoint (and at external MCP servers) and query it through the same framework every
other source uses: `search_context` / `get_context_item`, result caps, TTL cache, lockout-safe
verify, bookmarks, alias/description, and secret-free export/import.

> **Distinction (important).** This is the extension acting as an **API consumer / MCP client** — a
> *new inbound reference-source adapter* on the ADR-0008 framework. It is **not** ADR-0017, which is
> the extension exposing **its own** capabilities as a *local MCP server*. The two are complementary;
> this item is strictly the inbound/consumer side.

### Proposed behavior

- New source type(s) on the ADR-0008 framework in `src/context/adapters/`:
  - **`api`** — a generic REST/HTTP reference source.
  - **`mcp`** — an external MCP server consumed as a read-only reference source.
- **Generic API (OpenAPI-driven):**
  - On add, **import an OpenAPI / Swagger spec** (by URL or file) or **auto-detect** it where
    possible — probe common discovery locations (`/openapi.json`, `/openapi.yaml`, `/swagger.json`,
    `/v3/api-docs`, `/.well-known/…`) — then present the spec's operations / paths / parameters as
    the queryable surface.
  - **Read-only by construction:** only safe (GET-shaped) operations are offered; write verbs
    (POST/PUT/PATCH/DELETE) are filtered out — the ADR-0012 read-safety policy extended to HTTP
    methods.
  - **Query shapes:** pick an operation + parameters, or a free-form GET path within the configured
    base URL. Responses are capped/paged (ADR-0012) and cached (ADR-0011). Spec operations are
    browse-to-bookmark (ADR-0010).
  - **Auth** on the standard-user-first rails (ADR-0014): public/none, API key (header or query),
    Bearer token, Basic, OAuth2 client-credentials — **keychain only**, verify-on-connect with a
    single lockout-safe read (ADR-0009).
- **MCP client:**
  - Connect to an external MCP server (local **stdio**, and/or **streamable HTTP**) as a read-only
    source; enumerate its **resources** and **tools**, and surface resource reads + safe tool calls
    through `search_context` / `get_context_item`, capped and confirmation-gated as appropriate.
  - Local-only secret handling; pure-JS transport (no native deps, ADR-0016).
- **Full framework parity:** alias + description (ADR-0023), reference-config export/import
  (secret-free, ADR-0013), layered wire-log redaction, and projects scoping.

### Affected areas (starting points)

- `src/context/types.ts` — new source-type descriptors + fields (base URL, spec reference, detected
  operations, MCP transport/endpoint).
- `src/context/adapters/genericApi.ts` and `src/context/adapters/mcpClient.ts` — **new** adapters.
- A **pure-JS** OpenAPI parser/normalizer (JSON + YAML, no native deps) — OpenAPI 2.0 (Swagger) and
  3.0/3.1.
- `src/context/http.ts` (reuse the shared fetch wrapper) + a read-safe **HTTP-method** policy.
- `src/context/contextService.ts` — dispatch for the new types.
- `src/context/sourcesStore.ts` — persisted descriptor fields.
- Add-source wizard in `src/extension.ts`; `package.json` / `package.nls.json` manifest + tool
  strings.
- Docs — PLAN §9.2 matrix row(s), `docs/USER_GUIDE.md`, `docs/ADMIN_GUIDE.md` (endpoint allowlist +
  OpenAPI discovery), a new ADR.
- Tests — stubbed-`fetch` adapter tests + OpenAPI spec fixtures (v2 and v3) + read-safety
  (write-verb rejection) assertions.

### Acceptance criteria

- A user can add a generic API source by supplying a base URL; the connector **detects or imports**
  its OpenAPI spec and lists the **read** operations available to query.
- Only safe/read (GET) operations are ever callable; write verbs are never offered — test-locked.
- An external **MCP server** can be added and its resources/read tools surfaced through the standard
  search/get tools.
- Caps, cache, lockout-safe verify, alias, bookmarks, and secret-free export/import all behave as for
  existing adapters.
- Native-free gate (ADR-0016) and secret-in-keychain-only invariants hold.

### Open questions

- **Spec coverage & edge cases.** OpenAPI 2.0 vs 3.0/3.1; specs that declare only write endpoints
  (nothing to offer read-only); how to represent path/query params in a **bookmarkable locator**.
- **MCP transport scope for v1.** stdio-only, or stdio + streamable HTTP? Are external MCP tool
  calls with side effects ever permitted? Default: read/resource-only + explicit confirmation,
  mirroring the read-only AI-surface invariant.
- **SSRF / endpoint allowlist.** User-supplied base URLs need an allowlist / guard consistent with
  the existing connector allowlist settings (ADMIN_GUIDE).

### References

PLAN §9.1 (shared framework services), §9.2 (adapter matrix); ADR-0008–0012 (framework, backoff,
bookmarks, cache, read-safe queries), ADR-0014/0015 (standard-user auth + discovery), ADR-0016
(pure-JS), ADR-0023 (alias/description). **Contrast:** ADR-0017 (local MCP **server** — the extension
as provider — is *out of scope* for this item). **New ADR to be authored** (next free number).

---

## BL-3 — White-label bake-in defects found by audit (pre-existing, not allowlist-related)

**Area:** `src/branding/` · rebrand / white-label wizard · [`REBRANDING.md`](../REBRANDING.md)

### What problem would this solve?

A multi-agent audit of the white-label bake path (run while adding the integration allowlist, 2026-07)
confirmed several defects that are **independent of the allowlist** and predate it. They are recorded
here rather than fixed inline, because each changes bake behavior a release engineer depends on and
deserves its own change + test. Each was verified by reading the code, and adversarially re-verified.

| # | Defect | Where | Severity |
|---|---|---|---|
| 1 | **A telemetry-only bake-in is silently discarded.** `hasProvisioning` tests only `settings \|\| connectors \|\| projects \|\| help` — but `buildProvisioningManifest` emits a fifth section, `telemetry`. Configure *only* telemetry endpoints in the wizard and the `provisioning` block is never baked into any output mode, nor saved to the profile. | `src/branding/rebrandFlow.ts` (the `hasProvisioning` gate) | **High** |
| 2 | **`gatherProvisioning` never populates `content.settings`.** It is the only one of the five sections with no wizard step *and* no `else if (seed?.…)` carry-through, so a release profile's `provisioning.settings` is dropped on every re-release — the "repeatable release" promise silently loses setting defaults. | `src/branding/rebrandFlow.ts` (`gatherProvisioning`) | Medium |
| 3 | **Release-profile round-trip loses `identity.renameIdentifiers`.** It is written into the saved profile but never read back, so a "Reuse profile" re-release silently reverts to the cosmetic rename depth unless the engineer re-picks it. (`identity.iconPath` is likewise declared but never saved or applied.) | `src/branding/rebrandFlow.ts` (depth quick-pick) · `releaseProfile.ts` | Medium |
| 4 | **Minimal-components `.vscodeignore` omits the scaffold files that same function adds** (`MAINTAINING.md`, `.github/**`, `.gitignore`), so re-packaging the handoff does not reproduce the same VSIX entry set. | `src/branding/rebrandVsix.ts` (`BUILD_VSCODEIGNORE`) | Low |
| 5 | **`get_context_item`'s model-facing description omits `splunkobs` and `grafana`**, which *do* support item fetch (`getSplunkObsItem` / `getGrafanaItem`). The model is never told it can pull a Grafana dashboard or a Splunk Observability detector by id, so a working capability goes unused. Opposite polarity to the others: it under-claims what the code supports. | `package.json` (`aisharepoint_get_context_item` `modelDescription`) | Low |

### Acceptance criteria

- Derive the "is there anything to bake?" gate from the manifest itself rather than a hand-listed
  subset, so a **sixth** section can't repeat defect #1; test-lock a telemetry-only bake.
- A profile round-trip preserves every field it stores (settings, rename depth) — test-locked, in the
  spirit of the existing `parseReleaseProfile` round-trip test.
- `minimalBuildComponents`' ignore list is derived from (or asserted against) what it actually emits.
- The tool description matches the dispatch table in `contextService.getItem`.

### References

Audit run 2026-07-26 over `src/branding/*` + the add/import/provisioning paths; the allowlist-related
findings from the same audit were fixed in the integration-allowlist change and are **not** listed here.
