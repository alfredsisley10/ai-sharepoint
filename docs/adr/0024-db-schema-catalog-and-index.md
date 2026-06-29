# ADR-0024: Database schema catalog + AI semantic index

- **Status:** Accepted (2026-06-11)
- **Note (numbering):** this ADR existed only in code references for a period —
  the decision shipped (`schemaIndex.ts`, `schemaStore.ts`, `schemaIndexer.ts`,
  the `db_schema` / `index_db_schema` tools) and the source consistently cites
  "ADR-0024", but the record file was missing. It is reconstructed here from the
  shipped behavior so the ADR log matches the code.
- **Context:** Database reference sources (ADR-0022) let users search a SQL
  Server / PostgreSQL / MySQL / MongoDB source, but raw connection access is not
  enough for the assistant to write *good* queries: it needs to know what tables
  and columns exist and what they MEAN. Dumping row data to the model is
  off-limits (read-safety + privacy), so the model must be grounded on
  **metadata only**.

## Decision

1. **Catalog from introspection, never from rows.** `describeDb` reads the
   server's own metadata (information_schema / catalog views / collection
   sampling) into a `SourceSchema`: tables/collections, columns, types, and
   nullability. No row data is read to build the catalog.
2. **Local, per-source persistence.** `SchemaStore` writes one JSON file per
   source under global storage, so the catalog survives restarts and is
   inspectable. It is non-secret configuration (names and types only).
3. **Consent-gated AI semantic index.** `SchemaIndexer` can, behind an explicit
   consent modal, ask Copilot (metered `copilot.ask`, batched, partial-tolerant)
   to tag each table/column with a short semantic description + tags. Only
   **names, types, tags, and small distinct-value samples** are sent to the model
   — never bulk row data — and the per-column distinct values are computed
   locally. The `aiSharePoint.context.allowSchemaIndexing` policy setting (machine
   scope) lets an org disable this entirely.
4. **Model exposure.** The `db_schema` tool returns the catalog (and the ER model
   from ADR-0030 when present); `index_db_schema` builds/refreshes the semantic
   index (confirmation-gated). Both ride the standard lockout/caps machinery.
5. **Sharing.** The catalog + index travel with reference-config export/import,
   so a teammate inherits the grounding without re-indexing.

## Consequences

- The assistant writes column- and type-aware queries against unfamiliar
  schemas without ever seeing customer rows during indexing.
- Indexing has a Copilot cost, so it is explicit, batched, and tolerant of
  partial completion; an org can switch it off centrally.
- The catalog/index are descriptors (names, types, AI summaries) — they appear
  in exports and are governed by the same redaction posture as other metadata.
- This catalog is the substrate the ER-probing pass (ADR-0030) builds on:
  schema indexing says what columns *mean*; ER probing says what they *join to*.
