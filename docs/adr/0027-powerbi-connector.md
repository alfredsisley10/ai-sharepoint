# ADR-0027: Power BI (cloud) connector

- **Status:** Accepted (2026-06-11)
- **Context:** Pilots want to "connect and analyze data from Power BI"
  alongside the other reference sources.

## Decision

1. **A reference source type `powerbi`** (PLAN §9 framework: lockout
   breaker, TTL cache, caps, aliases). The base URL is fixed
   (`api.powerbi.com/v1.0/myorg`); an optional `?dataset=` default lets
   chat run bare DAX without a JSON spec.
2. **No new credential — reuse Microsoft 365 SSO.** Power BI is the
   same AAD as SharePoint, so the source's auth method is **`aad-sso`**:
   the keychain entry stores only `{providerId, cacheHandle}` pointing
   at a connected site's MSAL provider; tokens are acquired per call
   through an **AadTokenBroker** injected into the ContextService
   (delegated scopes `Workspace.Read.All` + `Dataset.Read.All` on the
   `analysis.windows.net/powerbi/api` audience — read-only). Background
   reads are silent-only; interactive consent happens at verify, like
   site connections.
3. **Analysis = read-only DAX** via `executeQueries` (a read-only API):
   chat/bookmark queries are `{"dataset": "<id or name>", "dax":
   "EVALUATE …"}` — dataset resolvable by **name** against the visible
   inventory (typo → error listing what IS visible). A `daxIssue` gate
   requires `EVALUATE`/`DEFINE` and bounds query size; results are
   row-capped like every source.
4. **Browse & Bookmark** lists every visible dataset (My workspace +
   up to 50 group workspaces) with a starter `EVALUATE INFO.TABLES()`
   bookmark each — the model's entry point for discovering a dataset's
   tables before writing real DAX.

## Consequences

- Zero credential management for users already signed into a site; the
  Power BI license/permission model (Pro/PPU, workspace roles, RLS via
  effective identity) is enforced server-side as usual.
- executeQueries has service limits (rows/values per query) — the
  row caps keep responses inside them for reference use.
- Report rendering/export and push datasets are out of scope (read-only
  posture); XMLA endpoints are not used (Premium-only).
