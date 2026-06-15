# ADR-0031: Workspace export of context-search results

- **Status:** Accepted (2026-06-12)
- **Context:** Chat search results are deliberately capped (rows,
  excerpt lengths) — right for model context budgets, wrong when the
  user wants the data itself. Pilot: "the tool caps the total dataset
  returned to chat (mostly a good thing), but users still need access
  to larger datasets — export directly to a file in the workspace so
  Copilot never needs to see that large context."

## Decision

1. **Files are the channel for datasets.** `Export Context Search
   Results to File…` (command, source context menu) and the
   `export_context_results` tool run the SAME read-only query shapes as
   search — SELECT/Mongo spec/CQL/JQL/SPL/free text — but with export
   bounds (up to 50,000 rows, 120s) and write EVERY result to
   `ai-sharepoint-exports/` in the workspace: CSV for tabular results
   (RFC-4180, header = union of row keys), JSON for MongoDB documents.
2. **The model sees the path, never the payload.** The tool returns
   only the file path and row count, and its contract tells the model
   not to read the file back into context unless the user asks about a
   small slice. Raw DB values go straight to the file (full values, not
   the 120-char chat truncation).
3. **Human gate + read-only invariants unchanged.** The tool sits
   behind VS Code's confirmation (query + destination shown); the SQL
   read-only guard, row cap, and timeout still bound the read. The
   SQL Server cost guard (ADR-0030) is bypassed *by that explicit
   approval* — an export IS the accepted bulk read. SQL Server stops
   the wire stream at the row cap (`connection.cancel()`), so a 50k
   export of a 12M-row table doesn't drain the table.
4. **Fresh and uncached:** exports never come from, or populate, the
   TTL result cache.

## Consequences

- Large analyses move to the right tool (Excel, pandas, the editor)
  while chat stays within context budgets.
- Exported files contain enterprise data **in the workspace** — they
  live under a clearly-named folder the user can gitignore; nothing is
  exported without the per-run confirmation naming the destination.
- The 50k/120s bounds are constants for now; a settings seam can come
  with demand.
