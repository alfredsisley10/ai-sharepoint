# ADR-0030: Cost-gated SQL Server queries (catalog-stat preflight + bounded subsets)

- **Status:** Accepted (2026-06-12)
- **Context:** Pilot ER-diagram discovery ran free-form aggregates
  (`COUNT(*)`, `DISTINCT`, `GROUP BY`, unindexed `WHERE`) over
  multi-million-row SQL Server tables; several died at the 30s request
  timeout — and the error read "connection failed", sending people to
  the network. Discovery should be smart: estimate the size of a table
  first, check whether the predicate columns are indexed, estimate the
  query's cost, and when it would be very expensive, test against a
  smaller, performant subset instead.

## Decision

1. **Preflight from catalog stats, never from data.** Before a SQL
   Server statement runs, one cheap metadata query (`sys.objects` /
   `sys.partitions` / `sys.indexes` / `sys.index_columns`) reads the
   referenced tables' approximate row counts and their indexes' leading
   key columns. Table names are extracted from the statement's
   FROM/JOIN clauses (including `FROM a, b` comma lists), validated to
   plain identifiers (injection-safe), and probed in one round trip
   capped at 15s.
2. **Pure, conservative cost estimate** (`queryCost.ts`, unit-tested):
   a statement is *expensive* when it touches a table at/above 500k
   rows and cannot avoid scanning it — aggregates / `DISTINCT` /
   `GROUP BY` / `ORDER BY` / an unindexed or absent `WHERE`. A `WHERE`
   on a leading index column counts as seekable; a bare `TOP n`
   (n ≤ 10k, no sort/dedup/aggregate) is cheap since the scan stops
   early.
3. **Expensive → bounded subset, clearly labeled.** The statement is
   rewritten so each big table is read through
   `(SELECT TOP 10000 * FROM t) AS t` (small tables keep full data) and
   the first result hit states it is a sample — with per-table catalog
   sizes — so neither the user nor the model mistakes sample aggregates
   for totals. Statements we cannot rewrite confidently (CTEs, derived
   tables, APPLY/PIVOT, comma-list big tables) are declined fast with
   the same sizing guidance instead of burning the timeout.
4. **Explicit override, fail-open guard.** `allowExpensive=true` (tool
   input / service option) runs the original statement — the model may
   set it ONLY after the user accepts a slow scan. Any preflight
   failure (catalog permissions, exotic names, probe timeout) disables
   the guard for that statement: behavior degrades to exactly the old
   path.
5. **Timeouts tell the truth:** a query that exceeds the request
   timeout now maps to "query timed out" with remediation (indexed
   WHERE / TOP / the guard), not "connection failed".

## Consequences

- "How big is X?" is answered from the catalog (the guard's notes
  include `≈rows` per table) — models stop issuing `COUNT(*)` scans for
  sizing.
- Sampled results are *approximate by construction*; the label and tool
  description force that disclosure into the conversation.
- The probe adds one sub-second metadata round trip to SQL Server
  searches; PostgreSQL/MySQL keep their existing behavior (server-side
  timeouts) until the seam is extended.
- Catalog row counts come from `sys.partitions` (approximate but
  current); logins lacking metadata visibility simply skip the guard.
