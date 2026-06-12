# ADR-0030: ER model by join-rate probing

- **Status:** Accepted (2026-06-12); amended 2026-06-12 (adaptive sizing);
  amended 2026-06-12 (AI-assisted candidates, probe report, data-quality
  tier); amended 2026-06-12 (user-defined joins from chat); amended
  2026-06-12 (scoped runs, AI hints, known joins in the wizard); amended
  2026-06-12 (measurement-first sweeps); amended 2026-06-12 (escalation
  ladder: casts, failed-pair retries, large tables)
- **Amendment (escalation ladder):** zero joins despite the sweep means
  the PROBES themselves can fail invisibly — SQL Server's legacy
  ntext/text cannot be compared with `=` at all (common in AD exports),
  and cross-typed keys (int ↔ varchar) never pair under the family
  gate. Runs now escalate through passes: native probes → **cast pass**
  (failed/zero-sample pairs RETRIED comparing both sides as a common
  text type — NVARCHAR(MAX)/::text/CHAR/$toString — plus a cross-type
  sweep over key-shaped columns) → **large-table pass** (tables beyond
  the size cap included with strictly bounded samples, cheapest pairs
  first). Between passes the user is ASKED before escalating —
  incremental and deliberate — and the new **Maximum** mode runs every
  pass automatically. Cast-measured relationships are flagged (`cast`)
  everywhere, and the tool output tells the model to CAST both sides
  when writing such joins. `sysname` joined the textual family.
- **Amendment (measurement-first sweeps):** a 3-table AD export
  (users / groups / group-association) produced zero joins: name
  heuristics cannot bridge `member_dn` → `distinguishedName`, and the
  exhaustive sweep excluded tables with UNKNOWN row estimates — fresh
  exports often carry no statistics, so "Thorough" tested nothing.
  Corrections: (1) unknown-size tables are SWEEP-ELIGIBLE (sampled
  probes bound the cost; only tables KNOWN to exceed the size cap are
  excluded); (2) scopes of ≤12 tables are swept exhaustively in EVERY
  mode — "probe all plausible column pairs, measure the join rates,
  verify" is the method when nothing else is known about a database;
  (3) the AI prompt teaches junction-table reasoning and the common
  key domains (ids, GUIDs, SIDs, LDAP DNs, UPNs, emails) so
  cross-named references are proposed even on large scopes.
- **Amendment (scoped/guided runs):** the wizard scopes and seeds the
  run. (1) **Table scoping** — an optional prefix/keyword filter
  PRE-SELECTS tables (shared prefixes usually mean a shared objective),
  then a searchable multi-select refines the set; candidates, exhaustive
  pairs, and the AI prompt all operate on the scoped catalog. Persisting
  MERGES: re-probed pairs take the new measurement, relationships outside
  the scope survive from earlier runs (`mergeRelationships`), so a
  100-table database is mapped neighborhood by neighborhood. (2) **AI
  hint** — a free-text description of the data ("SAP FI tables; MANDT is
  the client key everywhere") is weighted into the join-hypothesis
  prompt and persisted on the model to seed re-runs. (3) **Known joins**
  — semicolon-separated joins (SQL or bare equality) are parsed, probed
  FIRST (priority 6), and kept even below the automatic thresholds
  (verdict "defined"), identical to chat's test_join semantics.
- **Amendment (user-defined joins):** the ER model is refinable
  incrementally from chat. `test_join` parses a supplied join (SQL
  syntax with aliases, or `table.column = table.column`), resolves it
  against the catalog, returns the stored relationship when the pair is
  already in the model, and otherwise probes the live join rate (both
  directions, adaptive sample from the model's row estimates).
  `save=true` — gated by the chat tool-confirmation UI — persists it via
  `upsertRelationship` (replace-by-pair, rate-ordered). User-defined
  joins persist with verdict **"defined"** even when they measure below
  the automatic thresholds (the user asserted them; the measured rates
  stay visible so data-quality stories remain tellable), and
  cross-type-family joins are allowed with an implicit-cast warning
  rather than rejected.
- **Amendment (AI + report):** a pilot run probed 800 pairs and confirmed
  nothing, with no way to see why. Three additions: (1) **probe report** —
  every tested pair persists with its measured rates and outcome (capped),
  the view shows outcome counts + the closest misses, and a systemic
  warning fires when most probes sampled zero values (a sampling/permission
  problem, not absent relationships); the zero-result toast leads with the
  best measured rate. (2) **AI-assisted candidates** — Copilot proposes
  join hypotheses from the indexed names/types/tags/content summaries
  (validated against the catalog: hallucinated tables/columns and
  join-incompatible types are dropped; proposals probe first), and when a
  run confirms little, ONE refinement round shows Copilot the measured
  near-miss rates and probes its revised hypotheses (consent posture of
  ADR-0024: names/tags/summaries to Copilot, never row data). (3)
  **Data-quality tier** — a 98–99% join classifies as a designed join whose
  unmatched remainder is flagged as a likely upstream data-quality issue
  (orphaned keys), not a different relationship.
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
