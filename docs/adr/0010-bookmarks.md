# ADR-0010 — Bookmarks: reusable, non-secret pointers to source elements

- Status: Accepted
- Date: 2026-06-10

## Context
Users want to save and re-reference specific elements of a read-only source — e.g. a Jira saved filter
/ JSM queue / a queue for a specific person, a `server/db/schema/table` or a named SQL query, a Splunk
saved search, a Databricks `catalog.schema.table`, an Intune policy. Re-locating these by hand every
time is slow.

## Decision
Add **bookmarks**: named, persistent pointers managed by the framework (ADR-0008).

- A bookmark stores `{ sourceId, type, locator, label }` — **locators only, no secrets** (credentials
  stay in the keychain, §6).
- Bookmarks are surfaced in the Reference Sources view and are **callable by name by the agent**, so an
  objective can say "compare against the *Product Owners* Jira queue" or "read the *current-prices* SQL
  query."
- Bookmark results flow through the TTL cache (ADR-0011) and the read-safe query policy (ADR-0012) like
  any other read.
- Bookmarks are **scoped to a workspace** (PLAN §10) and travel in workspace export — as locators only,
  never secrets.

## Consequences
- Fast reuse of high-value reference points across sessions.
- Because bookmarks are secret-free locators, they are safe to persist in config and to share via
  workspace export.
- Each source type defines its own locator shape; the framework treats locators opaquely except when an
  adapter resolves one.
