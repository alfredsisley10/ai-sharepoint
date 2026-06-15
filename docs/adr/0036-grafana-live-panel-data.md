# ADR-0036: Grafana live panel data (lifting the ADR-0033 deferral)

- **Status:** Accepted (2026-06-15)
- **Context:** ADR-0033 shipped the Grafana connector reading dashboard/folder
  search, alert state, annotations, and datasources — but deliberately deferred
  **executing panel queries** (`/api/ds/query`), so item fetch returned a
  panel's title/type only, never the **data it shows**. Pilots want the
  assistant to read the live values (current p95 latency, error rate, capacity)
  the way a human reads the panel.

## Decision

1. **New `panel` query type** (`{"type":"panel","query":"<dashboard uid or
   title>","panel":"<id or title>","from":"now-24h"}`). It resolves the
   dashboard (by uid, falling back to a title search), reads the selected
   panel(s), and runs **the panel's own native targets** through
   `POST /api/ds/query`.
2. **Datasource-type agnostic by pass-through.** The per-datasource query model
   (PromQL `expr`, SQL `rawSql`, Graphite `target`, …) is **not** parsed — the
   panel's target objects are sent as-is, with the resolved `datasource`
   (target's own, else the panel's), a `refId`, and `maxDataPoints`. Targets
   that are hidden or have no concrete datasource uid (default/mixed/expression)
   are skipped — they can't run without `datasources:read`.
3. **Frames summarized, not dumped.** The response data frames are reduced to
   compact text — per non-time field, `last/min/max/n` for numeric series (or
   the last value for tables) with series labels — bounded by panel/frame/line
   caps so a multi-series panel stays chat-sized.
4. **Resilient:** a panel that can't run (text/row, default datasource, a denied
   query) degrades to a noted hit rather than failing the whole read; per-refId
   datasource errors are surfaced inline.
5. **Transport:** the shared `fetchJson` gained an optional `{method, body}` so
   the POST reuses the existing auth/timeout/wire-log/status rails (a
   backward-compatible addition — every existing GET caller is unchanged).
6. Dashboard item fetch now lists each panel's **id**, and points the model at
   the `panel` query for live data.

## Consequences

- The assistant can now read what a panel actually shows. Still strictly
  read-only — `/api/ds/query` executes the panel's *read* query against the
  datasource; nothing is written.
- Needs the token to hold **`datasources:query`** for the datasources the
  dashboard uses (Viewers typically can query datasources behind dashboards
  they can see; otherwise the panel hit notes the denial).
- The data-frame shape has variants across datasource plugins and Grafana
  versions; the summarizer is defensive about field/value presence, but this
  path warrants live validation across a few datasource types (Prometheus, a
  SQL source, Loki) — shipped behind the standard lockout/cache/caps rails.
