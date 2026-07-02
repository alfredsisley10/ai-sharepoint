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

## Amendment (2026-07-01): SSO-friendly auth for standard users

The pilot needed users **without a service account or OAuth client** to connect
via their existing SSO. Beyond Basic and an OAuth bearer token, the connector now
also offers (see `docs/research/servicenow-sso-simplification.md` for the full
inbound-auth catalog and rationale):

- **`snow-oauth`** — OAuth authorization-code + PKCE over a loopback redirect;
  `oauth_auth.do` delegates login to the org SSO. Needs a one-time admin OAuth
  client (Application Registry, redirect `http://localhost:51725/callback`).
- **`snow-session`** — replay the user's signed-in browser session cookies. The
  zero-admin SSO path. The page CSRF token (`g_ck`/`X-UserToken`) is now
  fetched automatically from the cookies (`fetchSnowUserToken`, cached), so the
  user no longer pastes it, and a 14-min keep-alive read holds the ~30-min GUI
  session open while they work (best-effort, lockout-safe).
- **`snow-apikey`** — Inbound REST API Key in the `x-sn-apikey` header; the key
  is tied to a ServiceNow user, so that user's ACLs apply. No OAuth client,
  password, or expiry.
- **`snow-oidc`** — a third-party OIDC/JWT ID token from the org IdP (Entra/Okta)
  sent as a Bearer token; the instance validates it against a registered OIDC
  provider and maps a claim to a user. The strategic SSO path (no ServiceNow
  credential); `exp` is decoded to fail fast on an expired paste.

All four ride the shared `fetchJson`, so lockout protection, caps/caching, and
secret-masked wire logging apply unchanged; secrets live only in the OS keychain.
