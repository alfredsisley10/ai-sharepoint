# ADR-0028: ServiceNow connector (read-only Table API)

- **Status:** Accepted (2026-06-11)
- **Context:** ServiceNow headlined the deferred §9.2 adapter list, and the
  pilot's vocabulary (CMDB, ownership fields) is ServiceNow-shaped. The
  framework seam is proven by nine adapters.

## Decision

1. **A reference source type `servicenow`** over the standard **Table
   API** (`/api/now/table/…`) — the one API surface that reaches
   incidents, changes, problems, catalog items, CMDB CIs, knowledge, and
   custom `u_*` tables uniformly. Strictly read-only: the adapter ships
   GET requests only.
2. **Auth = Basic (integration/service account) or OAuth bearer token**,
   both through the shared `fetchJson` — so keychain storage, the
   ADR-0009 lockout breaker, caps/caching, and verbose wire logging apply
   without new code. Instance ACLs remain the authority on visibility.
3. **Three query shapes**, mirroring how users actually talk to
   ServiceNow:
   - free text → zing **text-index search** (`123TEXTQUERY321=`) on the
     source's default table (`?table=` on the descriptor, `incident` if
     unset);
   - a native **encoded query** (`active=true^priority=1`) against the
     default table;
   - JSON `{"table", "query", "fields", "limit"}` for anything else.
   Item fetch is `table/sys_id`; results use `sysparm_display_value` so
   reference fields read as names, with row caps and field trimming.
4. **Browse & Bookmark** offers a curated starter set (incident, change,
   problem, request items, `cmdb_ci`/`cmdb_ci_appl`, knowledge, users,
   groups, plus the configured default table) as recently-updated
   queries — no admin-only schema reads (`sys_db_object`) required.

## Consequences

- Works against any instance domain (standard or custom) with whatever
  least-privilege account the org provisions; lockout protection keeps
  integration accounts safe from freeze policies.
- Record URLs use the classic `nav_to.do` deep link, which redirects
  correctly on Polaris/Next Experience instances.
- Aggregate/Stats APIs, attachments, and write operations are out of
  scope (read-only posture); the semantic schema indexing of ADR-0024
  could later extend to ServiceNow table dictionaries if asked for.
