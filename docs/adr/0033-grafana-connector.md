# ADR-0033: Grafana connector (read-only)

- **Status:** Accepted (2026-06-12)
- **Context:** §9.2 deferral register. Grafana is the front door to
  most observability estates — pilots want chat to find dashboards,
  read current alert state, and recall annotations (deploys/incidents)
  from Grafana Cloud stacks and self-hosted instances.

## Decision

1. **New `grafana` source type** against the instance the user already
   opens in a browser (`https://<stack>.grafana.net` → cloud,
   anything else → datacenter). No URL derivation needed — the REST API
   lives under the same origin (`/api/...`), via the shared `fetchJson`
   rails.
2. **Auth: service-account token first** (Bearer, the `pat` method —
   created under Administration → Service accounts, Viewer role
   suffices), with basic auth as the self-hosted fallback.
3. **Query shapes:** plain text searches dashboards
   (`/api/search?type=dash-db`); JSON `{"type": "dashboard|folder|
   alert|annotation|datasource", "query", "limit", "folderUid"}`
   targets one kind. `alert` reads unified-alerting **rule state** from
   the Viewer-readable Prometheus-compatible endpoint
   (`/api/prometheus/grafana/api/v1/rules`) and flattens groups to
   `state: name` hits; annotations and datasources are listed and
   filtered locally (datasource 403s explain the admin-only
   permission instead of failing opaquely). Dashboard hits carry
   `dashboard:<uid>`; item fetch returns the dashboard's description
   and panel inventory — not the full JSON model, which would blow the
   context budget.
4. **Verification read (ADR-0009):** `/api/search?limit=1` — the
   smallest call every Viewer-grade token can make; org name is a
   best-effort label.
5. **Datasource query execution (`/api/ds/query`) is out of scope for
   v1**: payloads are per-datasource-type (PromQL/LogQL/SQL/…), so a
   bounded design of its own — discovery/state reads ship first.

## Consequences

- Strictly read-only by construction: only GET endpoints are called.
- Grafana RBAC applies: a Viewer token sees dashboards/alerts/
  annotations; datasource listings may legitimately be denied.
- Needs live-instance validation (Cloud vs self-hosted version skew on
  the alerting endpoints) — shipped behind the standard
  lockout/cache/caps rails.
