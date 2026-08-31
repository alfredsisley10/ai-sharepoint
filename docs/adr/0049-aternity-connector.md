# ADR-0049: Riverbed Aternity connector (read-only)

- **Status:** Accepted (2026-08-31)
- **Context:** §9.2 deferral register ("Aternity (EUEM)"). Pilots want chat
  to answer "which devices are unhealthy?", "is Outlook slow for everyone
  or just this user?", and "what health events fired today?" — from
  Riverbed Aternity, the end-user-experience monitoring platform, whose
  public integration surface is the Aternity REST API: an **OData**
  service at `https://<account>-odata.aternity.com/aternity.odata/latest/
  <TABLE>`.

## Decision

1. **New `aternity` source type** over the OData REST API. Setup derives
   both endpoints from whatever the user has — the dashboard URL
   (`<account>.aternity.com`), the OData URL
   (`<account>-odata.aternity.com`), or an on-prem host (used for both
   roles). The descriptor stores
   `<api origin>?web=<dashboard base>&table=<default table>`.
2. **Auth is Basic or a pasted OAuth bearer token** — no new auth method.
   Basic (the documented OData path: an Aternity account holding the
   "OData REST API" role, ACLs apply) and `pat` (a bearer access token
   from a Riverbed/Aternity OAuth client) both already ride the shared
   `fetchJson` (lockout protection, caps, caching, wire logging,
   secret-free export/import).
3. **Query shapes** (same contract style as ServiceNow/Splunk Obs): a
   bare table name reads recent rows; JSON
   `{"table", "filter", "select", "top", "timeframe"}` targets one
   precisely — `filter` is a native OData `$filter`, `timeframe` is
   Aternity's custom `relative_time(...)` argument (`last_24_hours`,
   `last_7_days`, …) composed into `$filter`, and the ADR-0012 result cap
   always rides as `$top`. There is **no free-text search** in the OData
   API, so non-table free text is refused with guidance instead of being
   mangled into a query. Rows have no stable single-row address → no item
   fetch (search results carry the rows). Browse enumerates the account's
   readable tables from the **OData service document**, falling back to a
   curated set (health events, applications/devices daily, business
   activities, resource hourlies) when the catalog read is denied.
4. **Verification read (ADR-0009):** one `$top=1` row of the default
   table when configured (confirms auth AND table readability), else the
   service document — the smallest read every OData-role account can run.

## Consequences

- Strictly read-only by construction: only GET endpoints are called, and
  the OData service exposes no mutations.
- Table/column names differ per Aternity version and license; the live
  service document (Browse & Bookmark) is the source of truth, the
  curated list only a fallback — so no schema is hardcoded into queries.
- Needs live-instance validation (per the §9.2 register: table naming
  across versions, `relative_time` acceptance on non-timeseries tables) —
  shipped behind the standard lockout/cache/caps rails so pilot feedback
  can tune it safely.
