# ADR-0011 — Read-through caching of reference data with TTL

- Status: Accepted
- Date: 2026-06-10

## Context
Reference reads (Splunk searches, SQL queries, Jira JQL, Graph calls) can be slow and can load the
source systems. The same data is often read repeatedly within a work session, so unconditional
round-trips are wasteful and potentially impactful.

## Decision
Provide a **read-through cache with a configurable default TTL** in the framework (ADR-0008).

- Default TTL (e.g. 15 minutes), with **per-source and per-bookmark overrides**.
- Cache key = source + resolved query/locator (+ relevant params).
- **Manual refresh / invalidate** available per entry and per source; a read can opt to bypass cache.
- Cache is stored in local workspace storage and is **excluded from Git** (never committed); it is part
  of the local, non-exported state (PLAN §10 export emits config only).

## Consequences
- Fewer round trips → faster agent objectives and lower load on production reference systems
  (complements the read-safe query policy, ADR-0012).
- Staleness is bounded by TTL and overridable by manual refresh; the UI shows entry age.
- Cached reference data may be sensitive — it stays local, out of Git, and out of any export; if needed
  we can encrypt at rest in a later iteration.
