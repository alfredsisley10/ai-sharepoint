/**
 * Table-level statistics for the schema viewer (pure).
 *
 * The catalog answers "what columns exist"; it does not answer the questions a
 * person actually asks when they open a database they don't know: how big is
 * this, and is anyone still writing to it? Those two facts decide whether a
 * table is worth indexing, worth joining, or dead weight — and neither is
 * derivable from names and types.
 *
 * Three of the four figures are cheap and exact-ish:
 *   - COLUMNS come from the database, not from the catalog. The catalog caps
 *     columns per table, so counting its entries would under-report a wide
 *     table and quietly turn a cap into a wrong number.
 *   - ROWS come from catalog STATISTICS, never `COUNT(*)` — sizing a
 *     billion-row warehouse costs the same as a lookup table. They are
 *     approximate by construction and are labelled as such.
 *   - BYTES come from the engine's own allocation accounting, including
 *     indexes, because "how much disk does this cost" is the question being
 *     asked.
 *
 * The fourth — LAST UPDATED — has no honest single answer, so this module is
 * deliberate about it. Engines mostly don't record when a table's DATA last
 * changed; what they record is when its DEFINITION changed, which is a
 * different fact and must never be shown as if it were the same one. So
 * recency is derived from the data: pick the column most likely to mean "when
 * this row was last touched", take its maximum, and always report WHICH column
 * the answer came from. A number whose basis is visible can be judged; a bare
 * timestamp cannot.
 *
 * Pure: builds SQL and interprets rows. No I/O, no clock.
 */

import { TableDef, SchemaCatalog, qualifiedName } from "./schemaIndex";

export type SqlStatsEngine = "mssql" | "postgres" | "mysql";

/** Measured facts about one table. Every field is optional because every
 *  source of them can be denied by permissions, and a partial answer beats
 *  failing the whole pass. */
export interface TableStats {
  /** True column count from the database — NOT the possibly-capped catalog. */
  columns?: number;
  /** Approximate row count from catalog statistics. */
  rows?: number;
  /** Bytes on disk including indexes. */
  bytes?: number;
  /** Best-effort "data last changed", as an ISO string. */
  lastUpdated?: string;
  /** How `lastUpdated` was obtained — e.g. `MAX(lst_upd_dt)`. Shown wherever
   *  the timestamp is, so nobody has to trust it blind. */
  lastUpdatedBasis?: string;
  /** When the table DEFINITION last changed. A different fact from
   *  `lastUpdated`, kept separate so the two are never conflated. */
  schemaModified?: string;
  /** Why there is no `lastUpdated`, when there isn't one. */
  recencyNote?: string;
}

/** Stats for a whole source, keyed by lowercase qualified table name. */
export interface TableStatsIndex {
  measuredAt: string;
  tables: Record<string, TableStats>;
  /** True once the (per-table, more expensive) recency probe has run. */
  recencyProbed?: boolean;
  /** Tables whose recency probe failed or timed out — surfaced rather than
   *  silently leaving a blank cell. */
  recencyFailed?: string[];
}

// --- sizing: ONE query per database -----------------------------------------

/**
 * Row counts, byte sizes, true column counts and definition dates for every
 * table — one query, from catalog statistics.
 *
 * Columns returned (lowercased by the parser): `table_schema`, `table_name`,
 * `row_estimate`, `bytes`, `column_count`, and optionally `schema_modified` /
 * `engine_updated`.
 */
export function buildCatalogStatsSql(engine: SqlStatsEngine): string {
  switch (engine) {
    case "mssql":
      // Correlated subqueries rather than one GROUP BY: rows must come from the
      // heap/clustered partitions only (index_id 0/1) or every nonclustered
      // index would multiply the count, while SIZE must come from ALL
      // allocation units or indexes wouldn't be counted. Two different filters,
      // so two different aggregates.
      return (
        "SELECT s.name AS table_schema, t.name AS table_name, " +
        "(SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS row_estimate, " +
        "(SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p2 JOIN sys.allocation_units a ON a.container_id = p2.hobt_id WHERE p2.object_id = t.object_id) AS bytes, " +
        "(SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = t.object_id) AS column_count, " +
        "t.modify_date AS schema_modified " +
        "FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id"
      );
    case "postgres":
      return (
        "SELECT n.nspname AS table_schema, c.relname AS table_name, " +
        "GREATEST(c.reltuples, 0)::bigint AS row_estimate, " +
        "pg_total_relation_size(c.oid) AS bytes, " +
        "(SELECT COUNT(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS column_count " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE c.relkind IN ('r','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema')"
      );
    case "mysql":
      // MySQL is the one engine that records a data-modification time itself.
      // It is unreliable (InnoDB resets it on restart, and it is NULL for
      // partitioned tables), so it is carried as a SEPARATE column and only
      // preferred over a probe when present.
      return (
        "SELECT t.table_schema, t.table_name, t.table_rows AS row_estimate, " +
        "(t.data_length + t.index_length) AS bytes, " +
        "(SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count, " +
        "t.update_time AS engine_updated " +
        "FROM information_schema.tables t " +
        "WHERE t.table_type = 'BASE TABLE' AND t.table_schema = DATABASE()"
      );
  }
}

/** Engine casing varies (Postgres lowercases, SQL Server preserves), so every
 *  lookup tries all three forms. */
function val(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Dates arrive as Date objects from some drivers and strings from others. */
export function isoDate(v: unknown): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(String(v));
  const t = d.getTime();
  if (!Number.isFinite(t) || t <= 0) return undefined;
  return d.toISOString();
}

/** Statistics rows → stats keyed by lowercase qualified name. */
export function parseCatalogStats(rows: Array<Record<string, unknown>>): Record<string, TableStats> {
  const out: Record<string, TableStats> = {};
  for (const r of rows) {
    const name = val(r, "table_name");
    if (!name) continue;
    const schema = val(r, "table_schema");
    const key = `${schema ? `${String(schema)}.` : ""}${String(name)}`.toLowerCase();
    const engineUpdated = isoDate(val(r, "engine_updated"));
    out[key] = {
      ...(num(val(r, "column_count")) !== undefined ? { columns: num(val(r, "column_count")) } : {}),
      ...(num(val(r, "row_estimate")) !== undefined ? { rows: num(val(r, "row_estimate")) } : {}),
      ...(num(val(r, "bytes")) !== undefined ? { bytes: num(val(r, "bytes")) } : {}),
      ...(isoDate(val(r, "schema_modified")) ? { schemaModified: isoDate(val(r, "schema_modified"))! } : {}),
      // The engine's own answer, when it has one, needs no probe.
      ...(engineUpdated
        ? { lastUpdated: engineUpdated, lastUpdatedBasis: "engine metadata (information_schema.update_time)" }
        : {}),
    };
  }
  return out;
}

// --- recency: which column means "when was this row last touched" ------------

/** Types whose maximum is a meaningful point in time. `time` is excluded on
 *  purpose: a time-of-day has no date, so its maximum says nothing. */
const DATE_TYPE_RE =
  /^(date|datetime|datetime2|smalldatetime|datetimeoffset|timestamp|timestamptz|timestamp with(out)? time zone)$/;

/** Name tokens that mean "this row changed". */
const MODIFIED_TOKENS = new Set([
  "updated", "update", "upd", "updt",
  "modified", "modify", "mod", "modif",
  "changed", "change", "chg", "chng", "chgd",
  "edited", "edit", "revised", "touched", "amended",
]);

/** Name tokens that mean "this row appeared" — a weaker but real signal of
 *  activity, used only when nothing better exists. */
const CREATED_TOKENS = new Set([
  "created", "create", "creat", "crt", "cre",
  "inserted", "insert", "ins",
  "added", "add", "entered", "logged", "recorded",
]);

/** Generic date words. Alone they mean only "this is a date column". */
const DATE_TOKENS = new Set(["date", "dt", "time", "timestamp", "ts", "stamp", "on", "at", "when"]);

/**
 * Tokens that make a date column a BUSINESS date rather than a row-audit date.
 * `MAX(due_date)` tells you about future obligations, not about whether anyone
 * still writes to the table — reporting it as "last updated" would be worse
 * than reporting nothing, so these are rejected outright.
 */
const BUSINESS_TOKENS = new Set([
  "due", "expiry", "expires", "expire", "expiration", "exp",
  "effective", "eff", "birth", "dob", "hire", "hired",
  "start", "begin", "begins", "end", "ends", "valid",
  "scheduled", "schedule", "target", "deadline", "maturity", "renewal",
  "termination", "terminate", "cancel", "cancelled",
  "ship", "shipped", "delivery", "delivered", "invoice", "invoiced",
  "payment", "paid", "billing", "billed", "settle", "settled",
  "approval", "approved", "review", "reviewed", "publish", "published",
  "archive", "archived", "purge", "purged", "retention", "retain",
  "next", "planned", "forecast", "estimated", "eta",
]);

/** Split an identifier into comparable tokens: `lst_upd_dt` → [lst, upd, dt],
 *  `LastModifiedDate` → [last, modified, date], `sys_updated_on` → [sys,
 *  updated, on]. Token matching rather than substring matching, because
 *  "mod" is inside "model" and "ins" is inside "instance". */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => (/^\d+$/.test(part) ? [] : [part.toLowerCase()]))
    .filter(Boolean);
}

/** Normalized type name — strips precision (`datetime2(7)` → `datetime2`). */
function baseType(dataType: string | undefined): string {
  return (dataType ?? "").toLowerCase().replace(/\s*\(.*$/, "").trim();
}

export interface RecencyColumn {
  column: string;
  /** What the column's maximum actually means. */
  kind: "modified" | "created" | "generic";
  score: number;
}

/**
 * The column whose maximum best approximates "when this table last changed",
 * or `undefined` when no column can honestly answer that.
 *
 * Preference order is deliberate: a modification stamp beats a creation stamp
 * (a table can be heavily updated without gaining rows), a creation stamp
 * beats a bare `date` column, and a business date is not an answer at all.
 * Ties break toward the earlier column, which keeps the choice stable across
 * runs so the reported basis doesn't wander.
 */
export function pickRecencyColumn(table: TableDef): RecencyColumn | undefined {
  let best: RecencyColumn | undefined;
  for (const c of table.columns) {
    const type = baseType(c.dataType);
    // Mongo reports unions like "date|null"; accept when any member is a date.
    const isDate = type.split("|").some((t) => DATE_TYPE_RE.test(t.trim()));
    if (!isDate) continue;
    const tokens = nameTokens(c.name);
    if (tokens.some((t) => BUSINESS_TOKENS.has(t))) continue;
    const modified = tokens.some((t) => MODIFIED_TOKENS.has(t));
    const created = tokens.some((t) => CREATED_TOKENS.has(t));
    const generic = tokens.some((t) => DATE_TOKENS.has(t));
    let score: number;
    let kind: RecencyColumn["kind"];
    if (modified) {
      score = 100;
      kind = "modified";
    } else if (created) {
      score = 60;
      kind = "created";
    } else if (generic) {
      score = 30;
      kind = "generic";
    } else {
      continue; // a date column whose name says nothing — too weak to claim
    }
    if (tokens.includes("last") || tokens.includes("lst") || tokens.includes("recent")) score += 10;
    // A datetime pins the moment; a bare `date` only the day.
    if (type !== "date") score += 5;
    if (!best || score > best.score) best = { column: c.name, kind, score };
  }
  return best;
}

/** Why a table has no recency answer — shown instead of an empty cell. */
export function recencyNoteFor(table: TableDef): string {
  const dateCols = table.columns.filter((c) =>
    baseType(c.dataType).split("|").some((t) => DATE_TYPE_RE.test(t.trim())),
  );
  if (dateCols.length === 0) return "no date column";
  return `no audit-date column (${dateCols
    .slice(0, 3)
    .map((c) => c.name)
    .join(", ")} look like business dates)`;
}

// --- probing the chosen column ----------------------------------------------

/**
 * Quote an identifier for `engine`, escaping the closing delimiter by doubling
 * it — the standard escape in all three dialects.
 *
 * These names come from the database's own catalog rather than from a user,
 * but they are still interpolated into SQL, and "the source is trusted" is
 * exactly the assumption that ages badly. Escaping costs nothing.
 */
export function quoteIdent(engine: SqlStatsEngine, name: string): string {
  switch (engine) {
    case "mssql":
      return `[${name.replace(/]/g, "]]")}]`;
    case "mysql":
      return `\`${name.replace(/`/g, "``")}\``;
    case "postgres":
      return `"${name.replace(/"/g, '""')}"`;
  }
}

/**
 * `SELECT MAX(<col>)` for one table.
 *
 * Cheap when the column is indexed (an index seek to the end) and a full scan
 * when it isn't, which is why the caller runs this under the normal read
 * timeout and treats a timeout as "unknown" rather than as a failure of the
 * whole pass.
 */
export function buildMaxDateSql(engine: SqlStatsEngine, table: TableDef, column: string): string {
  const q = (n: string) => quoteIdent(engine, n);
  const target = table.schema ? `${q(table.schema)}.${q(table.name)}` : q(table.name);
  return `SELECT MAX(${q(column)}) AS last_updated FROM ${target}`;
}

/** Read the single value a MAX query returns. */
export function parseMaxDate(rows: Array<Record<string, unknown>>): string | undefined {
  return isoDate(val(rows[0] ?? {}, "last_updated"));
}

// --- formatting --------------------------------------------------------------

/** Bytes → the unit a person would use. Megabytes and gigabytes for anything
 *  substantial, smaller units below that so a 12 KB lookup table doesn't read
 *  as "0.0 MB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(2)} TB`;
}

/** Row counts with thousands separators; `—` when unknown. */
export function formatRows(rows: number | undefined): string {
  return rows === undefined ? "—" : rows.toLocaleString("en-US");
}

/** Date → `2026-07-30` (the time of day is noise at this zoom level). */
export function formatDay(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

/** Whole-catalog totals for the viewer's header. Rows and bytes are summed
 *  only over tables that reported them, and `partial` says so — a total that
 *  silently omits half the database is worse than one that admits it. */
export function summarizeStats(
  catalog: SchemaCatalog,
  stats: TableStatsIndex | undefined,
): { tables: number; columns: number; rows?: number; bytes?: number; partial: boolean; columnsExact: boolean } {
  let columns = 0;
  let columnsExact = true;
  let rows: number | undefined;
  let bytes: number | undefined;
  let covered = 0;
  for (const t of catalog.tables) {
    const s = stats?.tables[qualifiedName(t).toLowerCase()];
    // Prefer the database's own column count; fall back to the catalog's,
    // which the column cap may have shortened.
    if (s?.columns !== undefined) columns += s.columns;
    else {
      columns += t.columns.length;
      columnsExact = false;
    }
    if (!s) continue;
    covered += 1;
    if (s.rows !== undefined) rows = (rows ?? 0) + s.rows;
    if (s.bytes !== undefined) bytes = (bytes ?? 0) + s.bytes;
  }
  return {
    tables: catalog.tables.length,
    columns,
    ...(rows !== undefined ? { rows } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    partial: covered < catalog.tables.length,
    columnsExact,
  };
}

/** One-line stats summary for a table heading. */
export function describeTableStats(s: TableStats | undefined, fallbackColumns: number): string {
  const bits = [`${s?.columns ?? fallbackColumns} columns`];
  if (s?.rows !== undefined) bits.push(`≈ ${formatRows(s.rows)} rows`);
  if (s?.bytes !== undefined) bits.push(formatBytes(s.bytes));
  if (s?.lastUpdated) bits.push(`last updated ${formatDay(s.lastUpdated)}`);
  return bits.join(" · ");
}
