# ADR-0032: Splunk Observability Cloud connector (read-only)

- **Status:** Accepted (2026-06-12)
- **Context:** §9.2 deferral register ("SignalFx"). Pilots want chat to
  answer "what's alerting right now?", find the right detector or
  dashboard, and look up metric/dimension metadata — from Splunk
  Observability Cloud (the former SignalFx), which is a separate
  product/API from Splunk Enterprise (ADR-0029).

## Decision

1. **New `splunkobs` source type** over the v2 REST API at
   `https://api.<realm>.signalfx.com`. Setup derives both API and app
   endpoints from whatever the user has — the app URL
   (`app.<realm>.signalfx.com`, including the
   `observability.splunk.com` domains) or just the realm ("us1"). The
   descriptor stores `api…?web=<app base>&type=<default object type>`.
2. **Access-token auth via a new `sfx-token` method**: the API wants
   the token in the `X-SF-TOKEN` header, not `Authorization` — wired
   centrally in `authHeaders` so the shared `fetchJson` (wire logging,
   status taxonomy, response caps) is reused; the header is masked in
   wire logs by the existing secret-key filter ("token").
3. **Query shapes** (same contract style as Splunk/ServiceNow): plain
   text searches the source's configured default object type; JSON
   `{"type": "metric|dimension|detector|dashboard|incident", "query",
   "limit"}` targets one explicitly. Metric/dimension words become
   `name:*word*` contains-queries (raw `field:value` passes through);
   incidents are fetched active-only and filtered locally. Detector and
   dashboard hits carry `detector:<id>` / `dashboard:<id>` for item
   fetch (description, SignalFlow program text, chart count). Browse
   lists dashboards + detectors plus a standing "active incidents"
   candidate.
4. **Verification read (ADR-0009):** the smallest metric-metadata query
   (`/v2/metric?query=*&limit=1`) — the one read every API-scoped token
   can run; the org name is a best-effort label on top.
5. **SignalFlow execution is out of scope for v1.** Running programs
   (`/v2/signalflow/execute`) streams computed timeseries and needs its
   own bounded design; metadata/state reads cover the discovery and
   triage questions pilots asked for.

## Consequences

- Strictly read-only by construction: only GET endpoints are called.
- Org access tokens are org-wide (no per-user identity) — verification
  reports the org name, and tenant RBAC applies to what the token may
  read.
- Needs live-instance validation (realm probing, incident payload
  variants) — shipped behind the standard lockout/cache/caps rails so
  pilot feedback can tune it safely.
