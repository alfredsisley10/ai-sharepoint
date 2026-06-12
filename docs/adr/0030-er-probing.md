# ADR-0030: ER model by join-rate probing

- **Status:** Accepted (2026-06-12); amended 2026-06-12 (adaptive sizing)
- **Amendment (2026-06-12):** the fixed 40-candidate × 100-value plan was
  arbitrary. The run is now sized by the database itself: a SIZING PASS
  reads approximate row counts from catalog statistics (never COUNT(*)),
  the candidate budget scales with tables/columns (40…300), pairs where
  BOTH tables are small (≤50k rows) get **complete join tests** instead
  of samples, larger targets start with row-count-sized samples
  (100–500), and each pair **escalates ×5 toward completeness while
  probes answer fast** (<1.5s), stopping at 10k values, full coverage,
  or the first non-fast probe. Sensitivity dominates: a slow probe
  (≥5s) pauses the run to give the database air, and three consecutive
  slow/failed probes de-escalate the rest of the run to minimal
  samples. A **Thorough mode** additionally tests every type-compatible
  column pair across the small tables (the completeness preference),
  capped and cancellable. Relationships verified by complete joins are
  flagged (`complete`) in the model, the view, and the tool output.
- **Context:** Enterprise databases routinely ship with no declared
  foreign keys, so users (and the assistant) cannot know which columns
  join to which — multi-table questions produce wrong or inefficient
  queries. Schema indexing (ADR-0024) says what columns MEAN; nothing
  says what they JOIN to.

## Decision

1. **"Build Database ER Diagram"** establishes relationships
   EMPIRICALLY. Candidate column pairs come from the indexed schema and
   semantic/content index (in priority order: FK-shaped names like
   `customer_id` → table `Customers`; identical non-generic column
   names; identifier-tagged columns sharing a second semantic tag —
   this is where ADR-0024's schema/content indexing feeds the ER pass).
   Type families must match (numbers↔numbers, text↔text; dates/bools
   never). Candidates capped (40) and deduped.
2. **Join-rate probing, both directions.** Per candidate, sample up to
   100 DISTINCT non-null values from one side and count how many EXIST
   on the other — then the reverse. Only match COUNTS leave the
   database; no row data. ≈100% match (≥95%) = "strong" (a designed-in
   relationship); ≥70% best-direction = "likely"; below = coincidence,
   discarded. Measuring BOTH directions captures the inner-vs-outer
   consequence: full containment one way with partial the other marks
   an intentional SUBSET, and the persisted note says which side needs
   a LEFT JOIN to keep unmatched rows.
3. **Consent + caps**: an explicit modal states the query count
   (≈2×candidates bounded count-queries) before anything runs; probing
   is cancellable, per-pair failures degrade to a PARTIAL model, and
   every query rides the standard lockout/caps machinery.
4. **Persistence & use**: the ER model is stored on the SourceSchema
   (`er`), so it survives restarts, travels with **reference-config
   exports** (teammates inherit the relationships without re-probing),
   renders in *View Database Schema & Semantic Index* as a **Mermaid
   `erDiagram`** plus a rate table, and is appended to every `db_schema`
   tool answer — the model writes correct multi-table JOINs and honors
   the subset notes when choosing INNER vs LEFT.

## Consequences

- Relationship discovery works on databases with zero declared
  constraints — the common enterprise case — at a bounded, user-visible
  query cost.
- Rates are sample-based indicators, not proofs: the view labels them
  as probed rates, and the thresholds deliberately leave room for
  partially-populated relationships (the user's "we don't expect 100%
  always" requirement).
- MongoDB is covered via `$lookup` aggregation; SQL engines via
  per-dialect DISTINCT-sample + EXISTS probes.
