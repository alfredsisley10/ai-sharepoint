# ADR-0012 — Non-impacting / read-safe query policy

- Status: Accepted
- Date: 2026-06-10

## Context
Reference sources are often production systems. Our reads must minimize any impact — no blocking locks,
no unbounded scans, no runaway queries. The requirement explicitly includes using `WITH (NOLOCK)` on
SQL Server where possible.

## Decision
Each adapter declares and enforces a **read-safe query policy**; the framework (ADR-0008) applies
common limits.

- **Microsoft SQL Server:** `WITH (NOLOCK)` table hints where possible **plus** `SET TRANSACTION
  ISOLATION LEVEL READ UNCOMMITTED`, connection `ApplicationIntent=ReadOnly`, mandatory `TOP`/row caps,
  and query timeouts. (NOLOCK reduces locking impact; we accept its dirty-read trade-off as appropriate
  for reference/context reads.)
- **Splunk:** bounded time ranges, result/row caps, prefer saved searches, time out long searches.
- **Databricks:** read-only SQL on a SQL warehouse with row caps (Delta MVCC means no lock hint
  needed).
- **Oracle / PostgreSQL / MySQL / MongoDB:** these are **MVCC** engines, so readers don't block writers
  and no `NOLOCK`-equivalent is needed. Instead enforce a **read-only session/transaction** (PG
  `default_transaction_read_only`, Oracle read-only session, MySQL read-only session, Mongo
  `readPreference=secondary` + read-only user) plus row caps (`FETCH FIRST` / `LIMIT` / `.limit()`) and
  statement timeouts (`statement_timeout` / `max_execution_time` / `maxTimeMS`).
- **Atlassian / Graph / Aternity / Splunk REST:** page with limits, cap result counts, time out.
- **Universal floors:** every read has a result-size cap and a timeout; results flow through the TTL
  cache (ADR-0011) to avoid repeat round-trips.

## Consequences
- Minimal contention/load on production reference systems.
- NOLOCK's dirty-read semantics are acceptable here because the data is advisory context, not a source
  of truth we mutate; where an adapter can't guarantee a non-impacting read, it caps and times out.
- Policies are per-adapter and testable; new adapters must declare their read-safety rules.
